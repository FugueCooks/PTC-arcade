import assert from 'node:assert/strict';
import test from 'node:test';
import { PlayerManager } from '../server/src/players/player-manager.js';
import { RoomManager } from '../server/src/rooms/room-manager.js';

const identity = { displayName: 'PLAYER ONE', avatarId: 'neon-capsule' };

function createPlayers(): PlayerManager {
  return new PlayerManager(new RoomManager());
}

void test('players receive separate spawn locations in the default room', () => {
  const players = createPlayers();
  const first = players.join('socket-a', 'main', undefined, identity, 1_000);
  const second = players.join('socket-b', 'main', undefined, identity, 1_000);

  assert.notDeepEqual(first.player.p, second.player.p);
  assert.equal(second.snapshot.players.length, 2);
});

void test('server rejects movement packets that arrive too fast, leave bounds, or exceed speed', () => {
  const players = createPlayers();
  players.join('socket-a', 'main', undefined, identity, 1_000);

  assert.equal(players.move('socket-a', { p: [0.1, 11], r: 0 }, 1_020), undefined);
  assert.equal(players.move('socket-a', { p: [28, 11], r: 0 }, 1_100), undefined);
  assert.equal(players.move('socket-a', { p: [8, 11], r: 0 }, 1_100), undefined);
  assert.deepEqual(players.move('socket-a', { p: [0.3, 11], r: 0 }, 1_100)?.p, [0.3, 1.65, 11]);
});

void test('authoritative movement bounds include the Nintendo 64 expansion room', () => {
  const players = createPlayers();
  players.join('socket-a', 'main', undefined, identity, 1_000);
  for (let x = 3; x <= 27; x += 3) {
    assert.deepEqual(players.move('socket-a', { p: [x, 11], r: 0 }, 1_000 + x / 3 * 500)?.p, [x, 1.65, 11]);
  }
  assert.equal(players.move('socket-a', { p: [28, 11], r: 0 }, 6_000), undefined);
});

void test('a stationary accepted update returns a player to idle', () => {
  const players = createPlayers();
  players.join('socket-a', 'main', undefined, identity, 1_000);

  assert.equal(players.move('socket-a', { p: [0.3, 11], r: 0 }, 1_100)?.a, 'walk');
  assert.equal(players.move('socket-a', { p: [0.3, 11], r: 0 }, 1_200)?.a, 'idle');
});

void test('a short reconnect restores the same player and a stale player is cleaned up', () => {
  const players = createPlayers();
  const first = players.join('socket-a', 'main', undefined, identity, 1_000);
  players.disconnect('socket-a', 1_100);
  const resumed = players.join('socket-b', 'main', first.resumeToken, identity, 5_000);

  assert.equal(resumed.resumed, true);
  assert.equal(resumed.player.id, first.player.id);
  assert.equal(resumed.player.n, identity.displayName);
  assert.equal(resumed.player.v, identity.avatarId);
  players.disconnect('socket-b', 5_100);
  players.sweep(16_000);
  assert.equal(players.snapshotFor('socket-b'), undefined);
});

void test('avatar identity is included in room player state', () => {
  const players = createPlayers();
  const first = players.join('socket-a', 'main', undefined, { displayName: 'NEON KID', avatarId: 'neon-capsule' }, 1_000);
  const second = players.join('socket-b', 'main', undefined, { displayName: 'PLAYER TWO', avatarId: 'extreme-gundam' }, 1_000);

  assert.deepEqual(second.snapshot.players.map(({ n, v }) => ({ n, v })), [
    { n: first.player.n, v: first.player.v },
    { n: 'PLAYER TWO', v: 'extreme-gundam' }
  ]);
});

void test('player lifecycle events stay centralized in PlayerManager', () => {
  const players = createPlayers();
  const events: string[] = [];
  players.subscribe((event) => events.push(event.type));
  const joined = players.join('socket-a', 'main', undefined, identity, 1_000);
  players.move('socket-a', { p: [0.3, 11], r: 0 }, 1_100);
  players.disconnect('socket-a', 1_200);
  players.join('socket-b', 'main', joined.resumeToken, identity, 1_500);

  assert.deepEqual(events, ['PlayerJoined', 'PlayerMoved', 'PlayerDisconnected', 'PlayerReconnected']);
});
