import assert from 'node:assert/strict';
import test from 'node:test';
import { CabinetIndex } from '../server/src/cabinets/cabinet-index.js';
import { CABINET_REGISTRY } from '../server/src/cabinets/cabinet-registry.js';
import { CabinetStateSynchronizer } from '../server/src/cabinets/cabinet-state-sync.js';
import { GameRegistryService } from '../server/src/games/game-registry-service.js';
import type { CabinetState } from '../server/src/protocol.js';

void test('legacy cabinet registry normalizes into emulator-independent domain definitions', () => {
  const cabinet = CABINET_REGISTRY.find(({ id }) => id === 'crash-bandicoot');
  assert.equal(cabinet?.gameId, 'crash-bandicoot');
  assert.equal(cabinet?.zoneId, 'playstation-room');
  assert.equal(cabinet?.cabinetType, 'themed-upright');
  assert.equal(cabinet?.interactionPolicy, 'standard');
  assert.equal('g' in (cabinet ?? {}), false);
});

void test('game registry resolves stable game and adapter IDs without inspecting extensions', () => {
  const games = new GameRegistryService();
  const game = games.get('crash-bandicoot');
  assert.equal(game?.platformId, 'psx');
  assert.equal(game?.launcherAdapterId, 'browser-local');
  assert.equal(game?.emulatorAdapterId, 'legacy-browser-emulator');
  assert.equal(game?.replayCapability, 'INPUT_LOG');
  assert.equal(games.forLegacyCabinet('crash-bandicoot')?.id, game?.id);
});

void test('cabinet index supports ID, zone, game, type, and nearby lookups', () => {
  const index = new CabinetIndex(CABINET_REGISTRY, { cellSize: 6 });
  const cabinet = index.get('crash-bandicoot');
  assert.ok(cabinet);
  assert.ok(index.inZone('playstation-room').includes(cabinet));
  assert.ok(index.forGame('crash-bandicoot').includes(cabinet));
  assert.ok(index.ofType('themed-upright').includes(cabinet));
  assert.ok(index.nearby(cabinet.interactionPosition, 0.2).includes(cabinet));
});

void test('revisioned cabinet deltas detect their predecessor and snapshots remain zone scoped', () => {
  const sync = new CabinetStateSynchronizer();
  const state: CabinetState = { cabinetId: 'crash-bandicoot', occupiedByPlayerId: null, occupiedByDisplayName: null,
    status: 'available', reservedAt: null, sessionStartedAt: null };
  const states = new Map([[state.cabinetId, state]]);
  const snapshot = sync.snapshot('room-a', 'playstation-room', CABINET_REGISTRY, states);
  const delta = sync.changed('room-a', 'playstation-room', { ...state, status: 'reserved' });
  assert.equal(snapshot.revision, 0);
  assert.equal(snapshot.cabinets.every((candidate) => CABINET_REGISTRY.find(({ id }) => id === candidate.cabinetId)?.zoneId === 'playstation-room'), true);
  assert.deepEqual([delta.previousRevision, delta.revision], [0, 1]);
});
