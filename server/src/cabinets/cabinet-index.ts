import type { CabinetDefinition } from '../domain/cabinet-definition.js';

/**
 * Milestone 11.13 — indexed lookup over the static cabinet registry.
 *
 * The pre-Phase-11 registry was a flat array of 39 entries, so every lookup was
 * a linear scan and nobody noticed. At the thousands of definitions this phase
 * targets, ordinary interaction must never scan the whole registry, so each
 * access pattern the platform actually uses gets its own map, built once at
 * load. Bucket arrays are frozen: callers receive them directly rather than a
 * defensive copy, which keeps a hot lookup allocation-free.
 */
export class CabinetIndex {
  private readonly byId: ReadonlyMap<string, CabinetDefinition>;
  private readonly byZone: ReadonlyMap<string, readonly CabinetDefinition[]>;
  private readonly byGame: ReadonlyMap<string, readonly CabinetDefinition[]>;
  private readonly byType: ReadonlyMap<string, readonly CabinetDefinition[]>;
  private readonly enabledIds: ReadonlySet<string>;
  readonly definitions: readonly CabinetDefinition[];

  constructor(definitions: readonly CabinetDefinition[]) {
    const byId = new Map<string, CabinetDefinition>();
    const byZone = new Map<string, CabinetDefinition[]>();
    const byGame = new Map<string, CabinetDefinition[]>();
    const byType = new Map<string, CabinetDefinition[]>();
    const enabledIds = new Set<string>();

    for (const definition of definitions) {
      if (byId.has(definition.id)) throw new Error(`Duplicate cabinet ID in index: ${definition.id}`);
      byId.set(definition.id, definition);
      push(byZone, definition.zoneId, definition);
      push(byType, definition.cabinetType, definition);
      if (definition.gameId !== null) push(byGame, definition.gameId, definition);
      if (definition.enabled) enabledIds.add(definition.id);
    }

    this.definitions = Object.freeze([...definitions]);
    this.byId = byId;
    this.byZone = freezeBuckets(byZone);
    this.byGame = freezeBuckets(byGame);
    this.byType = freezeBuckets(byType);
    this.enabledIds = enabledIds;
  }

  get size(): number { return this.byId.size; }
  get zoneCount(): number { return this.byZone.size; }

  /** O(1). */
  get(cabinetId: string): CabinetDefinition | undefined { return this.byId.get(cabinetId); }
  has(cabinetId: string): boolean { return this.byId.has(cabinetId); }
  isEnabled(cabinetId: string): boolean { return this.enabledIds.has(cabinetId); }

  /** O(1) lookup returning a frozen bucket; empty for an unknown key. */
  forZone(zoneId: string): readonly CabinetDefinition[] { return this.byZone.get(zoneId) ?? EMPTY; }
  forGame(gameId: string): readonly CabinetDefinition[] { return this.byGame.get(gameId) ?? EMPTY; }
  forType(cabinetType: string): readonly CabinetDefinition[] { return this.byType.get(cabinetType) ?? EMPTY; }

  zoneIds(): readonly string[] { return [...this.byZone.keys()]; }
}

const EMPTY: readonly CabinetDefinition[] = Object.freeze([]);

function push(map: Map<string, CabinetDefinition[]>, key: string, definition: CabinetDefinition): void {
  const bucket = map.get(key);
  if (bucket) bucket.push(definition);
  else map.set(key, [definition]);
}

function freezeBuckets(map: Map<string, CabinetDefinition[]>): ReadonlyMap<string, readonly CabinetDefinition[]> {
  for (const [key, bucket] of map) map.set(key, Object.freeze(bucket) as CabinetDefinition[]);
  return map;
}
