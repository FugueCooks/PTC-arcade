import type { CabinetState } from '../protocol.js';

/**
 * Milestone 11.14 — snapshot plus delta synchronization.
 *
 * Before Phase 11 every room join pushed the complete cabinet array and every
 * change pushed a whole state object, with no way for a client to know it had
 * missed one. Two things change here:
 *
 *  - a join receives only the zones the client actually needs, not the platform;
 *  - after that, only changed states travel, each carrying a monotonic revision
 *    so a client can detect a gap and ask for a targeted resync.
 *
 * Static metadata (position, type, display name) is deliberately absent from
 * both: it lives in the versioned registry the client already loads, so it is
 * never resent. Only the dynamic fields below move at runtime.
 */

export interface CabinetDelta {
  roomId: string;
  /** Revision of the room's cabinet state after this change. */
  revision: number;
  state: CabinetState;
}

export interface CabinetZoneSnapshot {
  roomId: string;
  /** Revision the snapshot was taken at; the first delta a client accepts is revision + 1. */
  revision: number;
  zoneIds: readonly string[];
  cabinets: CabinetState[];
}

export type ResyncReason = 'revision-gap' | 'zone-changed' | 'client-request';

/**
 * Tracks a monotonic revision per room and decides what a client is owed.
 * Deliberately holds no socket and no timers: it is pure bookkeeping, so the
 * gap-detection rules can be tested exhaustively without a server.
 */
export class CabinetRevisionTracker {
  private readonly revisions = new Map<string, number>();

  /** Current revision for a room; 0 before anything has changed. */
  revisionFor(roomId: string): number {
    return this.revisions.get(roomId) ?? 0;
  }

  /** Advances a room's revision. Called once per accepted state change. */
  bump(roomId: string): number {
    const next = this.revisionFor(roomId) + 1;
    this.revisions.set(roomId, next);
    return next;
  }

  forget(roomId: string): void {
    this.revisions.delete(roomId);
  }

  /**
   * Decides whether a client at `clientRevision` can apply a delta at
   * `deltaRevision`. A client exactly one behind applies it; anything else has
   * missed an update and must resync rather than silently diverge.
   */
  evaluate(clientRevision: number, deltaRevision: number): { apply: boolean; resync: ResyncReason | null } {
    if (deltaRevision === clientRevision + 1) return { apply: true, resync: null };
    // Already seen: a duplicate delivery, safe to drop.
    if (deltaRevision <= clientRevision) return { apply: false, resync: null };
    return { apply: false, resync: 'revision-gap' };
  }
}

/**
 * Selects the cabinet states a client needs for the zones it currently occupies.
 * Callers pass a zone filter so a room with thousands of cabinets sends only the
 * active area, which is the whole point of Milestone 11.14.
 */
export function buildZoneSnapshot(
  roomId: string,
  revision: number,
  zoneIds: readonly string[],
  statesByZone: (zoneId: string) => readonly CabinetState[]
): CabinetZoneSnapshot {
  const cabinets: CabinetState[] = [];
  const seen = new Set<string>();
  for (const zoneId of zoneIds) {
    for (const state of statesByZone(zoneId)) {
      // Zones may be requested more than once (adjacency overlap); a cabinet
      // must still appear exactly once in the payload.
      if (seen.has(state.cabinetId)) continue;
      seen.add(state.cabinetId);
      cabinets.push({ ...state });
    }
  }
  return { roomId, revision, zoneIds: Object.freeze([...zoneIds]), cabinets };
}

/**
 * True when two states differ in any field a client renders. Used to suppress
 * no-op deltas: at thousands of cabinets, resending unchanged state is the
 * bandwidth cost this milestone exists to remove.
 */
export function hasVisibleChange(previous: CabinetState | undefined, next: CabinetState): boolean {
  if (!previous) return true;
  return previous.status !== next.status
    || previous.occupiedByPlayerId !== next.occupiedByPlayerId
    || previous.occupiedByDisplayName !== next.occupiedByDisplayName
    || previous.reservedAt !== next.reservedAt
    || previous.sessionStartedAt !== next.sessionStartedAt;
}
