import type { CabinetState, CabinetUseResult, Position } from '../protocol.js';
import type { PlayerEvent, PlayerManager } from '../players/player-manager.js';
import { CABINET_REGISTRY, type CabinetDefinition } from './cabinet-registry.js';
import { CabinetIndex } from './cabinet-index.js';
import { CabinetSpatialIndex } from './cabinet-spatial-index.js';
import { ZoneRegistry } from './zone-registry.js';
import { CabinetRevisionTracker, buildZoneSnapshot, hasVisibleChange, type CabinetZoneSnapshot } from './cabinet-delta-publisher.js';

export interface CabinetManagerOptions {
  interactionDistance: number;
  activationTimeoutMs: number;
  requestCooldownMs: number;
}
export type CabinetEvent =
  | { type: 'CabinetStateChanged'; roomId: string; state: CabinetState; revision: number; zoneId: string }
  | { type: 'CabinetForcedRelease'; roomId: string; playerId: string; cabinetId: string; reason: string };
type LogLevel = 'info' | 'warn';
type Logger = (level: LogLevel, event: string, details: Record<string, unknown>) => void;

const defaults: CabinetManagerOptions = { interactionDistance: 2.6, activationTimeoutMs: 5_000, requestCooldownMs: 250 };

/** Owns live cabinet state. Static definitions are shared; occupancy is isolated per room. */
export class CabinetManager {
  readonly index: CabinetIndex;
  readonly spatial: CabinetSpatialIndex;
  readonly zones: ZoneRegistry;
  private readonly revisions = new CabinetRevisionTracker();
  private readonly roomStates = new Map<string, Map<string, CabinetState>>();
  /**
   * Which cabinet a player currently holds, per room. Releasing on disconnect
   * used to scan every state in the room to find the owner; at thousands of
   * cabinets that scan runs on every disconnect, so ownership is indexed instead.
   */
  private readonly ownerToCabinet = new Map<string, string>();
  private readonly requestTimes = new Map<string, number>();
  private readonly listeners = new Set<(event: CabinetEvent) => void>();
  private readonly options: CabinetManagerOptions;

  constructor(
    private readonly players: PlayerManager,
    options: Partial<CabinetManagerOptions> = {},
    private readonly logger: Logger = structuredLog,
    definitions: readonly CabinetDefinition[] = CABINET_REGISTRY
  ) {
    this.options = { ...defaults, ...options };
    this.index = new CabinetIndex(definitions);
    this.spatial = new CabinetSpatialIndex(definitions);
    this.zones = new ZoneRegistry(this.index);
  }

  /**
   * How many cabinets in a room currently hold live state. With lazy
   * materialization this equals the number of cabinets reserved or in use, not
   * the registry size — the distinction Milestone 11.13 turns on.
   */
  activeStateCount(roomId: string): number { return this.roomStates.get(roomId)?.size ?? 0; }

  /** Current cabinet-state revision for a room. */
  revisionFor(roomId: string): number { return this.revisions.revisionFor(roomId); }

  /**
   * Milestone 11.14: a join receives only the zones the client needs. Cabinets
   * outside those zones keep authoritative server state but never reach the wire.
   */
  zoneSnapshot(roomId: string, zoneIds: readonly string[]): CabinetZoneSnapshot {
    return buildZoneSnapshot(roomId, this.revisions.revisionFor(roomId), zoneIds, (zoneId) =>
      this.index.forZone(zoneId).map(({ id }) => this.peekState(roomId, id)));
  }

  /** Zones a player at this position should have loaded. */
  activeZoneIds(x: number, z: number): readonly string[] { return this.zones.activeZoneIds(x, z); }

  /** Nearest interactable cabinet, via the spatial index rather than a scan. */
  nearestCabinet(x: number, z: number, radius = this.options.interactionDistance) {
    return this.spatial.nearest(x, z, radius);
  }

  subscribe(listener: (event: CabinetEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Every cabinet's state for a room. Room state is lazy now, so this is driven
   * by the index rather than by what happens to have been materialized.
   *
   * This is the unscaled path: it is O(registry) and exists for compatibility
   * with clients that predate zone streaming. `zoneSnapshot` is what a
   * large-registry client should use.
   */
  snapshot(roomId: string): CabinetState[] {
    return this.index.definitions.map(({ id }) => copyState(this.peekState(roomId, id)));
  }

  requestUse(socketId: string, cabinetId: unknown, now = Date.now()): CabinetUseResult {
    const playerId = this.players.playerIdForSocket(socketId);
    const player = playerId ? this.players.stateForPlayerId(playerId) : undefined;
    if (!playerId || !player || typeof cabinetId !== 'string') return this.deny('invalid-request', cabinetId, playerId);
    this.logger('info', 'cabinet_requested', { roomId: player.roomId, cabinetId, playerId });
    const definition = this.index.get(cabinetId);
    if (!definition) return this.deny('unknown-cabinet', cabinetId, playerId);
    if (!definition.enabled) return this.deny('disabled', cabinetId, playerId);
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
    const previous = copyState(state);
    state.status = 'reserved';
    state.occupiedByPlayerId = playerId;
    state.occupiedByDisplayName = player.n;
    state.reservedAt = now;
    state.sessionStartedAt = null;
    this.ownerToCabinet.set(ownerKey(player.roomId, playerId), cabinetId);
    const alignment = this.alignment(definition);
    this.players.setCabinetState(playerId, cabinetId, 'reserved', alignment, now);
    this.changed(player.roomId, state, previous);
    this.logger('info', 'cabinet_approved', { roomId: player.roomId, cabinetId, playerId });
    return this.approved(state, definition);
  }

  activate(socketId: string, cabinetId: unknown, now = Date.now()): CabinetUseResult {
    const context = this.ownerContext(socketId, cabinetId);
    if (!context) return this.deny(typeof cabinetId === 'string' && this.index.has(cabinetId) ? 'not-owner' : 'invalid-request', cabinetId);
    const { playerId, player, state, definition } = context;
    if (state.status === 'in-use') return this.approved(state, definition);
    if (state.status !== 'reserved') return this.deny('not-owner', cabinetId, playerId);
    const previous = copyState(state);
    state.status = 'in-use';
    state.sessionStartedAt = now;
    this.players.setCabinetState(playerId, cabinetId as string, 'interact', this.alignment(definition), now);
    this.changed(player.roomId, state, previous);
    this.logger('info', 'cabinet_activated', { roomId: player.roomId, cabinetId, playerId });
    return this.approved(state, definition);
  }

  release(socketId: string, cabinetId: unknown, now = Date.now()): CabinetUseResult {
    const context = this.ownerContext(socketId, cabinetId);
    if (!context) return this.deny(typeof cabinetId === 'string' && this.index.has(cabinetId) ? 'not-owner' : 'invalid-request', cabinetId);
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

  /**
   * Milestone 11.13: room state is created per cabinet on first touch, not for
   * the whole registry on first join. A cabinet nobody has interacted with is
   * available by definition, so materializing it early buys nothing and costs
   * one entry per cabinet per room.
   */
  /** Releases all per-room bookkeeping when a room closes. */
  forgetRoom(roomId: string): void {
    for (const key of this.ownerToCabinet.keys()) {
      if (key.startsWith(`${roomId}\u0000`)) this.ownerToCabinet.delete(key);
    }
    this.roomStates.delete(roomId);
    this.revisions.forget(roomId);
  }

  private statesFor(roomId: string): Map<string, CabinetState> {
    let states = this.roomStates.get(roomId);
    if (!states) {
      states = new Map<string, CabinetState>();
      this.roomStates.set(roomId, states);
    }
    return states;
  }

  /**
   * The live state for one cabinet, materialized on demand. Only mutating paths
   * call this: reads use `peekState`, so merely looking at a room cannot
   * allocate an entry per cabinet.
   */
  private stateFor(roomId: string, cabinetId: string): CabinetState {
    const states = this.statesFor(roomId);
    let state = states.get(cabinetId);
    if (!state) {
      state = availableState(cabinetId);
      states.set(cabinetId, state);
    }
    return state;
  }

  /**
   * Read-only view of a cabinet's state. An untouched cabinet is available by
   * definition, so it is described without being stored — which is what keeps
   * `roomStates` proportional to cabinets *in use* rather than to the registry.
   */
  private peekState(roomId: string, cabinetId: string): CabinetState {
    return this.roomStates.get(roomId)?.get(cabinetId) ?? availableState(cabinetId);
  }

  private ownerContext(socketId: string, cabinetId: unknown) {
    if (typeof cabinetId !== 'string') return undefined;
    const definition = this.index.get(cabinetId);
    const playerId = this.players.playerIdForSocket(socketId);
    const player = playerId ? this.players.stateForPlayerId(playerId) : undefined;
    if (!definition || !player || player.activeCabinetId !== cabinetId) return undefined;
    const state = this.stateFor(player.roomId, cabinetId);
    if (state.occupiedByPlayerId !== playerId) return undefined;
    return { definition, playerId, player, state };
  }

  /**
   * O(1) via the ownership index. This previously scanned every state in the
   * room on each disconnect, which is exactly the kind of full-registry walk
   * Milestone 11.13 removes from ordinary operation.
   */
  private releaseForPlayer(roomId: string, playerId: string, reason: string, now: number): void {
    const cabinetId = this.ownerToCabinet.get(ownerKey(roomId, playerId));
    if (cabinetId === undefined) return;
    const state = this.roomStates.get(roomId)?.get(cabinetId);
    if (state) this.releaseOwned(roomId, state, playerId, reason, now, true);
  }

  private releaseOwned(roomId: string, state: CabinetState, playerId: string, reason: string, now: number, forced = false): void {
    if (state.occupiedByPlayerId !== playerId) return;
    const cabinetId = state.cabinetId;
    const previous = copyState(state);
    this.ownerToCabinet.delete(ownerKey(roomId, playerId));
    Object.assign(state, availableState(cabinetId));
    this.players.setCabinetState(playerId, null, 'none', undefined, now);
    this.changed(roomId, state, previous);
    // Back to the default: stop tracking it so room state stays proportional to
    // cabinets actually in use, not to registry size.
    this.roomStates.get(roomId)?.delete(cabinetId);
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
  /**
   * Publishes a state change as a revision-stamped delta. A change that alters
   * nothing a client renders is dropped rather than broadcast: suppressing
   * no-op traffic is the point of Milestone 11.14 at scale.
   */
  private changed(roomId: string, state: CabinetState, previous?: CabinetState): void {
    if (!hasVisibleChange(previous, state)) return;
    const revision = this.revisions.bump(roomId);
    const zoneId = this.zones.zoneIdForCabinet(state.cabinetId) ?? '';
    this.publish({ type: 'CabinetStateChanged', roomId, state: copyState(state), revision, zoneId });
  }
  private publish(event: CabinetEvent): void { this.listeners.forEach((listener) => listener(event)); }
}

/** Ownership is per room: the same player ID cannot hold cabinets in two rooms. */
function ownerKey(roomId: string, playerId: string): string { return `${roomId}\u0000${playerId}`; }

function availableState(cabinetId: string): CabinetState {
  return { cabinetId, occupiedByPlayerId: null, occupiedByDisplayName: null, status: 'available', reservedAt: null, sessionStartedAt: null };
}
function copyState(state: CabinetState): CabinetState { return { ...state }; }
function structuredLog(level: LogLevel, event: string, details: Record<string, unknown>): void {
  console[level](JSON.stringify({ level, event, ...details, at: new Date().toISOString() }));
}
