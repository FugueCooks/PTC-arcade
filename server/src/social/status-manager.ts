import type { PlayerStatus } from '../protocol.js';
import type { PlayerEvent, PlayerManager } from '../players/player-manager.js';

export interface StatusManagerOptions { afkTimeoutMs: number }
const defaults: StatusManagerOptions = { afkTimeoutMs: 120_000 };

/** Owns activity timestamps and AFK transitions; PlayerManager stores the authoritative status. */
export class StatusManager {
  private readonly lastActivity = new Map<string, number>();
  private readonly options: StatusManagerOptions;

  constructor(private readonly players: PlayerManager, options: Partial<StatusManagerOptions> = {}) {
    this.options = { ...defaults, ...options };
  }

  handlePlayerEvent(event: PlayerEvent, now = Date.now()): void {
    if (event.type === 'PlayerJoined' || event.type === 'PlayerMoved' || event.type === 'PlayerReconnected') {
      this.lastActivity.set(event.player.id, now);
    }
    if (event.type === 'PlayerLeft') this.lastActivity.delete(event.playerId);
  }

  noteActivityForSocket(socketId: string, now = Date.now()): void {
    const player = this.players.stateFor(socketId);
    if (!player) return;
    this.lastActivity.set(player.id, now);
    const status = activityStatus(player);
    if (player.s === 'away' || player.s === 'disconnected') this.players.setPresenceStatus(player.id, status, now);
  }

  sweep(now = Date.now()): void {
    for (const [playerId, lastActivityAt] of this.lastActivity) {
      const player = this.players.stateForPlayerId(playerId);
      if (!player || player.s === 'disconnected' || player.activeCabinetId || now - lastActivityAt < this.options.afkTimeoutMs) continue;
      this.players.setPresenceStatus(playerId, 'away', now);
    }
  }
}

function activityStatus(player: { activeCabinetId: string | null; interactionState: string; a: string }): PlayerStatus {
  if (player.interactionState === 'interact') return 'playing';
  if (player.interactionState === 'reserved') return 'loading';
  return player.a === 'walk' ? 'walking' : 'idle';
}
