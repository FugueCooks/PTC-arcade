import assert from 'node:assert/strict';
import test from 'node:test';
import { CABINET_REGISTRY, readCabinetRegistry } from '../server/src/cabinets/cabinet-registry.js';
import { DEFAULT_INTERACTION_POLICY, isCabinetDefinitionIssue, toCabinetDefinition } from '../server/src/domain/cabinet-definition.js';
import { isSafeJsonValue, isSafeMetadata } from '../server/src/domain/json-value.js';

const validRow = {
  id: 'test-cabinet', name: 'Test Cabinet', cabinetType: 'psx-upright', zoneId: 'main-floor-west',
  gameId: 'test-game', enabled: true,
  interactionPosition: { x: 1, y: 2, z: 3 }, playerPosition: { x: 1, y: 2, z: 4 }, playerRotationY: 0
};

void test('the shipped registry maps onto the domain model with zones and types', () => {
  const { definitions, issues } = readCabinetRegistry();
  assert.deepEqual(issues, []);
  assert.equal(definitions.length, 67);
  assert.equal(new Set(definitions.map(({ zoneId }) => zoneId)).size, 8);
  assert.equal(definitions.filter(({ zoneId }) => zoneId === 'megaman-room').length, 9);
  assert.equal(definitions.filter(({ gameId }) => gameId !== null).length, 59);
  assert.ok(definitions.every(({ cabinetType }) => cabinetType.length > 0));
  assert.ok(definitions.every(({ interactionPolicy }) => interactionPolicy.interactionDistance > 0));
});

void test('every cabinet ID survives the Phase 11 migration unchanged', () => {
  // Milestone 11.39: existing cabinet IDs must remain stable.
  const ids = new Set(CABINET_REGISTRY.map(({ id }) => id));
  for (const id of ['pixel-rally', 'silent-hill', 'metal-gear-solid', 'n64-cabinet-07', 'psx-back-cabinet-05', 'xbox-cabinet-05', 'gamecube-cabinet-05']) {
    assert.ok(ids.has(id), `${id} must still exist`);
  }
  assert.equal([...ids].filter((id) => id.startsWith('megaman-cabinet-')).length, 9);
});

void test('a cabinet definition carries no rendering, emulator, or socket state', () => {
  const definition = toCabinetDefinition(validRow);
  assert.ok(!isCabinetDefinitionIssue(definition));
  // Milestone 11.1 forbids Three.js objects, DOM nodes, emulator instances, and
  // socket references in the static definition. The mapper is an allowlist, so
  // anything smuggled into the row is dropped rather than carried through.
  const smuggled = toCabinetDefinition({ ...validRow, sceneObject: { isMesh: true }, emulator: {}, socket: {} });
  assert.ok(!isCabinetDefinitionIssue(smuggled));
  assert.equal(Object.hasOwn(smuggled, 'sceneObject'), false);
  assert.equal(Object.hasOwn(smuggled, 'emulator'), false);
  assert.equal(Object.hasOwn(smuggled, 'socket'), false);
});

void test('a placeholder cabinet models its missing game as null', () => {
  const definition = toCabinetDefinition({ ...validRow, gameId: null });
  assert.ok(!isCabinetDefinitionIssue(definition));
  assert.equal(definition.gameId, null);
});

void test('malformed cabinet rows are reported individually, not thrown on the first', () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ ...validRow, id: 'BAD ID' }, 'id'],
    [{ ...validRow, zoneId: '' }, 'zoneId'],
    [{ ...validRow, cabinetType: 'Not Valid' }, 'cabinetType'],
    [{ ...validRow, interactionPosition: { x: 1, y: 2 } }, 'interactionPosition'],
    [{ ...validRow, playerRotationY: Number.NaN }, 'playerRotationY'],
    [{ ...validRow, enabled: 'yes' }, 'enabled'],
    [{ ...validRow, gameId: 'Bad Game' }, 'gameId'],
    [{ ...validRow, metadata: { fn: 'ok', nested: { deep: true } }, playerRotationY: 0 }, '']
  ];
  for (const [row, expected] of cases) {
    const result = toCabinetDefinition(row);
    if (expected === '') { assert.ok(!isCabinetDefinitionIssue(result)); continue; }
    assert.ok(isCabinetDefinitionIssue(result), `${expected} should be rejected`);
    assert.match(result.problem, new RegExp(expected));
  }
});

void test('interaction policy defaults are applied and out-of-range values rejected', () => {
  const withDefault = toCabinetDefinition(validRow);
  assert.ok(!isCabinetDefinitionIssue(withDefault));
  assert.deepEqual(withDefault.interactionPolicy, DEFAULT_INTERACTION_POLICY);

  const custom = toCabinetDefinition({ ...validRow, interactionPolicy: { interactionDistance: 4, activationTimeoutMs: 1_000, requiresOwnership: false } });
  assert.ok(!isCabinetDefinitionIssue(custom));
  assert.equal(custom.interactionPolicy.interactionDistance, 4);
  assert.equal(custom.interactionPolicy.requiresOwnership, false);

  assert.ok(isCabinetDefinitionIssue(toCabinetDefinition({ ...validRow, interactionPolicy: { interactionDistance: -1 } })));
  assert.ok(isCabinetDefinitionIssue(toCabinetDefinition({ ...validRow, interactionPolicy: { interactionDistance: 1_000 } })));
});

void test('metadata bags reject anything that is not plain JSON', () => {
  assert.ok(isSafeJsonValue({ a: 1, b: [true, null, 'x'] }));
  assert.ok(!isSafeJsonValue(() => undefined));
  assert.ok(!isSafeJsonValue(new Date()));
  assert.ok(!isSafeJsonValue({ n: Number.POSITIVE_INFINITY }));
  assert.ok(!isSafeMetadata([1, 2, 3]));
  assert.ok(isSafeMetadata(undefined));

  // Depth-bounded: a deeply nested bag is refused rather than recursing forever.
  let deep: Record<string, unknown> = { end: true };
  for (let level = 0; level < 12; level += 1) deep = { deep };
  assert.ok(!isSafeJsonValue(deep));

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.ok(!isSafeJsonValue(cyclic));
});
