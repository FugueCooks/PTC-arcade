import type { CabinetIndex } from '../cabinets/cabinet-index.js';
import type { ZoneRegistry } from '../cabinets/zone-registry.js';
import type { GameRegistry } from '../games/game-registry-service.js';
import type { CabinetDefinition } from '../domain/cabinet-definition.js';
import type { GameDefinition } from '../domain/game-definition.js';
import type { ZoneDefinition } from '../cabinets/zone-registry.js';

/**
 * Milestone 11.34 — service boundaries.
 *
 * Route handlers and socket handlers delegate here; none of this logic lives in
 * a controller. Filtering and lookup are expressed once, so the HTTP API, the
 * socket layer, and the operations console cannot drift apart in what they
 * consider a valid query.
 */
export interface CabinetQuery {
  zoneId?: string;
  gameId?: string;
  cabinetType?: string;
  enabledOnly?: boolean;
}

export class CabinetCatalogService {
  constructor(private readonly index: CabinetIndex, private readonly zones: ZoneRegistry) {}

  get size(): number { return this.index.size; }

  /**
   * Narrows through the tightest available index before filtering. A query
   * naming a zone never walks the whole registry, which is what keeps this
   * usable at the scale Stage C established.
   */
  list(query: CabinetQuery = {}): readonly CabinetDefinition[] {
    let candidates: readonly CabinetDefinition[];
    if (query.zoneId !== undefined) candidates = this.index.forZone(query.zoneId);
    else if (query.gameId !== undefined) candidates = this.index.forGame(query.gameId);
    else if (query.cabinetType !== undefined) candidates = this.index.forType(query.cabinetType);
    else candidates = this.index.definitions;

    return candidates.filter((definition) =>
      (query.zoneId === undefined || definition.zoneId === query.zoneId)
      && (query.gameId === undefined || definition.gameId === query.gameId)
      && (query.cabinetType === undefined || definition.cabinetType === query.cabinetType)
      && (query.enabledOnly !== true || definition.enabled));
  }

  get(cabinetId: string): CabinetDefinition | undefined { return this.index.get(cabinetId); }

  listZones(): readonly ZoneDefinition[] { return this.zones.all(); }
  getZone(zoneId: string): ZoneDefinition | undefined { return this.zones.get(zoneId); }

  /** Zones a client at this position should load, for zone streaming. */
  activeZoneIds(x: number, z: number): readonly string[] { return this.zones.activeZoneIds(x, z); }
}

export interface GameQuery {
  platformId?: string;
  emulatorAdapterId?: string;
}

export class GameCatalogService {
  constructor(private registry: GameRegistry) {}

  /** Swapped wholesale by the operations registry-refresh action. */
  replaceRegistry(registry: GameRegistry): void { this.registry = registry; }

  get size(): number { return this.registry.size; }

  list(query: GameQuery = {}): readonly GameDefinition[] {
    let candidates: readonly GameDefinition[];
    if (query.platformId !== undefined) candidates = this.registry.forPlatform(query.platformId);
    else if (query.emulatorAdapterId !== undefined) candidates = this.registry.forAdapter(query.emulatorAdapterId);
    else candidates = this.registry.all();

    return candidates.filter((game) =>
      (query.platformId === undefined || game.platformId === query.platformId)
      && (query.emulatorAdapterId === undefined || game.emulatorAdapterId === query.emulatorAdapterId));
  }

  get(gameId: string): GameDefinition | undefined { return this.registry.get(gameId); }

  /** Resolution used by both the HTTP catalogue and the launcher. */
  forCabinet(cabinet: CabinetDefinition): GameDefinition | undefined {
    return cabinet.gameId === null ? undefined : this.registry.get(cabinet.gameId);
  }
}
