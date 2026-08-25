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

void test('the temporary construction barrier rejects entry into the Xbox room', () => {
  const players = createPlayers();
  players.join('socket-a', 'main', undefined, identity, 1_000);
  assert.deepEqual(players.move('socket-a', { p: [3, 11], r: 0 }, 1_500)?.p, [3, 1.65, 11]);
  assert.deepEqual(players.move('socket-a', { p: [6, 11], r: 0 }, 2_000)?.p, [6, 1.65, 11]);
  assert.deepEqual(players.move('socket-a', { p: [9, 11], r: 0 }, 2_500)?.p, [9, 1.65, 11]);
  assert.deepEqual(players.move('socket-a', { p: [12, 11], r: 0 }, 3_000)?.p, [12, 1.65, 11]);
  assert.deepEqual(players.move('socket-a', { p: [12, 8], r: 0 }, 3_500)?.p, [12, 1.65, 8]);
  assert.equal(players.move('socket-a', { p: [14.2, 8], r: 0 }, 4_000), undefined);
  assert.equal(players.stateFor('socket-a')?.p[0], 12);
});

void test('the temporary construction barrier keeps the old front-left room reserved for a future console', () => {
  const players = createPlayers();
  players.join('socket-a', 'main', undefined, identity, 1_000);
  assert.deepEqual(players.move('socket-a', { p: [-3, 11], r: 0 }, 1_500)?.p, [-3, 1.65, 11]);
  assert.deepEqual(players.move('socket-a', { p: [-6, 11], r: 0 }, 2_000)?.p, [-6, 1.65, 11]);
  assert.deepEqual(players.move('socket-a', { p: [-9, 11], r: 0 }, 2_500)?.p, [-9, 1.65, 11]);
  assert.deepEqual(players.move('socket-a', { p: [-12, 11], r: 0 }, 3_000)?.p, [-12, 1.65, 11]);
  assert.deepEqual(players.move('socket-a', { p: [-12, 8], r: 0 }, 3_500)?.p, [-12, 1.65, 8]);
  assert.equal(players.move('socket-a', { p: [-14.2, 8], r: -Math.PI / 2 }, 4_000), undefined);
  assert.equal(players.stateFor('socket-a')?.p[0], -12);
});

void test('the new PS2 room can only be approached through PlayStation and remains under construction', () => {
  const players = createPlayers();
  players.join('socket-a', 'main', undefined, identity, 1_000);
  const steps: Array<[number, number]> = [
    [-3, 11], [-6, 11], [-9, 11], [-12, 11], [-12, 8], [-12, 5], [-12, 2], [-12, -1], [-12, -4], [-12, -7],
    [-14.5, -8], [-17.5, -8], [-20.5, -8], [-22.5, -8], [-22.5, -11], [-22.5, -14]
  ];
  steps.forEach(([x, z], index) => assert.ok(players.move('socket-a', { p: [x, z], r: Math.PI }, 1_500 + index * 500)));
  assert.equal(players.move('socket-a', { p: [-22.5, -17], r: Math.PI }, 9_500), undefined);
  assert.equal(players.stateFor('socket-a')?.p[2], -14);
});

void test('the social couch, room walls, rear doorway, and annex divider are authoritative', () => {
  const players = createPlayers();
  players.join('socket-a', 'main', undefined, identity, 1_000);
  assert.deepEqual(players.move('socket-a', { p: [0, 8], r: Math.PI }, 1_500)?.p, [0, 1.65, 8]);
  assert.deepEqual(players.move('socket-a', { p: [0, 5], r: Math.PI }, 2_000)?.p, [0, 1.65, 5]);
  assert.equal(players.move('socket-a', { p: [0, 3.5], r: Math.PI }, 2_500), undefined);
  assert.deepEqual(players.move('socket-a', { p: [3, 5], r: -Math.PI / 2 }, 3_000)?.p, [3, 1.65, 5]);
  assert.deepEqual(players.move('socket-a', { p: [6, 5], r: -Math.PI / 2 }, 3_500)?.p, [6, 1.65, 5]);
  assert.deepEqual(players.move('socket-a', { p: [9, 5], r: -Math.PI / 2 }, 4_000)?.p, [9, 1.65, 5]);
  assert.deepEqual(players.move('socket-a', { p: [12, 5], r: -Math.PI / 2 }, 4_500)?.p, [12, 1.65, 5]);
  assert.equal(players.move('socket-a', { p: [14.2, 5], r: -Math.PI / 2 }, 5_000), undefined);
  assert.deepEqual(players.move('socket-a', { p: [12, 2], r: Math.PI }, 5_500)?.p, [12, 1.65, 2]);
  assert.deepEqual(players.move('socket-a', { p: [12, -1], r: Math.PI }, 6_000)?.p, [12, 1.65, -1]);
  assert.deepEqual(players.move('socket-a', { p: [12, -4], r: Math.PI }, 6_500)?.p, [12, 1.65, -4]);
  assert.deepEqual(players.move('socket-a', { p: [12, -7], r: Math.PI }, 7_000)?.p, [12, 1.65, -7]);
  assert.deepEqual(players.move('socket-a', { p: [14.5, -8], r: -Math.PI / 2 }, 7_500)?.p, [14.5, 1.65, -8]);
  assert.deepEqual(players.move('socket-a', { p: [17.5, -8], r: -Math.PI / 2 }, 8_000)?.p, [17.5, 1.65, -8]);
  assert.deepEqual(players.move('socket-a', { p: [17.5, -4.5], r: 0 }, 8_500)?.p, [17.5, 1.65, -4.5]);
  assert.deepEqual(players.move('socket-a', { p: [17.5, -1], r: 0 }, 9_000)?.p, [17.5, 1.65, -1]);
  assert.equal(players.move('socket-a', { p: [17.5, 1], r: 0 }, 9_500), undefined);
});

void test('the wider social couch has usable side openings while its glass display stays solid', () => {
  const players = createPlayers();
  players.join('socket-a', 'main', undefined, identity, 1_000);
  const steps: Array<[number, number]> = [[3, 11], [6, 11], [6, 8], [6, 5], [6, 2], [5, 0], [4.3, 0], [3, 0], [2.2, 0]];
  steps.forEach(([x, z], index) => assert.ok(players.move('socket-a', { p: [x, z], r: -Math.PI / 2 }, 1_500 + index * 500)));
  assert.equal(players.move('socket-a', { p: [1.8, 0], r: -Math.PI / 2 }, 6_000), undefined);
  assert.deepEqual(players.stateFor('socket-a')?.p, [2.2, 1.65, 0]);
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

void test('reconnect routing remains available for connected players and obeys the configured disconnect grace', () => {
  const players = new PlayerManager(new RoomManager(), 5_000);
  const joined = players.join('socket-a', 'main', undefined, identity, 1_000);
  assert.deepEqual(players.reconnectRoutes(), [{
    playerId: joined.player.id, resumeToken: joined.resumeToken, roomId: 'main', connected: true
  }]);

  players.disconnect('socket-a', 2_000);
  assert.equal(players.reconnectRouteForPlayerId(joined.player.id)?.connected, false);
  assert.equal(players.canResume(joined.resumeToken, 'main', 6_999), true);
  assert.equal(players.canResume(joined.resumeToken, 'main', 7_001), false);
});

void test('a disconnected player can reclaim membership in a room at capacity', () => {
  const rooms = new RoomManager(undefined, 2);
  const players = new PlayerManager(rooms);
  const first = players.join('socket-a', 'main', undefined, identity, 1_000);
  players.join('socket-b', 'main', undefined, identity, 1_000);
  assert.equal(rooms.getDefault().status, 'full');
  players.disconnect('socket-a', 1_100);
  assert.equal(players.canResume(first.resumeToken, 'main', 2_000), true);
  const resumed = players.join('socket-c', 'main', first.resumeToken, identity, 2_000);
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.player.id, first.player.id);
});

void test('a stable authenticated identity replaces its older socket without creating a duplicate avatar', () => {
  const players = createPlayers();
  const first = players.join('socket-a', 'main', undefined, identity, 1_000, 'player-stable-id');
  const replacement = players.join('socket-b', 'main', undefined,
    { displayName: 'UPDATED NAME', avatarId: 'extreme-gundam' }, 2_000, 'player-stable-id');
  assert.equal(first.player.id, 'player-stable-id');
  assert.equal(replacement.resumed, true);
  assert.equal(replacement.replacedSocketId, 'socket-a');
  assert.equal(replacement.snapshot.players.length, 1);
  assert.equal(replacement.player.n, 'UPDATED NAME');
  assert.equal(players.stateFor('socket-a'), undefined);
  assert.equal(players.stateFor('socket-b')?.id, 'player-stable-id');
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
