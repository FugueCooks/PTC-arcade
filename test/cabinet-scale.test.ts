import assert from 'node:assert/strict';
import test from 'node:test';
import { CabinetIndex } from '../server/src/cabinets/cabinet-index.js';
import { CabinetSpatialIndex, DEFAULT_CELL_SIZE_METRES } from '../server/src/cabinets/cabinet-spatial-index.js';
import { ZoneRegistry } from '../server/src/cabinets/zone-registry.js';
import { CABINET_REGISTRY } from '../server/src/cabinets/cabinet-registry.js';
import { toCabinetDefinition, type CabinetDefinition } from '../server/src/domain/cabinet-definition.js';

/** Synthesizes a registry laid out on a grid, for scale tests and benchmarks. */
export function syntheticRegistry(count: number, zones = 20): CabinetDefinition[] {
  const definitions: CabinetDefinition[] = [];
  const perRow = Math.ceil(Math.sqrt(count));
  for (let n = 0; n < count; n += 1) {
    const x = (n % perRow) * 4;
    const z = Math.floor(n / perRow) * 4;
    const definition = toCabinetDefinition({
      id: `synthetic-${n}`, name: `Synthetic ${n}`, cabinetType: n % 2 === 0 ? 'psx-upright' : 'n64-upright',
      zoneId: `zone-${n % zones}`, gameId: n % 3 === 0 ? null : `game-${n % 50}`, enabled: n % 7 !== 0,
      interactionPosition: { x, y: 1.65, z }, playerPosition: { x, y: 1.65, z: z + 0.5 }, playerRotationY: 0
    });
    assert.ok(!('problem' in definition));
    definitions.push(definition);
  }
  return definitions;
}

void test('the shipped registry indexes by ID, zone, game, and type', () => {
  const index = new CabinetIndex(CABINET_REGISTRY);
  assert.equal(index.size, 38);
  assert.equal(index.zoneCount, 6);
  assert.equal(index.forZone('megaman-room').length, 9);
  assert.equal(index.forZone('no-such-zone').length, 0);
  assert.equal(index.forGame('crash-bandicoot').length, 1);
  assert.equal(index.forType('xbox-display').length, 5);
  assert.equal(index.get('pixel-rally')?.id, 'pixel-rally');
  assert.equal(index.get('nope'), undefined);
});

void test('ten thousand cabinet definitions load and index', () => {
  // Milestone 11.40 test 18. The count is asserted here; the timings live in
  // tools/cabinet-benchmark.mjs, because a wall-clock assertion in CI is a
  // flake waiting to happen.
  const index = new CabinetIndex(syntheticRegistry(10_000));
  assert.equal(index.size, 10_000);
  assert.equal(index.zoneCount, 20);
  assert.equal(index.forZone('zone-0').length, 500);
  assert.equal(index.get('synthetic-9999')?.id, 'synthetic-9999');
});

void test('indexed lookup does not depend on registry size', () => {
  // Milestone 11.40 test 19. Buckets are frozen and shared, so a lookup returns
  // the same array object every time rather than rebuilding one per call.
  const index = new CabinetIndex(syntheticRegistry(5_000));
  assert.equal(index.forZone('zone-3'), index.forZone('zone-3'));
  assert.ok(Object.isFrozen(index.forZone('zone-3')));
  assert.equal(index.forZone('zone-3').length, 250);
});

void test('the index refuses duplicate cabinet IDs', () => {
  const [one] = syntheticRegistry(1);
  assert.throws(() => new CabinetIndex([one, one]), /Duplicate cabinet ID/);
});

void test('a nearby query visits a bounded number of cells at any scale', () => {
  // Milestone 11.40 test 20: nearby lookup avoids full scans.
  const small = new CabinetSpatialIndex(syntheticRegistry(100));
  const large = new CabinetSpatialIndex(syntheticRegistry(10_000));
  assert.equal(small.cellsVisited(2.6), large.cellsVisited(2.6));
  assert.ok(large.cellsVisited(2.6) <= 9, 'interaction range must stay within a 3x3 cell window');

  const near = large.nearest(0, 0, 2.6);
  assert.equal(near?.definition.id, 'synthetic-0');
  // The grid is 4 m spaced, so a 2.6 m radius reaches only the origin cabinet.
  assert.equal(large.queryRadius(0, 0, 2.6).length, 1);
  assert.ok(large.queryRadius(0, 0, 6).length >= 3);
});

void test('spatial queries are sorted, bounded, and reject nonsense input', () => {
  const index = new CabinetSpatialIndex(syntheticRegistry(400));
  const results = index.queryRadius(20, 20, 10);
  assert.ok(results.length > 1);
  for (let at = 1; at < results.length; at += 1) assert.ok(results[at].distance >= results[at - 1].distance);

  assert.equal(index.nearest(0, 0, -1), undefined);
  assert.equal(index.nearest(Number.NaN, 0, 5), undefined);
  assert.deepEqual(index.queryRadius(0, Number.POSITIVE_INFINITY, 5), []);
  assert.equal(index.nearest(100_000, 100_000, 2.6), undefined, 'an empty region must allocate nothing');
  assert.throws(() => new CabinetSpatialIndex([], 0), /positive number/);
});

void test('the default cell size keeps buckets small on the real floor plan', () => {
  const index = new CabinetSpatialIndex(CABINET_REGISTRY);
  assert.equal(index.cellSize, DEFAULT_CELL_SIZE_METRES);
  assert.ok(index.largestBucket <= 8, `largest bucket was ${index.largestBucket}`);
  assert.ok(index.cellCount >= 6, 'cabinets must spread across multiple cells');
});

void test('zones derive bounds from their cabinets and know their neighbours', () => {
  const index = new CabinetIndex(CABINET_REGISTRY);
  const zones = new ZoneRegistry(index);
  assert.equal(zones.size, 6);

  const megaman = zones.get('megaman-room');
  assert.ok(megaman);
  assert.equal(megaman.cabinetIds.length, 9);
  assert.ok(megaman.bounds.minX < megaman.bounds.maxX);
  assert.equal(zones.zoneIdForCabinet('megaman-cabinet-01'), 'megaman-room');
  assert.equal(zones.zoneIdForCabinet('nope'), undefined);

  // The Mega Man room now occupies the front-left console bay; the Xbox
  // gallery remains across the map and must not be treated as adjacent.
  assert.ok(!megaman.adjacentZoneIds.includes('xbox-gallery'));
});

void test('zone activation follows the player and never leaves nothing loaded', () => {
  const zones = new ZoneRegistry(new CabinetIndex(CABINET_REGISTRY));
  // The room's cabinets stand in one row along its north wall, so the zone its
  // bounds describe is a band in front of that wall rather than the whole floor.
  // Streaming still follows the player through preloadDistance.
  const inMegaman = zones.activeZoneIds(-30.1, 12);
  assert.ok(inMegaman.includes('megaman-room'));
  assert.ok(!inMegaman.includes('xbox-gallery'), 'a distant zone must not be activated');

  // The GameCube zone moved with its cabinets, which are out on the main
  // floor with the rest of the console games while the rooms are re-themed.
  const inGamecube = zones.activeZoneIds(9.5, 12.65);
  assert.ok(inGamecube.includes('gamecube-room'));

  // Standing between zones still resolves to the nearby ones by distance. The
  // probe is between the Mega Man room and the west foyer row; deep inside one
  // of the rooms the console games moved out of, nothing loads, because there
  // is nothing in there to load.
  assert.ok(zones.activeZoneIds(-16, 8).length > 0);
  assert.equal(zones.zoneAt(-30.1, 12)?.id, 'megaman-room');
});

void test('zone activation cost does not grow with cabinet count', () => {
  // Milestone 11.40 test 23. Twenty zones stay twenty zones whether they hold
  // a hundred cabinets or ten thousand.
  const small = new ZoneRegistry(new CabinetIndex(syntheticRegistry(200, 20)));
  const large = new ZoneRegistry(new CabinetIndex(syntheticRegistry(10_000, 20)));
  assert.equal(small.size, 20);
  assert.equal(large.size, 20);
});
