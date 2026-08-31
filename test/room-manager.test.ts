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

void test('every room off the hall is walkable, the tournament hall included', () => {
  // The three east rooms were empty and are deleted: the wall is solid where
  // their doorways were, so the walk along it stays in the hall and the step
  // through the old door at 13.2 is refused.
  const players = createPlayers();
  players.join('socket-a', 'main', undefined, identity, 1_000);
  const route: Array<[number, number]> = [[3, 11], [6, 11], [9, 11], [12, 11], [15, 11], [18, 11], [19.6, 11], [19.6, 13.2]];
  route.forEach(([x, z], index) => assert.ok(players.move('socket-a', { p: [x, z], r: 0 }, 1_500 + index * 500), `step ${index} was refused`));
  assert.equal(players.move('socket-a', { p: [22.5, 13.2], r: 0 }, 9_500), undefined, 'the sealed east wall holds where the old doorway was');

  // The tournament hall is the south approach now: the walk carries on
  // through its doorway to the Temple of Time's own end of the room.
  const south = createPlayers();
  south.join('socket-b', 'main', undefined, identity, 1_000);
  const toTheDoor: Array<[number, number]> = [[0, 14], [0, 17], [0, 20], [0, 23], [0, 26], [0, 29], [0, 32], [0, 35], [0, 38], [0, 41]];
  toTheDoor.forEach(([x, z], index) => assert.ok(south.move('socket-b', { p: [x, z], r: 0 }, 1_500 + index * 500), `step ${index} was refused`));
  assert.equal(south.stateFor('socket-b')?.p[2], 41, 'the tournament hall is walkable');
  assert.equal(south.move('socket-b', { p: [0, 52], r: 0 }, 7_500), undefined, 'its back wall still holds');
});

void test('the MegaMan Room replaces the former front-left construction bay', () => {
  const players = createPlayers();
  players.join('socket-a', 'main', undefined, identity, 1_000);
  const route: Array<[number, number]> = [
    [-3, 11], [-6, 11], [-9, 11], [-12, 11], [-15, 11], [-18, 11], [-19.6, 11], [-19.6, 8],
    [-22.5, 8], [-25.5, 8], [-28.5, 8], [-28.5, 5], [-28.5, 2]
  ];
  route.forEach(([x, z], index) => assert.ok(players.move('socket-a', { p: [x, z], r: -Math.PI / 2 }, 1_500 + index * 500), `step ${index} was refused`));
  // Each room in a column is closed off from the one next to it: every room is
  // entered from the hall, and none of these walls has a doorway.
  assert.equal(players.move('socket-a', { p: [-28.5, -1], r: Math.PI }, 8_500), undefined,
    'the divider must still separate Mega Man from PlayStation');
});

void test('the PS2 room is reached through its own doorway off the hall', () => {
  const players = createPlayers();
  players.join('socket-a', 'main', undefined, identity, 1_000);
  const route: Array<[number, number]> = [
    [-3, 11], [-6, 11], [-9, 11], [-12, 11], [-15, 11], [-18, 11], [-19.6, 11], [-19.6, 8],
    [-19.6, 5], [-19.6, 2], [-19.6, -1], [-19.6, -4], [-19.6, -7], [-19.6, -10], [-19.6, -13],
    [-19.6, -16], [-19.6, -19], [-19.6, -22], [-19.6, -25.2]
  ];
  route.forEach(([x, z], index) => assert.ok(players.move('socket-a', { p: [x, z], r: Math.PI }, 1_500 + index * 500), `step ${index} was refused`));
  assert.ok(players.move('socket-a', { p: [-22.5, -25.2], r: -Math.PI / 2 }, 11_500));
  assert.deepEqual(players.stateFor('socket-a')?.p, [-22.5, 1.65, -25.2]);

  // A metre either side of the doorway is wall.
  const blocked = createPlayers();
  blocked.join('socket-b', 'main', undefined, identity, 1_000);
  const blockedRoute: Array<[number, number]> = [
    [-3, 11], [-6, 11], [-9, 11], [-12, 11], [-15, 11], [-18, 11], [-19.6, 11], [-19.6, 8],
    [-19.6, 5], [-19.6, 2], [-19.6, -1], [-19.6, -4], [-19.6, -7], [-19.6, -10], [-19.6, -13],
    [-19.6, -16], [-19.6, -19], [-19.6, -20]
  ];
  blockedRoute.forEach(([x, z], index) => assert.ok(blocked.move('socket-b', { p: [x, z], r: Math.PI }, 1_500 + index * 500), `blocked step ${index} was refused`));
  assert.equal(blocked.move('socket-b', { p: [-22.5, -20], r: -Math.PI / 2 }, 11_000), undefined,
    'the wall either side of the doorway must still reject movement');
});

void test('the outer wall of the building remains authoritative', () => {
  const players = createPlayers();
  players.join('socket-a', 'main', undefined, identity, 1_000);
  const route: Array<[number, number]> = [
    [-3, 11], [-6, 11], [-9, 11], [-12, 11], [-15, 11], [-18, 11], [-19.6, 11], [-19.6, 8],
    [-22.5, 8], [-25.5, 8], [-28.5, 8], [-31.5, 8], [-34.5, 8], [-37.5, 8], [-40.5, 8], [-42.7, 8]
  ];
  route.forEach(([x, z], index) => assert.ok(players.move('socket-a', { p: [x, z], r: -Math.PI / 2 }, 1_500 + index * 500), `step ${index} was refused`));
  // The step past -42.7 is not a wall any more: Peach's Castle stands there,
  // and CASTLE_EXPANSE (x -119.7..-42.7, z -63..11.8) is walkable floor. The
  // authoritative boundary this test guards is now the castle's own north edge.
  assert.ok(players.move('socket-a', { p: [-44, 8], r: -Math.PI / 2 }, 9_500), 'the castle grounds accept the step west');
  assert.equal(players.move('socket-a', { p: [-44, 13], r: -Math.PI / 2 }, 10_000), undefined, 'north of the castle expanse is still out of bounds');
  assert.deepEqual(players.stateFor('socket-a')?.p, [-44, 1.65, 8]);
});

void test('the partition wall is solid everywhere it has no doorway', () => {
  const players = createPlayers();
  players.join('socket-a', 'main', undefined, identity, 1_000);
  const route: Array<[number, number]> = [[0, 8], [3, 8], [6, 8], [9, 8], [12, 8], [15, 8], [18, 8], [19.6, 8], [19.6, 5], [19.6, 2], [19.6, 0]];
  route.forEach(([x, z], index) => assert.ok(players.move('socket-a', { p: [x, z], r: -Math.PI / 2 }, 1_500 + index * 500), `step ${index} was refused`));
  // z = 0 is the middle of a wall segment on both sides of the hall.
  assert.equal(players.move('socket-a', { p: [22.5, 0], r: -Math.PI / 2 }, 7_000), undefined);
  assert.equal(players.stateFor('socket-a')?.p[0], 19.6);
});

void test('the middle of the hall can be walked straight through', () => {
  // The couch ring and the round glass case both stood here. A player used to
  // be stopped at a radius of 2.07 m from the origin and pushed around a ring
  // at 4.2 m; the floorplan puts open floor under the chandelier instead, so
  // this route crosses the exact centre and comes out the far side.
  const players = createPlayers();
  players.join('socket-a', 'main', undefined, identity, 1_000);
  const steps: Array<[number, number]> = [[3, 11], [6, 11], [6, 8], [6, 5], [6, 2], [5, 0], [4.3, 0], [3, 0], [1.5, 0], [0, 0], [-1.5, 0], [-3, 0]];
  steps.forEach(([x, z], index) => assert.ok(players.move('socket-a', { p: [x, z], r: -Math.PI / 2 }, 1_500 + index * 500), `step ${index} was refused`));
  assert.deepEqual(players.stateFor('socket-a')?.p, [-3, 1.65, 0]);
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
