import type { CabinetState, CabinetUseResult, Position } from '../protocol.js';
import type { PlayerEvent, PlayerManager } from '../players/player-manager.js';
import { CABINET_REGISTRY, type CabinetDefinition } from './cabinet-registry.js';
import { CabinetIndex } from './cabinet-index.js';
import { CabinetStateSynchronizer } from './cabinet-state-sync.js';
import type { CabinetStateDelta } from '../../../shared/platform-contracts.js';

export interface CabinetManagerOptions {
  interactionDistance: number;
  activationTimeoutMs: number;
  requestCooldownMs: number;
}
export type CabinetEvent =
  | { type: 'CabinetStateChanged'; roomId: string; state: CabinetState }
  | { type: 'CabinetStateDelta'; roomId: string; delta: CabinetStateDelta<CabinetState> }
  | { type: 'CabinetForcedRelease'; roomId: string; playerId: string; cabinetId: string; reason: string };
type LogLevel = 'info' | 'warn';
type Logger = (level: LogLevel, event: string, details: Record<string, unknown>) => void;

const defaults: CabinetManagerOptions = { interactionDistance: 2.6, activationTimeoutMs: 5_000, requestCooldownMs: 250 };

/** Owns live cabinet state. Static definitions are shared; occupancy is isolated per room. */
export class CabinetManager {
  private readonly definitions = new Map(CABINET_REGISTRY.map((definition) => [definition.id, definition]));
  readonly index = new CabinetIndex(CABINET_REGISTRY);
  readonly synchronizer = new CabinetStateSynchronizer();
  private readonly roomStates = new Map<string, Map<string, CabinetState>>();
  private readonly requestTimes = new Map<string, number>();
  private readonly enabledOverrides = new Map<string, boolean>();
  private readonly listeners = new Set<(event: CabinetEvent) => void>();
  private readonly options: CabinetManagerOptions;

  constructor(private readonly players: PlayerManager, options: Partial<CabinetManagerOptions> = {}, private readonly logger: Logger = structuredLog) {
    this.options = { ...defaults, ...options };
  }

  subscribe(listener: (event: CabinetEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(roomId: string, zoneId = 'all'): CabinetState[] {
    return this.synchronizer.snapshot(roomId, zoneId, CABINET_REGISTRY, this.statesFor(roomId)).cabinets;
  }

  snapshotPayload(roomId: string, zoneId = 'all') {
    return this.synchronizer.snapshot(roomId, zoneId, CABINET_REGISTRY, this.statesFor(roomId));
  }

  requestUse(socketId: string, cabinetId: unknown, now = Date.now()): CabinetUseResult {
    const playerId = this.players.playerIdForSocket(socketId);
    const player = playerId ? this.players.stateForPlayerId(playerId) : undefined;
    if (!playerId || !player || typeof cabinetId !== 'string') return this.deny('invalid-request', cabinetId, playerId);
    this.logger('info', 'cabinet_requested', { roomId: player.roomId, cabinetId, playerId });
    const definition = this.definitions.get(cabinetId);
    if (!definition) return this.deny('unknown-cabinet', cabinetId, playerId);
    if (!this.isEnabled(cabinetId)) return this.deny('disabled', cabinetId, playerId);
    const previousRequest = this.requestTimes.get(playerId) ?? -Infinity;
    if (now - previousRequest < this.options.requestCooldownMs) return this.deny('rate-limited', cabinetId, playerId);
    this.requestTimes.set(playerId, now);
    const state = this.stateFor(player.roomId, cabinetId);

    // Same-owner retries are idempotent and allow a reconnected player to reopen local UI.
    if (state.occupiedByPlayerId === playerId) return this.approved(state, definition);
    if (player.activeCabinetId) return this.deny('already-using', cabinetId, playerId);
    if (state.status !== 'available') {
      this.logger('warn', 'cabinet_ownership_conflict_prevented', { roomId: player.roomId, cabinetId, playerId });
      return this.deny('occupied', cabinetId, playerId);
    }
    const distance = Math.hypot(player.p[0] - definition.interactionPosition.x, player.p[2] - definition.interactionPosition.z);
    if (distance > this.options.interactionDistance) return this.deny('too-far', cabinetId, playerId);

    // This check-and-set is synchronous: no async boundary can grant a second owner.
    state.status = 'reserved';
    state.occupiedByPlayerId = playerId;
    state.occupiedByDisplayName = player.n;
    state.reservedAt = now;
    state.sessionStartedAt = null;
    const alignment = this.alignment(definition);
    this.players.setCabinetState(playerId, cabinetId, 'reserved', alignment, now);
    this.changed(player.roomId, state);
    this.logger('info', 'cabinet_approved', { roomId: player.roomId, cabinetId, playerId });
    return this.approved(state, definition);
  }

  activate(socketId: string, cabinetId: unknown, now = Date.now()): CabinetUseResult {
    const context = this.ownerContext(socketId, cabinetId);
    if (!context) return this.deny(typeof cabinetId === 'string' && this.definitions.has(cabinetId) ? 'not-owner' : 'invalid-request', cabinetId);
    const { playerId, player, state, definition } = context;
    if (state.status === 'in-use') return this.approved(state, definition);
    if (state.status !== 'reserved') return this.deny('not-owner', cabinetId, playerId);
    state.status = 'in-use';
    state.sessionStartedAt = now;
    this.players.setCabinetState(playerId, cabinetId as string, 'interact', this.alignment(definition), now);
    this.changed(player.roomId, state);
    this.logger('info', 'cabinet_activated', { roomId: player.roomId, cabinetId, playerId });
    return this.approved(state, definition);
  }

  release(socketId: string, cabinetId: unknown, now = Date.now()): CabinetUseResult {
    const context = this.ownerContext(socketId, cabinetId);
    if (!context) return this.deny(typeof cabinetId === 'string' && this.definitions.has(cabinetId) ? 'not-owner' : 'invalid-request', cabinetId);
    const result = copyState(context.state);
    this.releaseOwned(context.player.roomId, context.state, context.playerId, 'player-release', now);
    return { ok: true, state: { ...result, status: 'available', occupiedByPlayerId: null, occupiedByDisplayName: null, reservedAt: null, sessionStartedAt: null } };
  }

  handlePlayerEvent(event: PlayerEvent, now = Date.now()): void {
    if (event.type === 'PlayerLeft') this.releaseForPlayer(event.roomId, event.playerId, 'disconnect-expired', now);
    if (event.type === 'PlayerDisconnected') this.logger('info', 'cabinet_disconnect_grace_started', { roomId: event.roomId, playerId: event.playerId });
  }

  sweep(now = Date.now()): void {
    for (const [roomId, states] of this.roomStates) {
      for (const state of states.values()) {
        if (state.status !== 'reserved' || state.reservedAt === null || now - state.reservedAt <= this.options.activationTimeoutMs) continue;
        const playerId = state.occupiedByPlayerId;
        if (!playerId) continue;
        this.releaseOwned(roomId, state, playerId, 'activation-timeout', now, true);
        this.logger('warn', 'cabinet_timed_out', { roomId, cabinetId: state.cabinetId, playerId });
      }
    }
  }

  private statesFor(roomId: string): Map<string, CabinetState> {
    let states = this.roomStates.get(roomId);
    if (!states) {
      states = new Map();
      this.roomStates.set(roomId, states);
    }
    return states;
  }

  isEnabled(cabinetId: string): boolean { return this.enabledOverrides.get(cabinetId) ?? this.definitions.get(cabinetId)?.enabled ?? false; }
  setEnabled(cabinetId: string, enabled: boolean): boolean {
    if (!this.definitions.has(cabinetId)) return false;
    this.enabledOverrides.set(cabinetId, enabled);
    return true;
  }

  private ownerContext(socketId: string, cabinetId: unknown) {
    if (typeof cabinetId !== 'string') return undefined;
    const definition = this.definitions.get(cabinetId);
    const playerId = this.players.playerIdForSocket(socketId);
    const player = playerId ? this.players.stateForPlayerId(playerId) : undefined;
    if (!definition || !player || player.activeCabinetId !== cabinetId) return undefined;
    const state = this.stateFor(player.roomId, cabinetId);
    if (state.occupiedByPlayerId !== playerId) return undefined;
    return { definition, playerId, player, state };
  }

  private releaseForPlayer(roomId: string, playerId: string, reason: string, now: number): void {
    const states = this.roomStates.get(roomId);
    if (!states) return;
    const state = [...states.values()].find((candidate) => candidate.occupiedByPlayerId === playerId);
    if (state) this.releaseOwned(roomId, state, playerId, reason, now, true);
  }

  private releaseOwned(roomId: string, state: CabinetState, playerId: string, reason: string, now: number, forced = false): void {
    if (state.occupiedByPlayerId !== playerId) return;
    const cabinetId = state.cabinetId;
    Object.assign(state, availableState(cabinetId));
    this.players.setCabinetState(playerId, null, 'none', undefined, now);
    this.changed(roomId, state);
    if (forced) this.publish({ type: 'CabinetForcedRelease', roomId, playerId, cabinetId, reason });
    this.logger('info', 'cabinet_released', { roomId, cabinetId, playerId, reason });
  }

  private approved(state: CabinetState, definition: CabinetDefinition): CabinetUseResult {
    return { ok: true, state: copyState(state), alignment: this.alignment(definition) };
  }
  private alignment(definition: CabinetDefinition): { position: Position; rotationY: number } {
    const point = definition.playerPosition;
    return { position: [point.x, point.y, point.z], rotationY: definition.playerRotationY };
  }
  private deny(reason: CabinetUseResult['reason'], cabinetId: unknown, playerId?: string): CabinetUseResult {
    this.logger('warn', 'cabinet_denied', { cabinetId: typeof cabinetId === 'string' ? cabinetId : null, playerId: playerId ?? null, reason });
    return { ok: false, reason };
  }
  private stateFor(roomId: string, cabinetId: string): CabinetState {
    const states = this.statesFor(roomId);let state = states.get(cabinetId);
    if (!state) { state = availableState(cabinetId); states.set(cabinetId, state); }
    return state;
  }
  private changed(roomId: string, state: CabinetState): void {
    this.publish({ type: 'CabinetStateChanged', roomId, state: copyState(state) });
    const zoneId = this.definitions.get(state.cabinetId)?.zoneId ?? 'all';
    this.publish({ type: 'CabinetStateDelta', roomId, delta: this.synchronizer.changed(roomId, zoneId, state) });
  }
  private publish(event: CabinetEvent): void { this.listeners.forEach((listener) => listener(event)); }
}

function availableState(cabinetId: string): CabinetState {
  return { cabinetId, occupiedByPlayerId: null, occupiedByDisplayName: null, status: 'available', reservedAt: null, sessionStartedAt: null };
}
function copyState(state: CabinetState): CabinetState { return { ...state }; }
function structuredLog(level: LogLevel, event: string, details: Record<string, unknown>): void {
  console[level](JSON.stringify({ level, event, ...details, at: new Date().toISOString() }));
}
