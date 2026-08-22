import type { PlayerState } from '../protocol.js';
import type { PlayerManager } from '../players/player-manager.js';

export interface PresenceManagerOptions { nearbyDistance: number; socialDistance: number; farUpdateIntervalMs: number }
const defaults: PresenceManagerOptions = { nearbyDistance: 12, socialDistance: 15, farUpdateIntervalMs: 300 };

/** Computes proximity tiers without owning player or room state. */
export class PresenceManager {
  private readonly lastFarBroadcast = new Map<string, number>();
  private readonly options: PresenceManagerOptions;

  constructor(private readonly players: PlayerManager, options: Partial<PresenceManagerOptions> = {}) {
    this.options = { ...defaults, ...options };
  }

  movementRecipients(player: PlayerState, senderSocketId: string, now = Date.now()): string[] {
    const peers = this.players.connectedPlayersInRoom(player.roomId).filter(({ socketId }) => socketId !== senderSocketId);
    const alwaysBroadcast = player.s !== 'walking' || player.activeCabinetId !== null;
    const maySendFar = alwaysBroadcast || now - (this.lastFarBroadcast.get(player.id) ?? -Infinity) >= this.options.farUpdateIntervalMs;
    const recipients = peers.filter(({ player: peer }) => distance(player, peer) <= this.options.nearbyDistance || maySendFar).map(({ socketId }) => socketId);
    if (maySendFar) this.lastFarBroadcast.set(player.id, now);
    return recipients;
  }

  nearbySocketIds(playerId: string, includeSource = true): string[] {
    const source = this.players.stateForPlayerId(playerId);
    if (!source) return [];
    return this.players.connectedPlayersInRoom(source.roomId)
      .filter(({ player }) => (includeSource || player.id !== playerId) && distance(source, player) <= this.options.socialDistance)
      .map(({ socketId }) => socketId);
  }

  remove(playerId: string): void { this.lastFarBroadcast.delete(playerId); }
}

function distance(first: PlayerState, second: PlayerState): number {
  return Math.hypot(first.p[0] - second.p[0], first.p[2] - second.p[2]);
}
