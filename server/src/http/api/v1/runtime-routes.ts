import express, { type Express, type Request, type Response } from 'express';
import { ok, withApiContext } from '../middleware/api-context.js';
import type { RuntimeCatalogEntry } from '../../../runtime/runtime-catalog.js';

/**
 * The catalogue the PTC Arcade Runtime fetches.
 *
 * Public and read-only, like the rest of the v1 catalogue. It names games that
 * already stream to any browser, so nothing here is disclosed that a player
 * could not already reach — but it is also the list the runtime will resolve a
 * launch against, which makes it the outer boundary of what a native emulator
 * can be pointed at.
 *
 * Served with a short cache: the runtime refetches every half hour anyway, and
 * a stale catalogue means a newly added cabinet is briefly unlaunchable
 * natively rather than wrong.
 */
export interface RuntimeRouteDependencies {
  catalog: () => { entries: readonly RuntimeCatalogEntry[]; omitted: ReadonlyArray<{ gameId: string; reason: string }> };
  log: (event: string, details: Record<string, unknown>) => void;
}

export function installRuntimeRoutes(app: Express, dependencies: RuntimeRouteDependencies): void {
  const router = express.Router();
  router.use(withApiContext);

  router.get('/catalog', (request: Request, response: Response) => {
    const { entries, omitted } = dependencies.catalog();
    if (omitted.length > 0) {
      // A GameCube cabinet the runtime cannot launch is a cabinet that works in
      // the browser and not natively, which is otherwise invisible from here.
      dependencies.log('runtime_catalog_omissions', { omitted });
    }
    response.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=1800');
    ok(request, response, {
      // The runtime's parser reads `games`; the surrounding envelope is the
      // ordinary v1 shape, so this stays readable with the rest of the API.
      games: entries.map((entry) => ({
        gameId: entry.gameId,
        platformId: entry.platformId,
        displayName: entry.displayName,
        fileName: entry.fileName,
        downloadUrl: entry.downloadUrl,
        sizeBytes: entry.sizeBytes,
        sha256: entry.sha256
      }))
    }, { count: entries.length });
  });

  app.use('/api/v1/runtime', router);
}
