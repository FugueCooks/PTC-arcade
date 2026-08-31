import assert from 'node:assert/strict';
import test from 'node:test';
import { GameRegistry, loadGameRegistry } from '../server/src/games/game-registry-service.js';
import { isGameDefinitionIssue, toGameDefinition, type GameDefinition } from '../server/src/domain/game-definition.js';
import { CABINET_REGISTRY } from '../server/src/cabinets/cabinet-registry.js';

const validRow = {
  id: 'test-game', name: 'Test Game', system: 'psx', launcherAdapterId: 'hosted-image',
  emulatorAdapterId: 'emulatorjs', inputProfileId: 'psx-gamepad', replayCapability: 'NONE',
  enabled: true,
  assetRequirements: [{ kind: 'game-image', assetId: 'test-game.chd', sizeBytes: 100, required: true, label: null }]
};

function definition(overrides: Record<string, unknown> = {}): GameDefinition {
  const result = toGameDefinition({ ...validRow, ...overrides });
  assert.ok(!isGameDefinitionIssue(result));
  return result;
}

void test('the shipped game registry loads with adapter identity for every game', () => {
  const { registry, issues } = loadGameRegistry();
  assert.deepEqual(issues, []);
  assert.equal(registry.size, 88);
  assert.ok(registry.all().every((game) => game.emulatorAdapterId !== undefined));
  assert.ok(registry.all().every((game) => game.launcherAdapterId === 'hosted-image'));
  assert.equal(registry.forAdapter('emulatorjs').length, 70);
  assert.equal(registry.forAdapter('play-ps2').length, 11);
  assert.equal(registry.forAdapter('gecko-gamecube').length, 7);
});

void test('a cabinet resolves the correct game through its game ID', () => {
  // Milestone 11.40 test 1, and the 11.2 direction change: the cabinet points at
  // the game, not the other way round.
  const { registry } = loadGameRegistry();
  for (const cabinet of CABINET_REGISTRY) {
    if (cabinet.gameId === null) continue;
    const game = registry.get(cabinet.gameId);
    assert.ok(game, `${cabinet.id} must resolve game ${cabinet.gameId}`);
    assert.equal(game.id, cabinet.gameId);
    // The compatibility view must agree with the new direction.
    assert.equal(registry.forCabinet(cabinet.id)?.id, cabinet.gameId);
  }
});

void test('an unassigned cabinet resolves no game and fails safely', () => {
  // Milestone 11.40 test 4: unknown game fails safely.
  const { registry } = loadGameRegistry();
  const placeholders = CABINET_REGISTRY.filter(({ gameId }) => gameId === null);
  // The Halo stations are deleted. The placeholders now: N64 07, PS2 05,
  // GameCube 03 and the two Dreamcast Adventures standing as display machines
  // in the garden -- cabinets with no game assigned.
  assert.equal(placeholders.length, 5);
  assert.equal(registry.get('no-such-game'), undefined);
  assert.equal(registry.forCabinet('sonic-cabinet-05'), undefined);
  assert.equal(registry.has('no-such-game'), false);
});

void test('a game declares its emulator adapter, so cabinets never choose a core', () => {
  // Milestone 11.40 test 2.
  const { registry } = loadGameRegistry();
  const expected: Record<string, string> = { psx: 'emulatorjs', n64: 'emulatorjs', snes: 'emulatorjs', ps2: 'play-ps2', gamecube: 'gecko-gamecube', gb: 'emulatorjs', gbc: 'emulatorjs', gba: 'emulatorjs', nds: 'emulatorjs', nes: 'emulatorjs', genesis: 'emulatorjs' };
  for (const game of registry.all()) assert.equal(game.emulatorAdapterId, expected[game.platformId]);
});

void test('no shipped game claims replay support it does not have', () => {
  // Milestones 11.4 / 11.20: never claim an unprovided capability. Replay is
  // deferred to Phase 12, so every game must declare NONE.
  const { registry } = loadGameRegistry();
  assert.ok(registry.all().every((game) => game.replayCapability === 'NONE'));
});

void test('multi-disc games declare one asset requirement per disc', () => {
  const { registry } = loadGameRegistry();
  const metalGear = registry.get('metal-gear-solid');
  assert.ok(metalGear);
  const images = metalGear.assetRequirements.filter(({ kind }) => kind === 'game-image');
  assert.equal(images.length, 2);
  assert.equal(images.filter(({ required }) => required).length, 1);
  assert.ok(images.every(({ label }) => typeof label === 'string'));
});

void test('asset requirements refuse path traversal and non-https URLs', () => {
  for (const assetId of ['../../etc/passwd', '/etc/passwd', 'http://insecure.example/rom.bin', 'data:text/plain,x', 'a/b.chd']) {
    const result = toGameDefinition({ ...validRow, assetRequirements: [{ kind: 'game-image', assetId, sizeBytes: 1, required: true, label: null }] });
    assert.ok(isGameDefinitionIssue(result), `${assetId} must be refused`);
  }
  assert.ok(!isGameDefinitionIssue(toGameDefinition({
    ...validRow, assetRequirements: [{ kind: 'bios', assetId: 'https://assets.example/bios.bin', sizeBytes: null, required: false, label: null }]
  })));
});

void test('malformed game rows are rejected with a reason', () => {
  for (const [overrides, expected] of [
    [{ id: 'Bad Id' }, 'id'],
    [{ launcherAdapterId: undefined }, 'launcherAdapterId'],
    [{ inputProfileId: 'Bad Profile' }, 'inputProfileId'],
    [{ replayCapability: 'MAGIC' }, 'replayCapability'],
    [{ enabled: 'yes' }, 'enabled'],
    [{ assetRequirements: 'none' }, 'assetRequirements'],
    [{ assetRequirements: [{ kind: 'unknown-kind', assetId: 'x.chd', sizeBytes: 1, required: true, label: null }] }, 'assetRequirements']
  ] as Array<[Record<string, unknown>, string]>) {
    const result = toGameDefinition({ ...validRow, ...overrides });
    assert.ok(isGameDefinitionIssue(result), `${expected} should be rejected`);
    assert.match(result.problem, new RegExp(expected));
  }
});

void test('the registry rejects duplicate game IDs and indexes by platform', () => {
  assert.throws(() => new GameRegistry([definition(), definition()]), /Duplicate game ID/);
  const registry = new GameRegistry([definition(), definition({ id: 'other-game', system: 'n64', emulatorAdapterId: 'emulatorjs' })]);
  assert.equal(registry.forPlatform('psx').length, 1);
  assert.equal(registry.forPlatform('n64').length, 1);
  assert.equal(registry.forPlatform('saturn').length, 0);
});

void test('disabled games are dropped from the registry', () => {
  const registry = new GameRegistry([definition()]);
  assert.equal(registry.size, 1);
  const { registry: shipped } = loadGameRegistry();
  assert.ok(shipped.all().every((game) => game.enabled));
});
