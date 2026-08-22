import type { ReactionEmoji, ReactionEvent, SocialActionResult } from '../protocol.js';
import type { PlayerEvent, PlayerManager } from '../players/player-manager.js';

export type ReactionManagerEvent = { type: 'ReactionShown'; roomId: string; event: ReactionEvent };
const reactions = new Set<ReactionEmoji>(['👍', '😂', '❤️', '🔥', '😮']);

/** Validates short-lived nearby reactions and owns their cooldowns. */
export class ReactionManager {
  private readonly reactionTimes = new Map<string, number>();
  private readonly listeners = new Set<(event: ReactionManagerEvent) => void>();

  constructor(private readonly players: PlayerManager, private readonly cooldownMs = 550) {}

  subscribe(listener: (event: ReactionManagerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(socketId: string, emoji: unknown, now = Date.now()): SocialActionResult {
    const player = this.players.stateFor(socketId);
    if (!player || typeof emoji !== 'string' || !reactions.has(emoji as ReactionEmoji)) return { ok: false, reason: 'invalid' };
    if (now - (this.reactionTimes.get(player.id) ?? -Infinity) < this.cooldownMs) return { ok: false, reason: 'rate-limited' };
    this.reactionTimes.set(player.id, now);
    const event: ReactionManagerEvent = {
      type: 'ReactionShown', roomId: player.roomId,
      event: { playerId: player.id, emoji: emoji as ReactionEmoji, at: now, durationMs: 1_700 }
    };
    this.listeners.forEach((listener) => listener(event));
    return { ok: true };
  }

  handlePlayerEvent(event: PlayerEvent): void {
    if (event.type === 'PlayerLeft') this.reactionTimes.delete(event.playerId);
  }
}
