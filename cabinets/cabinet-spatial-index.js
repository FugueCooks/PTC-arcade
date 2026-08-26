/**
 * Milestone 11.15 — client half of the cabinet spatial index.
 *
 * The render loop previously measured the distance to every cabinet on every
 * frame. That is 39 distance checks today and 10,000 at the scale this phase
 * targets, at 60 Hz, on the main thread. A uniform grid keyed on the X/Z plane
 * turns it into a handful of checks regardless of registry size.
 *
 * Mirrors server/src/cabinets/cabinet-spatial-index.ts: same structure, same
 * default cell size, same rationale. See that file for the full derivation.
 */
export const DEFAULT_CELL_SIZE_METRES = 8;

export class CabinetSpatialIndex {
  #cells = new Map();
  #entries = new Map();

  constructor(cellSize = DEFAULT_CELL_SIZE_METRES) {
    if (!Number.isFinite(cellSize) || cellSize <= 0) throw new Error('Cell size must be a positive number.');
    this.cellSize = cellSize;
  }

  get size() { return this.#entries.size; }
  get cellCount() { return this.#cells.size; }

  /**
   * Entries are keyed so a cabinet can be re-inserted (a moved or rebuilt scene
   * object) without leaving a stale copy behind in its old cell.
   */
  insert(id, x, z, payload) {
    this.remove(id);
    const key = this.#key(x, z);
    const entry = { id, x, z, payload };
    this.#entries.set(id, { key, entry });
    const bucket = this.#cells.get(key);
    if (bucket) bucket.push(entry);
    else this.#cells.set(key, [entry]);
  }

  remove(id) {
    const existing = this.#entries.get(id);
    if (!existing) return;
    this.#entries.delete(id);
    const bucket = this.#cells.get(existing.key);
    if (!bucket) return;
    const at = bucket.indexOf(existing.entry);
    if (at !== -1) bucket.splice(at, 1);
    if (bucket.length === 0) this.#cells.delete(existing.key);
  }

  clear() {
    this.#cells.clear();
    this.#entries.clear();
  }

  /**
   * Closest entry within `radius`, or null. Called every frame, so it compares
   * squared distances and never allocates an intermediate array.
   */
  nearest(x, z, radius) {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(radius) || radius < 0) return null;
    const squaredRadius = radius * radius;
    let best = null;
    let bestSquared = Infinity;
    const minCellX = Math.floor((x - radius) / this.cellSize), maxCellX = Math.floor((x + radius) / this.cellSize);
    const minCellZ = Math.floor((z - radius) / this.cellSize), maxCellZ = Math.floor((z + radius) / this.cellSize);
    for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
      for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ += 1) {
        const bucket = this.#cells.get(`${cellX}:${cellZ}`);
        if (!bucket) continue;
        for (const entry of bucket) {
          const deltaX = entry.x - x, deltaZ = entry.z - z;
          const squared = deltaX * deltaX + deltaZ * deltaZ;
          if (squared <= squaredRadius && squared < bestSquared) { bestSquared = squared; best = entry; }
        }
      }
    }
    return best;
  }

  /** Everything within `radius`, nearest first. Used for zone activation. */
  queryRadius(x, z, radius) {
    const found = [];
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(radius) || radius < 0) return found;
    const squaredRadius = radius * radius;
    const minCellX = Math.floor((x - radius) / this.cellSize), maxCellX = Math.floor((x + radius) / this.cellSize);
    const minCellZ = Math.floor((z - radius) / this.cellSize), maxCellZ = Math.floor((z + radius) / this.cellSize);
    for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
      for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ += 1) {
        const bucket = this.#cells.get(`${cellX}:${cellZ}`);
        if (!bucket) continue;
        for (const entry of bucket) {
          const deltaX = entry.x - x, deltaZ = entry.z - z;
          const squared = deltaX * deltaX + deltaZ * deltaZ;
          if (squared <= squaredRadius) found.push({ entry, distance: Math.sqrt(squared) });
        }
      }
    }
    return found.sort((left, right) => left.distance - right.distance);
  }

  #key(x, z) { return `${Math.floor(x / this.cellSize)}:${Math.floor(z / this.cellSize)}`; }
}
