import type { CabinetState } from '../protocol.js';
import type { CabinetDefinition } from './cabinet-registry.js';
import type { CabinetStateDelta, CabinetStateSnapshot } from '../../../shared/platform-contracts.js';

/** Revision authority for cabinet snapshots and deltas. Static metadata is never repeated in deltas. */
export class CabinetStateSynchronizer {
  private readonly revisions = new Map<string, number>();

  snapshot(roomId: string, zoneId: string, definitions: readonly CabinetDefinition[], states: ReadonlyMap<string, CabinetState>): CabinetStateSnapshot<CabinetState> {
    return {
      roomId, zoneId, revision: this.revision(roomId, zoneId),
      cabinets: definitions.filter((definition) => zoneId === 'all' || definition.zoneId === zoneId)
        .map((definition) => copy(states.get(definition.id) ?? available(definition.id)))
    };
  }

  changed(roomId: string, zoneId: string, state: CabinetState): CabinetStateDelta<CabinetState> {
    const previousRevision = this.revision(roomId, zoneId);
    const revision = previousRevision + 1;
    this.revisions.set(key(roomId, zoneId), revision);
    return { roomId, zoneId, previousRevision, revision, changes: [copy(state)] };
  }

  revision(roomId: string, zoneId: string): number { return this.revisions.get(key(roomId, zoneId)) ?? 0; }
  clearRoom(roomId: string): void { for (const value of this.revisions.keys()) if (value.startsWith(`${roomId}:`)) this.revisions.delete(value); }
}

function key(roomId: string, zoneId: string): string { return `${roomId}:${zoneId}`; }
function copy(state: CabinetState): CabinetState { return { ...state }; }
function available(cabinetId: string): CabinetState {
  return { cabinetId, occupiedByPlayerId: null, occupiedByDisplayName: null, status: 'available', reservedAt: null, sessionStartedAt: null };
}
