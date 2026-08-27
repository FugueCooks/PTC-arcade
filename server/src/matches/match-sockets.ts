import type { MatchManager, MatchView } from './match-manager.js';

/**
 * The socket surface for matches.
 *
 * Every decision is the server's. A client says "I want to sit down"; it never
 * says which seat, whether it is ready enough to start, or that it won. That
 * matters more here than on most surfaces: seat order decides who hosts the
 * netplay session, and a result is the thing anything at stake would settle on.
 *
 * Kept out of index.ts because the handlers need real tests, and the shape of
 * a refusal — a reason a client can act on, never a stack trace — is easier to
 * hold consistent in one file.
 */
export interface MatchSocketDependencies {
  matches: MatchManager;
  /** Live position and room for a player, by socket. Undefined once disconnected. */
  playerFor: (socketId: string) => { playerId: string; displayName: string; roomId: string; position: readonly [number, number, number] } | undefined;
  /** Where a cabinet is stood at, for the proximity check. */
  cabinetPosition: (cabinetId: string) => { x: number; z: number } | undefined;
  metrics?: { increment(name: string): void };
  /**
   * Called when a match actually starts. Netplay planning needs the room, the
   * game and every player's address, none of which belong in a socket handler —
   * so this reports the fact and the composition root does the work.
   */
  onMatchStarted?: (roomId: string, match: MatchView) => void;
}

type Acknowledge = (response: unknown) => void;

const CABINET_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;

/** A refusal a client can act on. Never carries an exception. */
function refuse(reason: string) { return { ok: false, reason }; }

export interface MatchSocketLike {
  id: string;
  on(event: 'match:join', handler: (payload: any, acknowledge?: Acknowledge) => void): unknown;
  on(event: 'match:ready', handler: (payload: any, acknowledge?: Acknowledge) => void): unknown;
  on(event: 'match:start', handler: (payload: any, acknowledge?: Acknowledge) => void): unknown;
  on(event: 'match:leave', handler: (payload: any, acknowledge?: Acknowledge) => void): unknown;
}

export function installMatchHandlers(socket: MatchSocketLike, dependencies: MatchSocketDependencies): void {
  const { matches, playerFor, cabinetPosition, metrics } = dependencies;

  const answer = (acknowledge: Acknowledge | undefined, response: unknown) => {
    if (typeof acknowledge === 'function') acknowledge(response);
  };

  socket.on('match:join', (payload, acknowledge) => {
    metrics?.increment('events_match_join_received_total');
    const player = playerFor(socket.id);
    const cabinetId = typeof payload?.cabinetId === 'string' ? payload.cabinetId : '';
    if (!player || !CABINET_ID.test(cabinetId)) return answer(acknowledge, refuse('invalid-request'));

    const position = cabinetPosition(cabinetId);
    if (!position) return answer(acknowledge, refuse('unknown-cabinet'));

    // Measured server-side from the player's authoritative position. A client
    // that sent its own distance could seat itself from anywhere in the room.
    const distance = Math.hypot(player.position[0] - position.x, player.position[2] - position.z);
    const result = matches.join(player.roomId, cabinetId, {
      playerId: player.playerId, displayName: player.displayName, distance
    });
    if (!result.ok) metrics?.increment('match_join_rejected_total');
    answer(acknowledge, result.ok ? { ok: true, seatIndex: result.seat.seatIndex, match: result.view } : refuse(result.reason));
  });

  socket.on('match:ready', (payload, acknowledge) => {
    const player = playerFor(socket.id);
    if (!player || typeof payload?.ready !== 'boolean') return answer(acknowledge, refuse('invalid-request'));
    const result = matches.ready(player.roomId, player.playerId, payload.ready);
    answer(acknowledge, result.ok ? { ok: true, match: result.view } : refuse('not-seated'));
  });

  socket.on('match:start', (_payload, acknowledge) => {
    const player = playerFor(socket.id);
    if (!player) return answer(acknowledge, refuse('invalid-request'));
    // Host-only, decided by seat order on the server. A client claiming to be
    // the host is not consulted.
    const result = matches.start(player.roomId, player.playerId);
    if (result.ok) dependencies.onMatchStarted?.(player.roomId, result.view);
    answer(acknowledge, result.ok ? { ok: true, match: result.view } : refuse(result.reason));
  });

  socket.on('match:leave', (_payload, acknowledge) => {
    const player = playerFor(socket.id);
    if (!player) return answer(acknowledge, refuse('invalid-request'));
    const result = matches.leave(player.roomId, player.playerId);
    answer(acknowledge, { ok: result.ok, closed: result.closed });
  });
}

/** The room-wide broadcasts, wired once rather than per socket. */
export function bridgeMatchEvents(
  matches: MatchManager,
  emit: (roomId: string, event: string, payload: unknown) => void
): () => void {
  return matches.subscribe((event) => {
    if (event.type === 'MatchClosed') {
      emit(event.roomId, 'match:closed', { matchId: event.matchId, cabinetId: event.cabinetId });
      return;
    }
    emit(event.roomId, event.type === 'MatchOpened' ? 'match:opened' : 'match:changed', event.match);
  });
}

export type { MatchView };
