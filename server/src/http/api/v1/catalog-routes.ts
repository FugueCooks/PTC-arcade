import express, { type Express, type Request, type Response } from 'express';
import type { ServerConfig } from '../../../config.js';
import type { CabinetCatalogService, GameCatalogService } from '../../../services/catalog-service.js';
import {
  API_VERSION, apiErrorHandler, fail, ok, paginate, readPageRequest, withApiContext
} from '../middleware/api-context.js';
import {
  toCabinetDetailDto, toCabinetSummaryDto, toGameDetailDto, toGameSummaryDto, toZoneDto,
  type PlatformInfoDto
} from '../dto/catalog-dto.js';

/**
 * Milestone 11.30 — the versioned public catalogue.
 *
 * These are public read APIs: no authentication, no player data, no writes.
 * Handlers stay thin by design — they parse the request, call a service, and
 * map through a DTO, per Milestone 11.34's rule that business logic never lives
 * in a route handler.
 */
export interface CatalogRouteDependencies {
  cabinets: CabinetCatalogService;
  games: GameCatalogService;
  emulatorAdapters: () => ReadonlyArray<{ adapterId: string; platforms: readonly string[] }>;
  log: (event: string, details: Record<string, unknown>) => void;
  metrics?: { increment(name: string, amount?: number): void };
}

const CABINET_SORTS = ['id', 'displayName', 'zoneId'] as const;
const GAME_SORTS = ['id', 'displayName', 'platformId'] as const;

export function installCatalogRoutes(app: Express, config: ServerConfig, dependencies: CatalogRouteDependencies): void {
  const { cabinets, games, emulatorAdapters, log, metrics } = dependencies;
  const router = express.Router();
  router.use(withApiContext);
  router.use((_request, response, next) => {
    // Public, cacheable, and safe to share: nothing here varies by viewer.
    response.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    next();
  });

  router.get('/platform', (request: Request, response: Response) => {
    const data: PlatformInfoDto = {
      apiVersion: API_VERSION,
      deploymentVersion: config.softwareVersion,
      cabinetDefinitions: cabinets.size,
      gameDefinitions: games.size,
      zones: cabinets.listZones().length,
      emulatorAdapters: emulatorAdapters().map((adapter) => ({ id: adapter.adapterId, platforms: [...adapter.platforms] })),
      replaySupported: false
    };
    ok(request, response, data);
  });

  router.get('/cabinets', (request: Request, response: Response) => {
    metrics?.increment('api_cabinets_list_total');
    const page = readPageRequest(request, CABINET_SORTS);
    const filtered = cabinets.list({
      zoneId: stringQuery(request, 'zoneId'),
      gameId: stringQuery(request, 'gameId'),
      cabinetType: stringQuery(request, 'cabinetType'),
      enabledOnly: request.query.enabled === 'true'
    });
    const sorted = sortBy(filtered.map(toCabinetSummaryDto), page.sort ?? 'id', page.order);
    const { items, meta } = paginate(sorted, page);
    ok(request, response, items, meta);
  });

  router.get('/cabinets/:cabinetId', (request: Request, response: Response) => {
    const definition = cabinets.get(String(request.params.cabinetId));
    if (!definition) return fail(request, response, 'not-found', 'No such cabinet.');
    return ok(request, response, toCabinetDetailDto(definition));
  });

  router.get('/zones', (request: Request, response: Response) => {
    const page = readPageRequest(request, ['id']);
    const { items, meta } = paginate(cabinets.listZones().map(toZoneDto), page);
    ok(request, response, items, meta);
  });

  router.get('/zones/:zoneId', (request: Request, response: Response) => {
    const zone = cabinets.getZone(String(request.params.zoneId));
    if (!zone) return fail(request, response, 'not-found', 'No such zone.');
    return ok(request, response, toZoneDto(zone));
  });

  /** Zone streaming: which zones a client at this position should hold. */
  router.get('/world/active-zones', (request: Request, response: Response) => {
    const x = Number(request.query.x);
    const z = Number(request.query.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) {
      return fail(request, response, 'bad-request', 'x and z must be finite numbers.');
    }
    return ok(request, response, { x, z, zoneIds: cabinets.activeZoneIds(x, z) });
  });

  router.get('/games', (request: Request, response: Response) => {
    metrics?.increment('api_games_list_total');
    const page = readPageRequest(request, GAME_SORTS);
    const filtered = games.list({
      platformId: stringQuery(request, 'platformId'),
      emulatorAdapterId: stringQuery(request, 'emulatorAdapterId')
    });
    const sorted = sortBy(filtered.map(toGameSummaryDto), page.sort ?? 'id', page.order);
    const { items, meta } = paginate(sorted, page);
    ok(request, response, items, meta);
  });

  router.get('/games/:gameId', (request: Request, response: Response) => {
    const game = games.get(String(request.params.gameId));
    if (!game) return fail(request, response, 'not-found', 'No such game.');
    return ok(request, response, toGameDetailDto(game));
  });

  // No catch-all here: unmatched paths fall through to sibling /api/v1 routers
  // and finally to installApiNotFound, which the composition root installs last.
  router.use(apiErrorHandler(log));

  app.use('/api/v1', router);
}

/** Query values must be strings; an array (`?zoneId=a&zoneId=b`) is ignored. */
function stringQuery(request: Request, name: string): string | undefined {
  const value = request.query[name];
  return typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : undefined;
}

/** Sorts by a key already validated against the endpoint's allowed sort list. */
function sortBy<T extends { id: string }>(items: T[], key: string, order: 'asc' | 'desc'): T[] {
  const direction = order === 'desc' ? -1 : 1;
  return [...items].sort((left, right) => {
    const a = String((left as Record<string, unknown>)[key] ?? '');
    const b = String((right as Record<string, unknown>)[key] ?? '');
    return a.localeCompare(b) * direction;
  });
}
