import {
  createMatch, finishMatch, hostOf, isJoinable, joinMatch, leaveMatch, seatOf, setReady, startMatch,
  type Match, type MatchSeat, type ResultSource
} from '../domain/match.js';

/**
 * Live matches, one per occupied cabinet.
 *
 * Layered on top of cabinet ownership rather than replacing it. A cabinet still
 * has exactly one owner — that check-and-set is what stops two players claiming
 * the same machine, it is already correct, already tested, and its state is
 * mirrored by the Cloudflare Worker, so widening it to four owners would mean
 * changing two implementations in lockstep for no gain.
 *
 * Instead the owner hosts, and everyone else joins the *match* at that cabinet.
 * Which is also how an arcade actually works: one person puts the coin in, and
 * three more pick up controllers.
 */
export type MatchEvent =
  | { type: 'MatchOpened'; roomId: string; match: MatchView }
  | { type: 'MatchChanged'; roomId: string; match: MatchView }
  | { type: 'MatchClosed'; roomId: string; matchId: string; cabinetId: string };

/** What a client is told. Seats only — no internal timers, no player records. */
export interface MatchView {
  matchId: string;
  cabinetId: string;
  gameId: string;
  state: Match['state'];
  maxPlayers: number;
  minPlayers: number;
  hostPlayerId: string | null;
  seats: Array<{ seatIndex: number; playerId: string; displayName: string; ready: boolean }>;
  result: { winnerPlayerId: string | null; source: ResultSource } | null;
}

export interface MatchJoinContext {
  playerId: string;
  displayName: string;
  /** Metres from the cabinet, measured by the caller against live position. */
  distance: number;
}

export interface MatchManagerOptions {
  /** Same radius as reserving a cabinet: you join a game you are standing at. */
  interactionDistance: number;
  now: () => number;
}

const defaults: MatchManagerOptions = { interactionDistance: 2.6, now: () => Date.now() };

export class MatchManager {
  #byCabinet = new Map<string, Match>();
  #byPlayer = new Map<string, string>();
  #listeners = new Set<(event: MatchEvent) => void>();
  #options: MatchManagerOptions;
  #sequence = 0;

  constructor(options: Partial<MatchManagerOptions> = {}) {
    this.#options = { ...defaults, ...options };
  }

  subscribe(listener: (event: MatchEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Opens a match when the cabinet's owner starts a game that seats more than
   * one. A single-player game opens one too, so the lifecycle is identical and
   * a game that later gains a second seat needs no new path.
   */
  open(
    roomId: string, cabinetId: string, gameId: string,
    host: { playerId: string; displayName: string },
    limits: { maxPlayers: number; minPlayers?: number }
  ): { ok: true; view: MatchView } | { ok: false; reason: string } {
    const key = this.#key(roomId, cabinetId);
    if (this.#byCabinet.has(key)) return { ok: false, reason: 'match-exists' };
    if (this.#byPlayer.has(this.#key(roomId, host.playerId))) return { ok: false, reason: 'player-elsewhere' };

    const now = this.#options.now();
    this.#sequence += 1;
    const match = createMatch(`mt-${now.toString(36)}-${this.#sequence}`, cabinetId, gameId, limits, now);
    const seated = joinMatch(match, host, now);
    if (!seated.ok) return { ok: false, reason: seated.reason };

    this.#byCabinet.set(key, match);
    this.#byPlayer.set(this.#key(roomId, host.playerId), key);
    const view = toView(match);
    this.#emit({ type: 'MatchOpened', roomId, match: view });
    return { ok: true, view };
  }

  /**
   * Seats another player.
   *
   * Proximity is checked here as well as for the cabinet itself: joining a
   * four-player game from across the room would let a player take a seat
   * nobody standing at the machine could see them take.
   */
  join(roomId: string, cabinetId: string, context: MatchJoinContext):
  { ok: true; seat: MatchSeat; view: MatchView } | { ok: false; reason: string } {
    const match = this.#byCabinet.get(this.#key(roomId, cabinetId));
    if (!match) return { ok: false, reason: 'unknown-match' };
    if (this.#byPlayer.has(this.#key(roomId, context.playerId))) return { ok: false, reason: 'player-elsewhere' };
    if (context.distance > this.#options.interactionDistance) return { ok: false, reason: 'too-far' };
    if (!isJoinable(match)) return { ok: false, reason: match.seats.length >= match.maxPlayers ? 'match-full' : 'match-started' };

    const seated = joinMatch(match, context, this.#options.now());
    if (!seated.ok) return { ok: false, reason: seated.reason };
    this.#byPlayer.set(this.#key(roomId, context.playerId), this.#key(roomId, cabinetId));
    const view = toView(match);
    this.#emit({ type: 'MatchChanged', roomId, match: view });
    return { ok: true, seat: seated.seat, view };
  }

  ready(roomId: string, playerId: string, ready: boolean): { ok: boolean; view?: MatchView } {
    const match = this.#matchFor(roomId, playerId);
    if (!match) return { ok: false };
    if (!setReady(match, playerId, ready)) return { ok: false };
    const view = toView(match);
    this.#emit({ type: 'MatchChanged', roomId, match: view });
    return { ok: true, view };
  }

  /** Only the host starts, and only once everyone seated is ready. */
  start(roomId: string, playerId: string): { ok: true; view: MatchView } | { ok: false; reason: string } {
    const match = this.#matchFor(roomId, playerId);
    if (!match) return { ok: false, reason: 'unknown-match' };
    if (hostOf(match)?.playerId !== playerId) return { ok: false, reason: 'not-host' };
    const started = startMatch(match, this.#options.now());
    if (!started.ok) return started;
    const view = toView(match);
    this.#emit({ type: 'MatchChanged', roomId, match: view });
    return { ok: true, view };
  }

  /**
   * Records an outcome.
   *
   * The source is supplied by the caller and stored as given. Nothing here
   * decides that a result is trustworthy — a match played on players' own
   * machines reports its own outcome, and calling that `verified` would be a
   * lie told in one place and believed everywhere after.
   */
  finish(
    roomId: string, cabinetId: string,
    result: { winnerPlayerId: string | null; source: ResultSource; evidence?: string | null }
  ): { ok: true; view: MatchView } | { ok: false; reason: string } {
    const match = this.#byCabinet.get(this.#key(roomId, cabinetId));
    if (!match) return { ok: false, reason: 'unknown-match' };
    const finished = finishMatch(match, result, this.#options.now());
    if (!finished.ok) return finished;
    const view = toView(match);
    this.#emit({ type: 'MatchChanged', roomId, match: view });
    return { ok: true, view };
  }

  /**
   * Removes a player, from wherever they were.
   *
   * Called on disconnect as well as on leaving, so it must not assume the
   * player is still connected or still near the cabinet.
   */
  leave(roomId: string, playerId: string): { ok: boolean; closed: boolean } {
    const playerKey = this.#key(roomId, playerId);
    const cabinetKey = this.#byPlayer.get(playerKey);
    if (!cabinetKey) return { ok: false, closed: false };
    const match = this.#byCabinet.get(cabinetKey);
    this.#byPlayer.delete(playerKey);
    if (!match) return { ok: false, closed: false };

    leaveMatch(match, playerId, this.#options.now());
    if (match.seats.length === 0) {
      this.#close(roomId, match);
      return { ok: true, closed: true };
    }
    this.#emit({ type: 'MatchChanged', roomId, match: toView(match) });
    return { ok: true, closed: false };
  }

  /** Ends a match outright, for a released cabinet or a forced release. */
  close(roomId: string, cabinetId: string): boolean {
    const match = this.#byCabinet.get(this.#key(roomId, cabinetId));
    if (!match) return false;
    this.#close(roomId, match);
    return true;
  }

  view(roomId: string, cabinetId: string): MatchView | null {
    const match = this.#byCabinet.get(this.#key(roomId, cabinetId));
    return match ? toView(match) : null;
  }

  viewsForRoom(roomId: string): MatchView[] {
    const prefix = `${roomId} `;
    return [...this.#byCabinet.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, match]) => toView(match));
  }

  get size(): number { return this.#byCabinet.size; }

  #close(roomId: string, match: Match): void {
    const key = this.#key(roomId, match.cabinetId);
    for (const seat of match.seats) this.#byPlayer.delete(this.#key(roomId, seat.playerId));
    this.#byCabinet.delete(key);
    this.#emit({ type: 'MatchClosed', roomId, matchId: match.matchId, cabinetId: match.cabinetId });
  }

  #matchFor(roomId: string, playerId: string): Match | undefined {
    const cabinetKey = this.#byPlayer.get(this.#key(roomId, playerId));
    return cabinetKey ? this.#byCabinet.get(cabinetKey) : undefined;
  }

  // A NUL separator: room and cabinet ids cannot contain one, so no pair of
  // ids can collide into the same key.
  #key(a: string, b: string): string { return `${a} ${b}`; }

  #emit(event: MatchEvent): void {
    for (const listener of this.#listeners) {
      try { listener(event); } catch { /* one bad subscriber must not stop the rest. */ }
    }
  }
}

function toView(match: Match): MatchView {
  return {
    matchId: match.matchId,
    cabinetId: match.cabinetId,
    gameId: match.gameId,
    state: match.state,
    maxPlayers: match.maxPlayers,
    minPlayers: match.minPlayers,
    hostPlayerId: hostOf(match)?.playerId ?? null,
    seats: match.seats.map((seat) => ({
      seatIndex: seat.seatIndex, playerId: seat.playerId, displayName: seat.displayName, ready: seat.ready
    })),
    result: match.result ? { winnerPlayerId: match.result.winnerPlayerId, source: match.result.source } : null
  };
}

export { seatOf };
