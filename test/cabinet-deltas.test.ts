import assert from 'node:assert/strict';
import test from 'node:test';
import { CabinetManager, type CabinetEvent } from '../server/src/cabinets/cabinet-manager.js';
import { PlayerManager } from '../server/src/players/player-manager.js';
import { RoomManager } from '../server/src/rooms/room-manager.js';
import { CabinetRevisionTracker, buildZoneSnapshot, hasVisibleChange } from '../server/src/cabinets/cabinet-delta-publisher.js';
import type { CabinetState } from '../server/src/protocol.js';

const identity = { displayName: 'SCALE TESTER', avatarId: 'neon-capsule' };
const quiet = () => undefined;
const roomConfigs = [
  { id: 'main', spawnSeparation: 0.1, spawnPoints: [{ x: -22.5, y: 1.65, z: -3.7, rotationY: Math.PI }, { x: -22.4, y: 1.65, z: -3.7, rotationY: Math.PI }] },
  { id: 'other', spawnSeparation: 0.1, spawnPoints: [{ x: -22.5, y: 1.65, z: -3.7, rotationY: Math.PI }] }
];

function setup() {
  const players = new PlayerManager(new RoomManager(roomConfigs));
  const cabinets = new CabinetManager(players, { requestCooldownMs: 0 }, quiet);
  const events: CabinetEvent[] = [];
  players.subscribe((event) => cabinets.handlePlayerEvent(event));
  cabinets.subscribe((event) => events.push(event));
  return { players, cabinets, events };
}

const state = (overrides: Partial<CabinetState> = {}): CabinetState => ({
  cabinetId: 'c-1', occupiedByPlayerId: null, occupiedByDisplayName: null,
  status: 'available', reservedAt: null, sessionStartedAt: null, ...overrides
});

void test('a room join receives only the zones around the player', () => {
  // Milestone 11.14: never send every cabinet on the platform.
  const { cabinets } = setup();
  const megaman = cabinets.zoneSnapshot('main', ['megaman-room']);
  assert.equal(megaman.cabinets.length, 10);
  assert.deepEqual(megaman.zoneIds, ['megaman-room']);
  assert.ok(megaman.cabinets.length < cabinets.index.size);
  assert.ok(megaman.cabinets.every(({ status }) => status === 'available'));
});

void test('overlapping zones never duplicate a cabinet in one snapshot', () => {
  const { cabinets } = setup();
  const snapshot = cabinets.zoneSnapshot('main', ['megaman-room', 'megaman-room', 'main-floor-west']);
  const ids = snapshot.cabinets.map(({ cabinetId }) => cabinetId);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(snapshot.cabinets.length, 17);
});

void test('state changes publish monotonic revisions', () => {
  const { players, cabinets, events } = setup();
  players.join('a', 'main', undefined, identity, 1_000);
  assert.equal(cabinets.revisionFor('main', 'main-floor-west'), 0);

  assert.equal(cabinets.requestUse('a', 'crash-bandicoot', 2_000).ok, true);
  assert.equal(cabinets.revisionFor('main', 'main-floor-west'), 1);
  assert.equal(cabinets.activate('a', 'crash-bandicoot', 2_100).ok, true);
  assert.equal(cabinets.revisionFor('main', 'main-floor-west'), 2);
  assert.equal(cabinets.release('a', 'crash-bandicoot', 2_200).ok, true);
  assert.equal(cabinets.revisionFor('main', 'main-floor-west'), 3);

  const changes = events.filter((event) => event.type === 'CabinetStateChanged');
  assert.deepEqual(changes.map((event) => event.revision), [1, 2, 3]);
  assert.ok(changes.every((event) => event.zoneId === 'main-floor-west'));
});

void test('a client one revision behind applies the delta; a gap forces resync', () => {
  // Milestone 11.40 tests 21 and 22.
  const tracker = new CabinetRevisionTracker();
  assert.deepEqual(tracker.evaluate(4, 5), { apply: true, resync: null });
  assert.deepEqual(tracker.evaluate(4, 7), { apply: false, resync: 'revision-gap' });
  // With previousRevision the chain is checked directly rather than inferred.
  assert.deepEqual(tracker.evaluate(4, 5, 4), { apply: true, resync: null });
  assert.deepEqual(tracker.evaluate(4, 9, 8), { apply: false, resync: 'revision-gap' });
  assert.deepEqual(tracker.evaluate(4, 3, 2), { apply: false, resync: null }, 'a duplicate is dropped, not resynced');
  // A duplicate delivery is dropped, not treated as a gap.
  assert.deepEqual(tracker.evaluate(4, 4), { apply: false, resync: null });
  assert.deepEqual(tracker.evaluate(4, 2), { apply: false, resync: null });
});

void test('revisions are per room and reset when a room is forgotten', () => {
  const tracker = new CabinetRevisionTracker();
  assert.equal(tracker.bump('main', 'z1').revision, 1);
  assert.equal(tracker.bump('main', 'z1').revision, 2);
  assert.equal(tracker.bump('other', 'z1').revision, 1, 'rooms must not share a revision counter');
  // A change in one zone must not advance another zone's chain.
  assert.equal(tracker.bump('main', 'z2').revision, 1, 'zones must not share a counter either');
  assert.equal(tracker.revisionFor('main', 'z1'), 2);
  tracker.forget('main');
  assert.equal(tracker.revisionFor('main', 'z1'), 0);
  assert.equal(tracker.revisionFor('main', 'z2'), 0);
  assert.equal(tracker.revisionFor('other', 'z1'), 1);
});

void test('unchanged state is never broadcast', () => {
  assert.equal(hasVisibleChange(undefined, state()), true);
  assert.equal(hasVisibleChange(state(), state()), false);
  assert.equal(hasVisibleChange(state(), state({ status: 'reserved' })), true);
  assert.equal(hasVisibleChange(state(), state({ occupiedByDisplayName: 'ANA' })), true);
  assert.equal(hasVisibleChange(state(), state({ sessionStartedAt: 5 })), true);
});

void test('room state holds only cabinets actually in use', () => {
  // Milestone 11.13: active cabinet state is stored separately from the static
  // definitions, so an untouched cabinet costs nothing per room.
  const { players, cabinets } = setup();
  players.join('a', 'main', undefined, identity, 1_000);
  assert.equal(cabinets.activeStateCount('main'), 0, 'joining must not materialize the registry');

  cabinets.requestUse('a', 'crash-bandicoot', 2_000);
  assert.equal(cabinets.activeStateCount('main'), 1);

  cabinets.release('a', 'crash-bandicoot', 2_100);
  assert.equal(cabinets.activeStateCount('main'), 0, 'a released cabinet must stop being tracked');
});

void test('reading a room never materializes state', () => {
  const { cabinets } = setup();
  cabinets.snapshot('main');
  cabinets.zoneSnapshot('main', ['megaman-room']);
  assert.equal(cabinets.activeStateCount('main'), 0);
});

void test('room state stays isolated', () => {
  // Milestone 11.40 test 25.
  const { players, cabinets } = setup();
  players.join('a', 'main', undefined, identity, 1_000);
  players.join('b', 'other', undefined, identity, 1_000);
  assert.equal(cabinets.requestUse('a', 'crash-bandicoot', 2_000).ok, true);

  const mainState = cabinets.snapshot('main').find(({ cabinetId }) => cabinetId === 'crash-bandicoot');
  const otherState = cabinets.snapshot('other').find(({ cabinetId }) => cabinetId === 'crash-bandicoot');
  assert.equal(mainState?.status, 'reserved');
  assert.equal(otherState?.status, 'available', 'one room must not observe another room’s occupancy');
  assert.equal(cabinets.revisionFor('other', 'main-floor-west'), 0);
});

void test('a disconnect releases the held cabinet without scanning the room', () => {
  const { players, cabinets } = setup();
  players.join('a', 'main', undefined, identity, 1_000);
  assert.equal(cabinets.requestUse('a', 'crash-bandicoot', 2_000).ok, true);
  players.removeSocketNow('a');

  const released = cabinets.snapshot('main').find(({ cabinetId }) => cabinetId === 'crash-bandicoot');
  assert.equal(released?.status, 'available');
  assert.equal(released?.occupiedByPlayerId, null);
  assert.equal(cabinets.activeStateCount('main'), 0);
});

void test('nearby lookup goes through the spatial index', () => {
  const { cabinets } = setup();
  // Crash sits at the middle of the PlayStation row, which recentred when the
  // room widened to match every other room in the building.
  const near = cabinets.nearestCabinet(-24.8, -3.7);
  assert.equal(near?.definition.id, 'crash-bandicoot');
  assert.equal(cabinets.nearestCabinet(9_999, 9_999), undefined);
});

void test('forgetting a room clears its state, ownership, and revision', () => {
  const { players, cabinets } = setup();
  players.join('a', 'main', undefined, identity, 1_000);
  cabinets.requestUse('a', 'crash-bandicoot', 2_000);
  assert.ok(cabinets.revisionFor('main', 'main-floor-west') > 0);

  cabinets.forgetRoom('main');
  assert.equal(cabinets.revisionFor('main', 'main-floor-west'), 0);
  assert.equal(cabinets.activeStateCount('main'), 0);
});

void test('buildZoneSnapshot copies state so callers cannot mutate the server view', () => {
  const source = state({ cabinetId: 'c-9', status: 'reserved' });
  const snapshot = buildZoneSnapshot('main', 3, ['z'], () => [source]);
  snapshot.cabinets[0].status = 'available';
  assert.equal(source.status, 'reserved');
  assert.equal(snapshot.revision, 3);
});
