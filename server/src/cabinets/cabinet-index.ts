import type { CabinetDefinition, Vector3Data } from '../../../shared/platform-contracts.js';

export interface CabinetIndexOptions { cellSize?: number }

/** Immutable lookup and 2D spatial indexes for registries much larger than the rendered scene. */
export class CabinetIndex {
  private readonly byId = new Map<string, CabinetDefinition>();
  private readonly byZone = new Map<string, CabinetDefinition[]>();
  private readonly byGame = new Map<string, CabinetDefinition[]>();
  private readonly byType = new Map<string, CabinetDefinition[]>();
  private readonly cells = new Map<string, CabinetDefinition[]>();
  readonly cellSize: number;

  constructor(definitions: readonly CabinetDefinition[], options: CabinetIndexOptions = {}) {
    this.cellSize = options.cellSize ?? 8;
    if (!Number.isFinite(this.cellSize) || this.cellSize <= 0) throw new Error('Cabinet spatial cell size must be positive.');
    for (const definition of definitions) {
      if (this.byId.has(definition.id)) throw new Error(`Duplicate cabinet ID: ${definition.id}`);
      this.byId.set(definition.id, definition);
      add(this.byZone, definition.zoneId, definition);
      add(this.byGame, definition.gameId, definition);
      add(this.byType, definition.cabinetType, definition);
      add(this.cells, this.cellKey(definition.interactionPosition.x, definition.interactionPosition.z), definition);
    }
  }

  get size(): number { return this.byId.size; }
  get(id: string): CabinetDefinition | undefined { return this.byId.get(id); }
  inZone(zoneId: string): readonly CabinetDefinition[] { return this.byZone.get(zoneId) ?? []; }
  forGame(gameId: string): readonly CabinetDefinition[] { return this.byGame.get(gameId) ?? []; }
  ofType(cabinetType: string): readonly CabinetDefinition[] { return this.byType.get(cabinetType) ?? []; }

  nearby(position: Pick<Vector3Data, 'x' | 'z'>, radius: number, zoneId?: string): CabinetDefinition[] {
    if (!Number.isFinite(radius) || radius < 0) return [];
    const minimumX = Math.floor((position.x - radius) / this.cellSize);
    const maximumX = Math.floor((position.x + radius) / this.cellSize);
    const minimumZ = Math.floor((position.z - radius) / this.cellSize);
    const maximumZ = Math.floor((position.z + radius) / this.cellSize);
    const radiusSquared = radius * radius;
    const matches: CabinetDefinition[] = [];
    for (let x = minimumX; x <= maximumX; x += 1) {
      for (let z = minimumZ; z <= maximumZ; z += 1) {
        for (const cabinet of this.cells.get(`${x}:${z}`) ?? []) {
          if (zoneId && cabinet.zoneId !== zoneId) continue;
          const dx = cabinet.interactionPosition.x - position.x;
          const dz = cabinet.interactionPosition.z - position.z;
          if (dx * dx + dz * dz <= radiusSquared) matches.push(cabinet);
        }
      }
    }
    return matches;
  }

  private cellKey(x: number, z: number): string {
    return `${Math.floor(x / this.cellSize)}:${Math.floor(z / this.cellSize)}`;
  }
}

function add(index: Map<string, CabinetDefinition[]>, key: string, value: CabinetDefinition): void {
  const values = index.get(key);
  if (values) values.push(value);
  else index.set(key, [value]);
}
