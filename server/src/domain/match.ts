/**
 * A match: several players sharing one game on one cabinet.
 *
 * The arcade has been multiplayer in the lobby and single-player at every
 * cabinet. `CabinetManager` holds one `occupiedByPlayerId` and denies the second
 * arrival with `occupied`, so four people at a Melee cabinet is not currently a
 * thing the model can express — each of them runs their own isolated emulator.
 *
 * This is the missing middle. It says who is playing together, who is ready,
 * who hosts, and how it ended. It knows nothing about emulators or netplay
 * transports: those differ per platform, and every one of them needs this same
 * answer to the question "which four people, and in what order are they seated".
 *
 * Entirely synchronous and side-effect free. Seat allocation is a check-and-set
 * with no await inside it, for the same reason cabinet ownership is: an async
 * boundary in the middle is how two players get the same seat.
 */

export type MatchState = 'forming' | 'ready' | 'running' | 'finished' | 'abandoned';

/**
 * Where a result came from.
 *
 * Carried explicitly because the three are not interchangeable, and anything
 * built on top of a result — standings, and eventually anything at stake — has
 * to be able to tell them apart. A game running on a player's own machine
 * reports its own outcome, and that is worth exactly what it sounds like.
 */
export type ResultSource = 'client-reported' | 'operator-confirmed' | 'verified';

export interface MatchSeat {
  seatIndex: number;
  playerId: string;
  displayName: string;
  ready: boolean;
  joinedAt: number;
}

export interface MatchResult {
  winnerPlayerId: string | null;
  source: ResultSource;
  recordedAt: number;
  /** Free-form, for an operator's note or a verifier's reference. Never trusted. */
  evidence: string | null;
}

export interface Match {
  matchId: string;
  cabinetId: string;
  gameId: string;
  maxPlayers: number;
  minPlayers: number;
  seats: MatchSeat[];
  state: MatchState;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  result: MatchResult | null;
}

export type JoinFailure =
  | 'match-full' | 'already-seated' | 'match-started' | 'unknown-match' | 'player-elsewhere';

export interface MatchOptions {
  maxPlayers: number;
  /** Below this, starting is refused. One for a solo cabinet; two for a versus game. */
  minPlayers?: number;
}

/**
 * The host is whoever holds seat zero.
 *
 * Netplay on every platform needs one participant to be authoritative — the one
 * that opens the session others connect to — and picking it by seat means the
 * choice is already made, visibly and identically, on the server and on every
 * client, before any transport is involved.
 */
export function hostOf(match: Match): MatchSeat | null {
  return match.seats.find((seat) => seat.seatIndex === 0) ?? null;
}

export function seatOf(match: Match, playerId: string): MatchSeat | null {
  return match.seats.find((seat) => seat.playerId === playerId) ?? null;
}

export function isJoinable(match: Match): boolean {
  return (match.state === 'forming' || match.state === 'ready') && match.seats.length < match.maxPlayers;
}

export function createMatch(
  matchId: string, cabinetId: string, gameId: string, options: MatchOptions, now: number
): Match {
  const maxPlayers = Math.max(1, Math.floor(options.maxPlayers));
  const minPlayers = Math.min(maxPlayers, Math.max(1, Math.floor(options.minPlayers ?? 1)));
  return {
    matchId, cabinetId, gameId, maxPlayers, minPlayers,
    seats: [], state: 'forming', createdAt: now, startedAt: null, endedAt: null, result: null
  };
}

/**
 * Seats a player in the lowest free seat.
 *
 * Lowest rather than next, so a player who leaves while others are still
 * forming frees a seat that the next arrival takes — otherwise a cabinet that
 * has seen six people cycle through would report seat five of four.
 */
export function joinMatch(
  match: Match, player: { playerId: string; displayName: string }, now: number
): { ok: true; seat: MatchSeat } | { ok: false; reason: JoinFailure } {
  if (match.state === 'running') return { ok: false, reason: 'match-started' };
  if (match.state === 'finished' || match.state === 'abandoned') return { ok: false, reason: 'match-started' };
  if (seatOf(match, player.playerId)) return { ok: false, reason: 'already-seated' };
  if (match.seats.length >= match.maxPlayers) return { ok: false, reason: 'match-full' };

  const taken = new Set(match.seats.map((seat) => seat.seatIndex));
  let seatIndex = 0;
  while (taken.has(seatIndex)) seatIndex += 1;

  const seat: MatchSeat = { seatIndex, playerId: player.playerId, displayName: player.displayName, ready: false, joinedAt: now };
  match.seats.push(seat);
  match.seats.sort((a, b) => a.seatIndex - b.seatIndex);
  recomputeReadiness(match);
  return { ok: true, seat };
}

/**
 * Removes a player, and decides what that means for the match.
 *
 * Leaving while forming is ordinary. Leaving mid-match is not resolvable here:
 * whether three players continue without the fourth is a question about the
 * game, so the match is marked and the caller decides. The one case handled
 * outright is the last player leaving, which ends it.
 */
export function leaveMatch(match: Match, playerId: string, now: number): { ok: boolean; wasHost: boolean } {
  const seat = seatOf(match, playerId);
  if (!seat) return { ok: false, wasHost: false };
  const wasHost = seat.seatIndex === 0;

  match.seats = match.seats.filter((entry) => entry.playerId !== playerId);

  // Seat zero is the host, so someone has to hold it. Promoting the longest
  // seated player keeps the choice deterministic rather than incidental.
  if (wasHost && match.seats.length > 0) {
    const successor = [...match.seats].sort((a, b) => a.joinedAt - b.joinedAt || a.seatIndex - b.seatIndex)[0];
    successor.seatIndex = 0;
    match.seats.sort((a, b) => a.seatIndex - b.seatIndex);
  }

  if (match.seats.length === 0) {
    match.state = match.state === 'running' ? 'abandoned' : 'abandoned';
    match.endedAt = now;
    return { ok: true, wasHost };
  }
  if (match.state !== 'running') recomputeReadiness(match);
  return { ok: true, wasHost };
}

export function setReady(match: Match, playerId: string, ready: boolean): boolean {
  const seat = seatOf(match, playerId);
  if (!seat || match.state === 'running' || match.state === 'finished' || match.state === 'abandoned') return false;
  seat.ready = ready;
  recomputeReadiness(match);
  return true;
}

/**
 * Starts the match, or explains why not.
 *
 * Every seated player must be ready, not merely most of them: a netplay session
 * that begins while somebody is still loading desynchronises, and on a
 * four-player game that ruins it for everyone rather than the one who was late.
 */
export function startMatch(match: Match, now: number): { ok: true } | { ok: false; reason: string } {
  if (match.state === 'running') return { ok: false, reason: 'already-running' };
  if (match.state !== 'ready') return { ok: false, reason: 'not-ready' };
  if (match.seats.length < match.minPlayers) return { ok: false, reason: 'not-enough-players' };
  match.state = 'running';
  match.startedAt = now;
  return { ok: true };
}

/**
 * Records how it ended.
 *
 * The source travels with the result and is never inferred. A result reported
 * by a participant's own machine is recorded as exactly that; upgrading it to
 * something stronger is a decision for whatever can actually verify it, made
 * later and explicitly.
 */
export function finishMatch(
  match: Match, result: { winnerPlayerId: string | null; source: ResultSource; evidence?: string | null }, now: number
): { ok: true } | { ok: false; reason: string } {
  if (match.state !== 'running') return { ok: false, reason: 'not-running' };
  if (result.winnerPlayerId !== null && !seatOf(match, result.winnerPlayerId)) {
    return { ok: false, reason: 'winner-not-in-match' };
  }
  match.state = 'finished';
  match.endedAt = now;
  match.result = {
    winnerPlayerId: result.winnerPlayerId,
    source: result.source,
    recordedAt: now,
    evidence: result.evidence ?? null
  };
  return { ok: true };
}

/** Ready means every seat ready and enough of them. Recomputed, never set directly. */
function recomputeReadiness(match: Match): void {
  if (match.state === 'running' || match.state === 'finished' || match.state === 'abandoned') return;
  const everyoneReady = match.seats.length >= match.minPlayers && match.seats.every((seat) => seat.ready);
  match.state = everyoneReady ? 'ready' : 'forming';
}
