import type { CabinetDefinition } from '../domain/cabinet-definition.js';

/**
 * Milestone 11.15 — spatial index for cabinet interaction and visibility.
 *
 * Structure: a 2D uniform grid (spatial hash) over the X/Z plane, keyed on each
 * cabinet's `interactionPosition`. The arcade is a single indoor floor — every
 * shipped cabinet sits at y ≈ 1.65 — so height carries no separating
 * information and a quadtree or octree would add depth without reducing the
 * candidate set. Cabinets are also roughly evenly spaced along walls, which is
 * the distribution a uniform grid handles best and the one that makes a tree's
 * adaptive subdivision pointless.
 *
 * Cell size defaults to 8 metres. Interaction range is 2.6 m, so a query's
 * bounding box (5.2 m across) spans at most two cells per axis: every nearby
 * lookup touches at most 4 buckets regardless of how many cabinets exist. At the
 * arcade's ~3–5 m spacing a bucket holds a handful of cabinets, which keeps the
 * scanned set small without making the grid itself large.
 *
 * Complexity: build O(n). Query O(k) where k is the number of cabinets in the
 * overlapping cells — independent of total registry size for a fixed radius and
 * density. Memory O(n + c) for c occupied cells; empty cells are never
 * allocated, so a sparse floor plan costs nothing for the space between rooms.
 */
export const DEFAULT_CELL_SIZE_METRES = 8;

export interface NearbyCabinet {
  definition: CabinetDefinition;
  /** Planar distance; Y is ignored because the arcade is a single floor. */
  distance: number;
}

export class CabinetSpatialIndex {
  private readonly cells = new Map<string, CabinetDefinition[]>();
  readonly cellSize: number;

  constructor(definitions: readonly CabinetDefinition[] = [], cellSize: number = DEFAULT_CELL_SIZE_METRES) {
    if (!Number.isFinite(cellSize) || cellSize <= 0) throw new Error('Spatial index cell size must be a positive number.');
    this.cellSize = cellSize;
    for (const definition of definitions) this.insert(definition);
  }

  insert(definition: CabinetDefinition): void {
    const key = this.#key(definition.interactionPosition.x, definition.interactionPosition.z);
    const bucket = this.cells.get(key);
    if (bucket) bucket.push(definition);
    else this.cells.set(key, [definition]);
  }

  get cellCount(): number { return this.cells.size; }

  /** Largest bucket, for benchmarking grid quality against a real floor plan. */
  get largestBucket(): number {
    let largest = 0;
    for (const bucket of this.cells.values()) largest = Math.max(largest, bucket.length);
    return largest;
  }

  /**
   * Cabinets within `radius` of a point, nearest first. Only the cells the query
   * box overlaps are visited, so this never scans the full registry.
   */
  queryRadius(x: number, z: number, radius: number): NearbyCabinet[] {
    const found: NearbyCabinet[] = [];
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(radius) || radius < 0) return found;
    const squaredRadius = radius * radius;
    const minCellX = Math.floor((x - radius) / this.cellSize);
    const maxCellX = Math.floor((x + radius) / this.cellSize);
    const minCellZ = Math.floor((z - radius) / this.cellSize);
    const maxCellZ = Math.floor((z + radius) / this.cellSize);

    for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
      for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ += 1) {
        const bucket = this.cells.get(`${cellX}:${cellZ}`);
        if (!bucket) continue;
        for (const definition of bucket) {
          const deltaX = definition.interactionPosition.x - x;
          const deltaZ = definition.interactionPosition.z - z;
          const squared = deltaX * deltaX + deltaZ * deltaZ;
          // Compared squared to keep the hot path free of a square root.
          if (squared <= squaredRadius) found.push({ definition, distance: Math.sqrt(squared) });
        }
      }
    }
    return found.sort((left, right) => left.distance - right.distance);
  }

  /**
   * The single closest cabinet within `radius`, or undefined. This is the
   * per-frame interaction query, so it avoids the sort that `queryRadius` does.
   */
  nearest(x: number, z: number, radius: number): NearbyCabinet | undefined {
    let best: NearbyCabinet | undefined;
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(radius) || radius < 0) return undefined;
    const squaredRadius = radius * radius;
    const minCellX = Math.floor((x - radius) / this.cellSize);
    const maxCellX = Math.floor((x + radius) / this.cellSize);
    const minCellZ = Math.floor((z - radius) / this.cellSize);
    const maxCellZ = Math.floor((z + radius) / this.cellSize);
    let bestSquared = Number.POSITIVE_INFINITY;

    for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
      for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ += 1) {
        const bucket = this.cells.get(`${cellX}:${cellZ}`);
        if (!bucket) continue;
        for (const definition of bucket) {
          const deltaX = definition.interactionPosition.x - x;
          const deltaZ = definition.interactionPosition.z - z;
          const squared = deltaX * deltaX + deltaZ * deltaZ;
          if (squared <= squaredRadius && squared < bestSquared) {
            bestSquared = squared;
            best = { definition, distance: Math.sqrt(squared) };
          }
        }
      }
    }
    return best;
  }

  /** Number of buckets a query of this radius would visit. Used by benchmarks. */
  cellsVisited(radius: number): number {
    const span = Math.floor((2 * radius) / this.cellSize) + 2;
    return span * span;
  }

  #key(x: number, z: number): string {
    return `${Math.floor(x / this.cellSize)}:${Math.floor(z / this.cellSize)}`;
  }
}
