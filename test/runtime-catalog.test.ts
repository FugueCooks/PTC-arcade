import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildRuntimeCatalog } from '../server/src/runtime/runtime-catalog.js';

const BASE = 'https://cdn.example/arcade/games';

const GAME = Object.freeze({
  id: 'wind-waker', name: 'The Legend of Zelda: The Wind Waker',
  system: 'gamecube', file: 'wind-waker.rvz', sizeBytes: 100, enabled: true
});
const MANIFEST = Object.freeze({ kind: 'game', system: 'gamecube', file: 'wind-waker.rvz', bytes: 100, sha256: 'a'.repeat(64) });

const build = (over: Partial<Parameters<typeof buildRuntimeCatalog>[0]> = {}) => buildRuntimeCatalog({
  games: [GAME], manifest: [MANIFEST], assetBaseUrl: BASE, platforms: ['gamecube'], ...over
});

void test('a game with a digest is published with everything the runtime needs', () => {
  const { entries } = build();
  assert.deepEqual(entries, [{
    gameId: 'wind-waker',
    platformId: 'gamecube',
    displayName: 'The Legend of Zelda: The Wind Waker',
    fileName: 'wind-waker.rvz',
    downloadUrl: 'https://cdn.example/arcade/games/wind-waker.rvz',
    sizeBytes: 100,
    sha256: 'a'.repeat(64)
  }]);
});

void test('a game with no digest is omitted, with a reason', () => {
  // Publishing it would be publishing an unverifiable download.
  const noDigest = build({ manifest: [{ ...MANIFEST, sha256: undefined }] });
  assert.equal(noDigest.entries.length, 0);
  assert.deepEqual(noDigest.omitted, [{ gameId: 'wind-waker', reason: 'no-digest' }]);

  const malformed = build({ manifest: [{ ...MANIFEST, sha256: 'not-a-digest' }] });
  assert.deepEqual(malformed.omitted, [{ gameId: 'wind-waker', reason: 'no-digest' }]);

  const absent = build({ manifest: [] });
  assert.deepEqual(absent.omitted, [{ gameId: 'wind-waker', reason: 'no-manifest-entry' }]);
});

void test('a size disagreement is never resolved by guessing', () => {
  // The manifest and the registry describe different files; there is no safe
  // way to decide which is current, and the digest would then check nothing.
  const { entries, omitted } = build({ manifest: [{ ...MANIFEST, bytes: 999 }] });
  assert.equal(entries.length, 0);
  assert.deepEqual(omitted, [{ gameId: 'wind-waker', reason: 'size-disagreement' }]);
});

void test('only runtime platforms are published', () => {
  const psx = { ...GAME, id: 'crash', system: 'psx', file: 'crash.chd' };
  const { entries } = build({
    games: [GAME, psx],
    manifest: [MANIFEST, { kind: 'game', file: 'crash.chd', bytes: 100, sha256: 'b'.repeat(64) }]
  });
  assert.deepEqual(entries.map((e) => e.gameId), ['wind-waker'], 'the runtime handles GameCube only, today');
});

void test('a disabled game is not offered', () => {
  assert.equal(build({ games: [{ ...GAME, enabled: false }] }).entries.length, 0);
});

void test('a plaintext or unset asset base yields no entry rather than an unusable one', () => {
  // The runtime refuses a plaintext download URL, so publishing one produces a
  // cabinet that works in the browser and not natively, for no visible reason.
  assert.deepEqual(build({ assetBaseUrl: 'http://cdn.example/games' }).omitted, [{ gameId: 'wind-waker', reason: 'no-asset-base-url' }]);
  assert.deepEqual(build({ assetBaseUrl: '   ' }).omitted, [{ gameId: 'wind-waker', reason: 'no-asset-base-url' }]);
  assert.equal(build({ assetBaseUrl: `${BASE}///` }).entries[0].downloadUrl, 'https://cdn.example/arcade/games/wind-waker.rvz');
});

void test('every shipped GameCube game can actually be published', async () => {
  // The catalogue is built from the real registry and the real upload manifest.
  // If a GameCube cabinet exists whose image was uploaded without a digest, the
  // runtime cannot run it, and this is where that shows up — not at a cabinet.
  const root = process.cwd();
  const registry = JSON.parse(await readFile(path.join(root, 'assets/games/registry.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(path.join(root, 'deploy/remote-gamecube-assets.json'), 'utf8'));

  const { entries, omitted } = buildRuntimeCatalog({
    games: registry.games, manifest, assetBaseUrl: BASE, platforms: ['gamecube']
  });

  const shippedGameCube = registry.games.filter((g: any) => g.system === 'gamecube' && g.enabled);
  assert.ok(shippedGameCube.length > 0, 'the arcade must still ship GameCube cabinets');
  assert.deepEqual(omitted, [], `every GameCube game needs a digest; omitted: ${JSON.stringify(omitted)}`);
  assert.equal(entries.length, shippedGameCube.length);
  for (const entry of entries) assert.match(entry.sha256, /^[0-9a-f]{64}$/);
});
