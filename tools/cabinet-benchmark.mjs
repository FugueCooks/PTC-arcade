#!/usr/bin/env node
/**
 * Milestone 11 performance benchmarks for the cabinet registry.
 *
 * Phase 11 forbids claiming support for a cabinet count without measurements,
 * so these are the measurements. Run after `npm run build`:
 *
 *   node tools/cabinet-benchmark.mjs [--json]
 *
 * What is deliberately NOT measured: rendering thousands of cabinet models.
 * That is not a goal — the goal is holding thousands of definitions while
 * loading and synchronizing only the relevant subset.
 */
import { CabinetIndex } from '../dist/server/src/cabinets/cabinet-index.js';
import { CabinetSpatialIndex } from '../dist/server/src/cabinets/cabinet-spatial-index.js';
import { ZoneRegistry } from '../dist/server/src/cabinets/zone-registry.js';
import { CabinetRevisionTracker, buildZoneSnapshot } from '../dist/server/src/cabinets/cabinet-delta-publisher.js';
import { toCabinetDefinition } from '../dist/server/src/domain/cabinet-definition.js';

const asJson = process.argv.includes('--json');

function syntheticRegistry(count, zones = 20) {
  const definitions = [];
  const perRow = Math.ceil(Math.sqrt(count));
  for (let n = 0; n < count; n += 1) {
    const x = (n % perRow) * 4;
    const z = Math.floor(n / perRow) * 4;
    definitions.push(toCabinetDefinition({
      id: `synthetic-${n}`, name: `Synthetic ${n}`,
      cabinetType: n % 2 === 0 ? 'psx-upright' : 'n64-upright',
      zoneId: `zone-${n % zones}`, gameId: n % 3 === 0 ? null : `game-${n % 50}`,
      enabled: n % 7 !== 0,
      interactionPosition: { x, y: 1.65, z }, playerPosition: { x, y: 1.65, z: z + 0.5 }, playerRotationY: 0
    }));
  }
  return definitions;
}

/** Median of repeated runs: less noise than a mean on a shared runner. */
function measure(label, iterations, run) {
  const samples = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const started = performance.now();
    for (let n = 0; n < iterations; n += 1) run(n);
    samples.push(performance.now() - started);
  }
  samples.sort((left, right) => left - right);
  const totalMs = samples[Math.floor(samples.length / 2)];
  return { label, iterations, totalMs: round(totalMs), perOpUs: round((totalMs * 1_000) / iterations, 4) };
}

const round = (value, places = 3) => Number(value.toFixed(places));

const results = [];
for (const count of [1_000, 5_000, 10_000]) {
  const definitions = syntheticRegistry(count);

  const buildStarted = performance.now();
  const index = new CabinetIndex(definitions);
  const spatial = new CabinetSpatialIndex(definitions);
  const zones = new ZoneRegistry(index);
  const buildMs = round(performance.now() - buildStarted);

  const extent = Math.ceil(Math.sqrt(count)) * 4;
  const scenario = {
    cabinetCount: count,
    zoneCount: zones.size,
    buildMs,
    spatialCells: spatial.cellCount,
    largestBucket: spatial.largestBucket,
    cellsVisitedPerQuery: spatial.cellsVisited(2.6),
    measurements: [
      measure('lookup by id', 100_000, (n) => index.get(`synthetic-${n % count}`)),
      measure('lookup by zone', 100_000, (n) => index.forZone(`zone-${n % 20}`)),
      measure('lookup by game', 100_000, (n) => index.forGame(`game-${n % 50}`)),
      measure('lookup by type', 100_000, (n) => index.forType(n % 2 === 0 ? 'psx-upright' : 'n64-upright')),
      // The per-frame interaction query: the one that used to be a full scan.
      measure('nearby query (2.6m)', 100_000, (n) => spatial.nearest((n * 7) % extent, (n * 13) % extent, 2.6)),
      measure('zone activation', 10_000, (n) => zones.activeZoneIds((n * 7) % extent, (n * 13) % extent)),
      measure('zone snapshot', 1_000, (n) => {
        const zoneId = `zone-${n % 20}`;
        return buildZoneSnapshot('main', n, [zoneId], (id) =>
          index.forZone(id).map(({ id: cabinetId }) => ({
            cabinetId, occupiedByPlayerId: null, occupiedByDisplayName: null,
            status: 'available', reservedAt: null, sessionStartedAt: null
          })));
      }),
      measure('delta revision bump', 100_000, (() => {
        const tracker = new CabinetRevisionTracker();
        return () => tracker.bump('main');
      })())
    ]
  };

  // The comparison that justifies the spatial index at all.
  const scanStarted = performance.now();
  for (let n = 0; n < 10_000; n += 1) {
    const px = (n * 7) % extent, pz = (n * 13) % extent;
    let best = null, bestSquared = Infinity;
    for (const definition of definitions) {
      const dx = definition.interactionPosition.x - px, dz = definition.interactionPosition.z - pz;
      const squared = dx * dx + dz * dz;
      if (squared < bestSquared) { bestSquared = squared; best = definition; }
    }
    if (best === null) throw new Error('unreachable');
  }
  const scanMs = performance.now() - scanStarted;
  const indexed = scenario.measurements.find(({ label }) => label === 'nearby query (2.6m)');
  scenario.fullScanBaseline = {
    label: 'nearby query, full scan (pre-Phase-11)',
    iterations: 10_000,
    totalMs: round(scanMs),
    perOpUs: round((scanMs * 1_000) / 10_000, 4),
    speedup: round((scanMs / 10_000) / (indexed.totalMs / indexed.iterations), 1)
  };
  results.push(scenario);
}

if (asJson) {
  console.log(JSON.stringify({ node: process.version, at: new Date().toISOString(), results }, null, 2));
} else {
  for (const scenario of results) {
    console.log(`\n=== ${scenario.cabinetCount.toLocaleString()} cabinet definitions ===`);
    console.log(`build (index + spatial + zones): ${scenario.buildMs} ms`);
    console.log(`zones: ${scenario.zoneCount}   spatial cells: ${scenario.spatialCells}   largest bucket: ${scenario.largestBucket}   cells visited per query: ${scenario.cellsVisitedPerQuery}`);
    console.log('');
    for (const entry of scenario.measurements) {
      console.log(`  ${entry.label.padEnd(28)} ${String(entry.perOpUs).padStart(9)} us/op  (${entry.iterations.toLocaleString()} ops in ${entry.totalMs} ms)`);
    }
    const baseline = scenario.fullScanBaseline;
    console.log(`  ${baseline.label.padEnd(28)} ${String(baseline.perOpUs).padStart(9)} us/op  -> indexed is ${baseline.speedup}x faster`);
  }
  console.log('');
}
