import { randomUUID } from 'node:crypto';
import type { ChatMessage, ChatSendResult } from '../protocol.js';
import type { PlayerEvent, PlayerManager } from '../players/player-manager.js';

export interface ChatManagerOptions {
  maxLength: number;
  historyLimit: number;
  rateWindowMs: number;
  maxMessagesPerWindow: number;
  minimumIntervalMs: number;
}

export type ChatEvent = { type: 'ChatMessageCreated'; message: ChatMessage };

const defaults: ChatManagerOptions = {
  maxLength: 180,
  historyLimit: 40,
  rateWindowMs: 6_000,
  maxMessagesPerWindow: 4,
  minimumIntervalMs: 550
};

/** Owns sanitized, room-local chat history and rate limiting. */
export class ChatManager {
  private readonly histories = new Map<string, ChatMessage[]>();
  private readonly sendTimes = new Map<string, number[]>();
  private readonly listeners = new Set<(event: ChatEvent) => void>();
  private readonly options: ChatManagerOptions;

  constructor(private readonly players: PlayerManager, options: Partial<ChatManagerOptions> = {}) {
    this.options = { ...defaults, ...options };
  }

  subscribe(listener: (event: ChatEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(roomId: string): ChatMessage[] {
    return (this.histories.get(roomId) ?? []).map((message) => ({ ...message }));
  }

  send(socketId: string, text: unknown, now = Date.now()): ChatSendResult {
    const player = this.players.stateFor(socketId);
    if (!player || typeof text !== 'string') return { ok: false, reason: 'invalid' };
    const normalized = sanitizeChatText(text);
    if (!normalized) return { ok: false, reason: 'invalid' };
    if (normalized.length > this.options.maxLength) return { ok: false, reason: 'too-long' };
    if (!this.canSend(player.id, now)) return { ok: false, reason: 'rate-limited' };
    this.push({
      id: randomUUID(), roomId: player.roomId, kind: 'chat', playerId: player.id,
      displayName: player.n, text: normalized, at: now
    });
    return { ok: true };
  }

  handlePlayerEvent(event: PlayerEvent, now = Date.now()): void {
    if (event.type === 'PlayerJoined') this.system(event.roomId, `${event.player.n} joined the arcade.`, now);
    if (event.type === 'PlayerLeft') {
      this.system(event.roomId, `${event.player.n} left the arcade.`, now);
      this.sendTimes.delete(event.playerId);
    }
  }

  announce(roomId: string, text: string, now = Date.now()): void {
    const normalized = sanitizeChatText(text).slice(0, this.options.maxLength);
    if (normalized) this.push({ id: randomUUID(), roomId, kind: 'announcement', playerId: null, displayName: null, text: normalized, at: now });
  }

  private system(roomId: string, text: string, now: number): void {
    this.push({ id: randomUUID(), roomId, kind: 'system', playerId: null, displayName: null, text, at: now });
  }

  private canSend(playerId: string, now: number): boolean {
    const cutoff = now - this.options.rateWindowMs;
    const recent = (this.sendTimes.get(playerId) ?? []).filter((time) => time > cutoff);
    if (recent.length && now - recent[recent.length - 1] < this.options.minimumIntervalMs) return false;
    if (recent.length >= this.options.maxMessagesPerWindow) return false;
    recent.push(now);
    this.sendTimes.set(playerId, recent);
    return true;
  }

  private push(message: ChatMessage): void {
    const history = this.histories.get(message.roomId) ?? [];
    history.push(message);
    if (history.length > this.options.historyLimit) history.splice(0, history.length - this.options.historyLimit);
    this.histories.set(message.roomId, history);
    const event: ChatEvent = { type: 'ChatMessageCreated', message: { ...message } };
    this.listeners.forEach((listener) => listener(event));
  }
}

export function sanitizeChatText(value: string): string {
  return value.normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
