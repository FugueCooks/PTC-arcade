import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMatch, finishMatch, hostOf, isJoinable, joinMatch, leaveMatch, seatOf, setReady, startMatch
} from '../server/src/domain/match.js';

const melee = () => createMatch('m1', 'gamecube-cabinet-04', 'super-smash-bros-melee', { maxPlayers: 4, minPlayers: 2 }, 1_000);
const player = (n: number) => ({ playerId: `p${n}`, displayName: `PLAYER_${n}` });

/** Seats everyone and marks them ready. */
function seatAll(match: ReturnType<typeof melee>, count: number) {
  for (let index = 1; index <= count; index += 1) {
    assert.equal(joinMatch(match, player(index), 1_000 + index).ok, true);
    setReady(match, `p${index}`, true);
  }
}

void test('four players share one Melee cabinet', () => {
  // The thing the arcade could not previously express: CabinetManager holds one
  // occupant and denies the second with `occupied`.
  const match = melee();
  seatAll(match, 4);
  assert.equal(match.seats.length, 4);
  assert.deepEqual(match.seats.map((s) => s.seatIndex), [0, 1, 2, 3]);
  assert.equal(match.state, 'ready');
  assert.equal(startMatch(match, 2_000).ok, true);
  assert.equal(match.state, 'running');
});

void test('a fifth player is refused rather than squeezed in', () => {
  const match = melee();
  seatAll(match, 4);
  assert.deepEqual(joinMatch(match, player(5), 2_000), { ok: false, reason: 'match-full' });
  assert.equal(isJoinable(match), false);
});

void test('the same player cannot take two seats', () => {
  // Without this, one player could fill a four-seat cabinet alone and hold it.
  const match = melee();
  assert.equal(joinMatch(match, player(1), 1_100).ok, true);
  assert.deepEqual(joinMatch(match, player(1), 1_200), { ok: false, reason: 'already-seated' });
  assert.equal(match.seats.length, 1);
});

void test('seat zero is the host, and stays occupied when the host leaves', () => {
  // Netplay needs one authoritative participant. Deciding it by seat means the
  // server and every client agree on it before any transport is involved.
  const match = melee();
  seatAll(match, 3);
  assert.equal(hostOf(match)?.playerId, 'p1');

  const left = leaveMatch(match, 'p1', 2_000);
  assert.equal(left.wasHost, true);
  assert.equal(hostOf(match)?.playerId, 'p2', 'the longest-seated player takes over');
  assert.equal(match.seats.length, 2);
});

void test('a freed seat is reused, so seat numbers stay inside the cabinet', () => {
  // Otherwise a cabinet six people have cycled through reports seat five of four.
  const match = melee();
  seatAll(match, 4);
  leaveMatch(match, 'p3', 2_000);
  assert.equal(joinMatch(match, player(9), 2_100).ok, true);
  assert.deepEqual(match.seats.map((s) => s.seatIndex), [0, 1, 2, 3]);
  assert.equal(seatOf(match, 'p9')?.seatIndex, 2);
});

void test('a match will not start until everyone seated is ready', () => {
  // A netplay session that begins while somebody is still loading desyncs, and
  // on a four-player game that ruins it for all four.
  const match = melee();
  seatAll(match, 3);
  setReady(match, 'p2', false);
  assert.equal(match.state, 'forming');
  assert.deepEqual(startMatch(match, 2_000), { ok: false, reason: 'not-ready' });

  setReady(match, 'p2', true);
  assert.equal(match.state, 'ready');
  assert.equal(startMatch(match, 2_000).ok, true);
});

void test('a versus game will not start with one player', () => {
  const match = melee();
  assert.equal(joinMatch(match, player(1), 1_100).ok, true);
  setReady(match, 'p1', true);
  assert.equal(match.state, 'forming', 'one ready player is not a two-player match');
  assert.equal(startMatch(match, 2_000).ok, false);
});

void test('a solo cabinet still works through the same model', () => {
  const solo = createMatch('m2', 'megaman-cabinet-01', 'mega-man-x', { maxPlayers: 1 }, 1_000);
  assert.equal(joinMatch(solo, player(1), 1_100).ok, true);
  setReady(solo, 'p1', true);
  assert.equal(startMatch(solo, 1_200).ok, true);
});

void test('nobody joins a running match', () => {
  const match = melee();
  seatAll(match, 2);
  startMatch(match, 2_000);
  assert.deepEqual(joinMatch(match, player(3), 2_100), { ok: false, reason: 'match-started' });
});

void test('the last player leaving ends the match', () => {
  const match = melee();
  seatAll(match, 2);
  leaveMatch(match, 'p1', 2_000);
  leaveMatch(match, 'p2', 2_100);
  assert.equal(match.state, 'abandoned');
  assert.equal(match.endedAt, 2_100);
});

void test('a result records where it came from, and never guesses', () => {
  // A game running on a player's own machine reports its own outcome. That is
  // worth exactly what it sounds like, and anything built on top of the result
  // has to be able to tell that apart from something verified.
  const match = melee();
  seatAll(match, 2);
  startMatch(match, 2_000);

  assert.equal(finishMatch(match, { winnerPlayerId: 'p2', source: 'client-reported' }, 3_000).ok, true);
  assert.equal(match.result?.winnerPlayerId, 'p2');
  assert.equal(match.result?.source, 'client-reported');
  assert.equal(match.state, 'finished');
});

void test('a winner who was never in the match is refused', () => {
  const match = melee();
  seatAll(match, 2);
  startMatch(match, 2_000);
  const bogus = finishMatch(match, { winnerPlayerId: 'p99', source: 'client-reported' }, 3_000);
  assert.deepEqual(bogus, { ok: false, reason: 'winner-not-in-match' });
  assert.equal(match.state, 'running', 'a refused result leaves the match alone');
});

void test('a match that never ran cannot have a result', () => {
  const match = melee();
  seatAll(match, 2);
  assert.deepEqual(finishMatch(match, { winnerPlayerId: 'p1', source: 'operator-confirmed' }, 3_000),
    { ok: false, reason: 'not-running' });
});

void test('a draw is expressible', () => {
  const match = melee();
  seatAll(match, 2);
  startMatch(match, 2_000);
  assert.equal(finishMatch(match, { winnerPlayerId: null, source: 'operator-confirmed', evidence: 'both quit' }, 3_000).ok, true);
  assert.equal(match.result?.winnerPlayerId, null);
  assert.equal(match.result?.evidence, 'both quit');
});

void test('a finished match is finished', () => {
  const match = melee();
  seatAll(match, 2);
  startMatch(match, 2_000);
  finishMatch(match, { winnerPlayerId: 'p1', source: 'verified' }, 3_000);

  assert.equal(finishMatch(match, { winnerPlayerId: 'p2', source: 'client-reported' }, 4_000).ok, false,
    'a result must not be overwritten by a later claim');
  assert.equal(setReady(match, 'p1', true), false);
  assert.equal(joinMatch(match, player(3), 4_000).ok, false);
});
