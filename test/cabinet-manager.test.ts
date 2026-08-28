import assert from 'node:assert/strict';
import test from 'node:test';
import { CabinetManager } from '../server/src/cabinets/cabinet-manager.js';
import { PlayerManager } from '../server/src/players/player-manager.js';
import { RoomManager } from '../server/src/rooms/room-manager.js';

const identity = { displayName: 'CABINET TESTER', avatarId: 'neon-capsule' };
const quiet = () => undefined;
const roomConfigs = [
  { id: 'main', spawnSeparation: 0.1, spawnPoints: [{ x: -9.5, y: 1.65, z: -5.75, rotationY: Math.PI }, { x: -9.4, y: 1.65, z: -5.75, rotationY: Math.PI }] },
  { id: 'other', spawnSeparation: 0.1, spawnPoints: [{ x: -9.5, y: 1.65, z: -5.75, rotationY: Math.PI }] }
];

function setup(options = {}) {
  const players = new PlayerManager(new RoomManager(roomConfigs));
  const cabinets = new CabinetManager(players, { requestCooldownMs: 0, ...options }, quiet);
  players.subscribe((event) => cabinets.handlePlayerEvent(event));
  return { players, cabinets };
}

void test('the approved registry exposes consolidated console rooms and the MegaMan PlayStation cabinets', () => {
  const { cabinets } = setup();
  const snapshot = cabinets.snapshot('main');
  assert.equal(snapshot.length, 38);
  assert.ok(snapshot.some(({ cabinetId }) => cabinetId === 'pixel-rally'));
  assert.ok(snapshot.some(({ cabinetId }) => cabinetId === 'silent-hill'));
  assert.ok(snapshot.some(({ cabinetId }) => cabinetId === 'metal-gear-solid'));
  assert.ok(snapshot.some(({ cabinetId }) => cabinetId === 'n64-cabinet-07'));
  assert.ok(snapshot.some(({ cabinetId }) => cabinetId === 'psx-back-cabinet-05'));
  assert.ok(snapshot.some(({ cabinetId }) => cabinetId === 'xbox-cabinet-05'));
  assert.ok(snapshot.some(({ cabinetId }) => cabinetId === 'gamecube-cabinet-05'));
  assert.equal(snapshot.filter(({ cabinetId }) => cabinetId.startsWith('megaman-cabinet-')).length, 9);
  assert.ok(!snapshot.some(({ cabinetId }) => cabinetId.startsWith('n64-back-cabinet-')));
  assert.ok(snapshot.every(({ status }) => status === 'available'));
});

void test('only one player wins a cabinet ownership conflict', () => {
  const { players, cabinets } = setup();
  players.join('a', 'main', undefined, identity, 1_000);
  players.join('b', 'main', undefined, identity, 1_000);
  const first = cabinets.requestUse('a', 'crash-bandicoot', 1_100);
  const second = cabinets.requestUse('b', 'crash-bandicoot', 1_100);
  assert.equal(first.ok, true);
  assert.deepEqual(second, { ok: false, reason: 'occupied' });
  assert.equal(cabinets.snapshot('main').find(({ cabinetId }) => cabinetId === 'crash-bandicoot')?.occupiedByPlayerId, first.state?.occupiedByPlayerId);
});

void test('distance and cabinet IDs are validated', () => {
  const players = new PlayerManager(new RoomManager());
  const cabinets = new CabinetManager(players, { requestCooldownMs: 0 }, quiet);
  players.join('a', 'main', undefined, identity, 1_000);
  assert.deepEqual(cabinets.requestUse('a', 'crash-bandicoot', 1_100), { ok: false, reason: 'too-far' });
  assert.deepEqual(cabinets.requestUse('a', 'made-up', 1_200), { ok: false, reason: 'unknown-cabinet' });
  assert.deepEqual(cabinets.requestUse('a', { bad: true }, 1_300), { ok: false, reason: 'invalid-request' });
});

void test('one player cannot own two cabinets and release is safe to repeat', () => {
  const { players, cabinets } = setup();
  players.join('a', 'main', undefined, identity, 1_000);
  assert.equal(cabinets.requestUse('a', 'crash-bandicoot', 1_100).ok, true);
  assert.deepEqual(cabinets.requestUse('a', 'gex-enter-the-gecko', 1_200), { ok: false, reason: 'already-using' });
  assert.equal(cabinets.release('a', 'crash-bandicoot', 1_300).ok, true);
  assert.deepEqual(cabinets.release('a', 'crash-bandicoot', 1_400), { ok: false, reason: 'not-owner' });
});

void test('an unactivated reservation times out and unlocks its player', () => {
  const { players, cabinets } = setup({ activationTimeoutMs: 500 });
  const joined = players.join('a', 'main', undefined, identity, 1_000);
  cabinets.requestUse('a', 'crash-bandicoot', 1_100);
  cabinets.sweep(1_601);
  assert.equal(cabinets.snapshot('main').find(({ cabinetId }) => cabinetId === 'crash-bandicoot')?.status, 'available');
  assert.equal(players.stateForPlayerId(joined.player.id)?.movementLocked, false);
});

void test('disconnect grace preserves ownership, then stale cleanup releases it', () => {
  const { players, cabinets } = setup();
  players.join('a', 'main', undefined, identity, 1_000);
  cabinets.requestUse('a', 'crash-bandicoot', 1_100);
  cabinets.activate('a', 'crash-bandicoot', 1_200);
  players.disconnect('a', 1_300);
  assert.equal(cabinets.snapshot('main').find(({ cabinetId }) => cabinetId === 'crash-bandicoot')?.status, 'in-use');
  players.sweep(11_301);
  assert.equal(cabinets.snapshot('main').find(({ cabinetId }) => cabinetId === 'crash-bandicoot')?.status, 'available');
});

void test('cabinet occupancy is isolated between rooms', () => {
  const { players, cabinets } = setup();
  players.join('a', 'main', undefined, identity, 1_000);
  players.join('b', 'other', undefined, identity, 1_000);
  assert.equal(cabinets.requestUse('a', 'crash-bandicoot', 1_100).ok, true);
  assert.equal(cabinets.requestUse('b', 'crash-bandicoot', 1_100).ok, true);
  assert.equal(cabinets.snapshot('main').find(({ cabinetId }) => cabinetId === 'crash-bandicoot')?.status, 'reserved');
  assert.equal(cabinets.snapshot('other').find(({ cabinetId }) => cabinetId === 'crash-bandicoot')?.status, 'reserved');
});
