import assert from 'node:assert/strict';
import test from 'node:test';
import { MatchManager, type MatchEvent } from '../server/src/matches/match-manager.js';

const MELEE = { maxPlayers: 4, minPlayers: 2 };
const CABINET = 'gamecube-cabinet-04';
const ROOM = 'main';

function manager() {
  let clock = 1_000;
  const events: MatchEvent[] = [];
  const matches = new MatchManager({ now: () => (clock += 1) });
  matches.subscribe((event) => events.push(event));
  return { matches, events };
}

const near = (n: number) => ({ playerId: `p${n}`, displayName: `PLAYER_${n}`, distance: 1 });

void test('the cabinet owner hosts, and three more join the match', () => {
  // One player owns the machine, as before. The other three join the game at
  // it — which is also how an arcade works.
  const { matches, events } = manager();
  const opened = matches.open(ROOM, CABINET, 'super-smash-bros-melee', { playerId: 'p1', displayName: 'PLAYER_1' }, MELEE);
  assert.equal(opened.ok, true);
  assert.equal(opened.ok && opened.view.hostPlayerId, 'p1');

  for (const n of [2, 3, 4]) assert.equal(matches.join(ROOM, CABINET, near(n)).ok, true);
  const view = matches.view(ROOM, CABINET)!;
  assert.equal(view.seats.length, 4);
  assert.deepEqual(view.seats.map((s) => s.playerId), ['p1', 'p2', 'p3', 'p4']);
  assert.equal(events[0].type, 'MatchOpened');
});

void test('a fifth player is refused', () => {
  const { matches } = manager();
  matches.open(ROOM, CABINET, 'super-smash-bros-melee', { playerId: 'p1', displayName: 'PLAYER_1' }, MELEE);
  for (const n of [2, 3, 4]) matches.join(ROOM, CABINET, near(n));
  assert.deepEqual(matches.join(ROOM, CABINET, near(5)), { ok: false, reason: 'match-full' });
});

void test('joining from across the room is refused', () => {
  // A seat taken from thirty metres away is a seat nobody standing at the
  // cabinet could see being taken.
  const { matches } = manager();
  matches.open(ROOM, CABINET, 'super-smash-bros-melee', { playerId: 'p1', displayName: 'PLAYER_1' }, MELEE);
  const far = { playerId: 'p2', displayName: 'PLAYER_2', distance: 30 };
  assert.deepEqual(matches.join(ROOM, CABINET, far), { ok: false, reason: 'too-far' });
});

void test('a player cannot be in two matches at once', () => {
  const { matches } = manager();
  matches.open(ROOM, CABINET, 'super-smash-bros-melee', { playerId: 'p1', displayName: 'PLAYER_1' }, MELEE);
  matches.open(ROOM, 'gamecube-cabinet-05', 'super-mario-sunshine', { playerId: 'p2', displayName: 'PLAYER_2' }, { maxPlayers: 1 });

  assert.deepEqual(matches.join(ROOM, CABINET, near(2)), { ok: false, reason: 'player-elsewhere' });
  const second = matches.open(ROOM, 'gamecube-cabinet-01', 'pikmin', { playerId: 'p1', displayName: 'PLAYER_1' }, { maxPlayers: 1 });
  assert.equal(second.ok, false);
});

void test('two rooms hold the same cabinet independently', () => {
  // Cabinet state is per-room, and matches have to be too, or one room's game
  // would fill the other's cabinet.
  const { matches } = manager();
  assert.equal(matches.open(ROOM, CABINET, 'melee', { playerId: 'p1', displayName: 'A' }, MELEE).ok, true);
  assert.equal(matches.open('main-2', CABINET, 'melee', { playerId: 'p2', displayName: 'B' }, MELEE).ok, true);
  assert.equal(matches.size, 2);
  assert.equal(matches.viewsForRoom(ROOM).length, 1);
});

void test('only the host starts, and only when everyone is ready', () => {
  const { matches } = manager();
  matches.open(ROOM, CABINET, 'melee', { playerId: 'p1', displayName: 'PLAYER_1' }, MELEE);
  matches.join(ROOM, CABINET, near(2));

  assert.deepEqual(matches.start(ROOM, 'p2'), { ok: false, reason: 'not-host' });
  assert.deepEqual(matches.start(ROOM, 'p1'), { ok: false, reason: 'not-ready' });

  matches.ready(ROOM, 'p1', true);
  matches.ready(ROOM, 'p2', true);
  assert.equal(matches.start(ROOM, 'p1').ok, true);
  assert.equal(matches.view(ROOM, CABINET)?.state, 'running');
});

void test('a host who leaves hands the cabinet match to the next player', () => {
  const { matches } = manager();
  matches.open(ROOM, CABINET, 'melee', { playerId: 'p1', displayName: 'PLAYER_1' }, MELEE);
  matches.join(ROOM, CABINET, near(2));
  matches.join(ROOM, CABINET, near(3));

  assert.deepEqual(matches.leave(ROOM, 'p1'), { ok: true, closed: false });
  assert.equal(matches.view(ROOM, CABINET)?.hostPlayerId, 'p2');
});

void test('the last player leaving closes the match', () => {
  const { matches, events } = manager();
  matches.open(ROOM, CABINET, 'melee', { playerId: 'p1', displayName: 'PLAYER_1' }, MELEE);
  assert.deepEqual(matches.leave(ROOM, 'p1'), { ok: true, closed: true });
  assert.equal(matches.view(ROOM, CABINET), null);
  assert.equal(events.at(-1)?.type, 'MatchClosed');
});

void test('leaving frees the player to join elsewhere', () => {
  // Disconnects run through the same path, so a stale index entry here would
  // lock a player out of every cabinet until the server restarted.
  const { matches } = manager();
  matches.open(ROOM, CABINET, 'melee', { playerId: 'p1', displayName: 'PLAYER_1' }, MELEE);
  matches.join(ROOM, CABINET, near(2));
  matches.leave(ROOM, 'p2');
  assert.equal(matches.open(ROOM, 'gamecube-cabinet-01', 'pikmin', { playerId: 'p2', displayName: 'PLAYER_2' }, { maxPlayers: 1 }).ok, true);
});

void test('closing a cabinet frees everyone seated at it', () => {
  const { matches } = manager();
  matches.open(ROOM, CABINET, 'melee', { playerId: 'p1', displayName: 'PLAYER_1' }, MELEE);
  matches.join(ROOM, CABINET, near(2));
  assert.equal(matches.close(ROOM, CABINET), true);

  // Both must be able to start something new; a leaked index entry would be
  // invisible until a player found themselves unable to play anything.
  assert.equal(matches.open(ROOM, 'gamecube-cabinet-01', 'pikmin', { playerId: 'p1', displayName: 'A' }, { maxPlayers: 1 }).ok, true);
  assert.equal(matches.open(ROOM, 'gamecube-cabinet-02', 'wind-waker', { playerId: 'p2', displayName: 'B' }, { maxPlayers: 1 }).ok, true);
});

void test('a result is stored with the source it was given, never upgraded', () => {
  const { matches } = manager();
  matches.open(ROOM, CABINET, 'melee', { playerId: 'p1', displayName: 'PLAYER_1' }, MELEE);
  matches.join(ROOM, CABINET, near(2));
  matches.ready(ROOM, 'p1', true);
  matches.ready(ROOM, 'p2', true);
  matches.start(ROOM, 'p1');

  const finished = matches.finish(ROOM, CABINET, { winnerPlayerId: 'p2', source: 'client-reported' });
  assert.equal(finished.ok, true);
  const view = matches.view(ROOM, CABINET)!;
  assert.deepEqual(view.result, { winnerPlayerId: 'p2', source: 'client-reported' });
});

void test('a match that never started cannot be given a result', () => {
  const { matches } = manager();
  matches.open(ROOM, CABINET, 'melee', { playerId: 'p1', displayName: 'PLAYER_1' }, MELEE);
  assert.equal(matches.finish(ROOM, CABINET, { winnerPlayerId: 'p1', source: 'verified' }).ok, false);
});

void test('the view carries seats and nothing internal', () => {
  const { matches } = manager();
  const opened = matches.open(ROOM, CABINET, 'melee', { playerId: 'p1', displayName: 'PLAYER_1' }, MELEE);
  assert.ok(opened.ok);
  const serialized = JSON.stringify(opened.ok && opened.view);
  for (const internal of ['joinedAt', 'createdAt', 'startedAt', 'endedAt', 'evidence']) {
    assert.ok(!serialized.includes(internal), `the view must not carry ${internal}`);
  }
});

void test('a subscriber that throws does not stop the others', () => {
  const matches = new MatchManager();
  const seen: string[] = [];
  matches.subscribe(() => { throw new Error('bad subscriber'); });
  matches.subscribe((event) => seen.push(event.type));
  matches.open(ROOM, CABINET, 'melee', { playerId: 'p1', displayName: 'PLAYER_1' }, MELEE);
  assert.deepEqual(seen, ['MatchOpened']);
});

void test('a single-player game runs through the same lifecycle', () => {
  // No separate path for solo, so a game that later gains a second seat needs
  // no new code to support it.
  const { matches } = manager();
  matches.open(ROOM, 'megaman-cabinet-01', 'mega-man-x', { playerId: 'p1', displayName: 'PLAYER_1' }, { maxPlayers: 1 });
  matches.ready(ROOM, 'p1', true);
  assert.equal(matches.start(ROOM, 'p1').ok, true);
  assert.equal(matches.view(ROOM, 'megaman-cabinet-01')?.state, 'running');
});
