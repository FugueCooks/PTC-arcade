import type { CabinetDefinition } from '../domain/cabinet-definition.js';
import type { CabinetIndex } from './cabinet-index.js';

/**
 * Milestone 11.16 — zones are the unit of cabinet streaming.
 *
 * A zone owns a rectangular region of the floor and the cabinets inside it.
 * Bounds are derived from the cabinets themselves rather than authored
 * separately, so a zone can never drift out of sync with its contents; the
 * padding accounts for the space a player stands in to use a cabinet on the
 * zone's edge.
 */
export interface ZoneBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

export interface ZoneDefinition {
  readonly id: string;
  readonly bounds: ZoneBounds;
  readonly cabinetIds: readonly string[];
  /** Zones whose bounds lie within the preload distance of this one. */
  readonly adjacentZoneIds: readonly string[];
  /** Metres from a zone's edge at which it should begin loading. */
  readonly preloadDistance: number;
}

/** Room for a player to stand and for the cabinet model's own footprint. */
const BOUNDS_PADDING_METRES = 4;
export const DEFAULT_PRELOAD_DISTANCE_METRES = 20;

export class ZoneRegistry {
  private readonly zones = new Map<string, ZoneDefinition>();
  private readonly zoneByCabinetId = new Map<string, string>();

  constructor(index: CabinetIndex, preloadDistance: number = DEFAULT_PRELOAD_DISTANCE_METRES) {
    const draft = new Map<string, { bounds: ZoneBounds; cabinetIds: string[] }>();
    for (const zoneId of index.zoneIds()) {
      const cabinets = index.forZone(zoneId);
      draft.set(zoneId, { bounds: boundsFor(cabinets), cabinetIds: cabinets.map(({ id }) => id) });
      for (const cabinet of cabinets) this.zoneByCabinetId.set(cabinet.id, zoneId);
    }
    for (const [zoneId, entry] of draft) {
      const adjacent = [...draft.entries()]
        .filter(([otherId, other]) => otherId !== zoneId && boundsWithin(entry.bounds, other.bounds, preloadDistance))
        .map(([otherId]) => otherId)
        .sort();
      this.zones.set(zoneId, Object.freeze({
        id: zoneId,
        bounds: entry.bounds,
        cabinetIds: Object.freeze(entry.cabinetIds),
        adjacentZoneIds: Object.freeze(adjacent),
        preloadDistance
      }));
    }
  }

  get size(): number { return this.zones.size; }
  get(zoneId: string): ZoneDefinition | undefined { return this.zones.get(zoneId); }
  all(): readonly ZoneDefinition[] { return [...this.zones.values()]; }
  zoneIdForCabinet(cabinetId: string): string | undefined { return this.zoneByCabinetId.get(cabinetId); }

  /** The zone containing a point, or undefined when a player stands between zones. */
  zoneAt(x: number, z: number): ZoneDefinition | undefined {
    for (const zone of this.zones.values()) {
      if (x >= zone.bounds.minX && x <= zone.bounds.maxX && z >= zone.bounds.minZ && z <= zone.bounds.maxZ) return zone;
    }
    return undefined;
  }

  /**
   * Zones a client at this position should have loaded: the one it stands in
   * plus everything within preload distance. When a player is between zones the
   * nearest zones still qualify by distance, so crossing a boundary never
   * produces a frame with nothing loaded.
   */
  activeZoneIds(x: number, z: number): readonly string[] {
    const active: string[] = [];
    for (const zone of this.zones.values()) {
      if (distanceToBounds(x, z, zone.bounds) <= zone.preloadDistance) active.push(zone.id);
    }
    return active.sort();
  }
}

function boundsFor(cabinets: readonly CabinetDefinition[]): ZoneBounds {
  if (cabinets.length === 0) return Object.freeze({ minX: 0, maxX: 0, minZ: 0, maxZ: 0 });
  let minX = Number.POSITIVE_INFINITY, maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY, maxZ = Number.NEGATIVE_INFINITY;
  for (const { interactionPosition } of cabinets) {
    minX = Math.min(minX, interactionPosition.x);
    maxX = Math.max(maxX, interactionPosition.x);
    minZ = Math.min(minZ, interactionPosition.z);
    maxZ = Math.max(maxZ, interactionPosition.z);
  }
  return Object.freeze({
    minX: minX - BOUNDS_PADDING_METRES, maxX: maxX + BOUNDS_PADDING_METRES,
    minZ: minZ - BOUNDS_PADDING_METRES, maxZ: maxZ + BOUNDS_PADDING_METRES
  });
}

/** Planar distance from a point to a rectangle; 0 when the point is inside. */
function distanceToBounds(x: number, z: number, bounds: ZoneBounds): number {
  const dx = Math.max(bounds.minX - x, 0, x - bounds.maxX);
  const dz = Math.max(bounds.minZ - z, 0, z - bounds.maxZ);
  return Math.hypot(dx, dz);
}

function boundsWithin(left: ZoneBounds, right: ZoneBounds, distance: number): boolean {
  const dx = Math.max(right.minX - left.maxX, 0, left.minX - right.maxX);
  const dz = Math.max(right.minZ - left.maxZ, 0, left.minZ - right.maxZ);
  return Math.hypot(dx, dz) <= distance;
}
