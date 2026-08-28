import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const root = process.cwd();
const loadJson = async <T>(relative: string): Promise<T> => JSON.parse(await readFile(path.resolve(root, relative), 'utf8')) as T;

type Game = { id: string; file: string; sizeBytes: number; assetRequirements?: Array<{ kind: string; assetId: string; sizeBytes: number | null }> };
type ManifestEntry = { kind: string; file: string; bytes: number; sha256: string };

void test('every hosted game is published at the size the registry claims', async () => {
  // A registry that says 539 MB against a CDN object of 630 MB is not a
  // cosmetic mismatch: the frame checks the size before it will trust a cached
  // image, and the disc reader addresses ranges against it.
  const { games } = await loadJson<{ games: Game[] }>('assets/games/registry.json');
  const manifest = await loadJson<ManifestEntry[]>('deploy/public-assets.manifest.json');
  const published = new Map(manifest.map((entry) => [entry.file, entry]));

  for (const game of games) {
    const entry = published.get(game.file);
    if (!entry) continue; // Not every game is published through the manifest.
    assert.equal(entry.bytes, game.sizeBytes, `${game.id}: manifest says ${entry.bytes}, registry says ${game.sizeBytes}`);
    assert.match(entry.sha256, /^[0-9a-f]{64}$/, `${game.id}: needs a real hash to publish against`);
  }
});

void test('a game and its own asset requirement agree on size', async () => {
  const { games } = await loadJson<{ games: Game[] }>('assets/games/registry.json');
  for (const game of games) {
    const image = game.assetRequirements?.find((asset) => asset.kind === 'game-image' && asset.assetId === game.file);
    if (!image) continue;
    assert.equal(image.sizeBytes, game.sizeBytes, `${game.id}: the game image requirement disagrees with the game`);
  }
});

void test('nothing is published twice under one name', async () => {
  const manifest = await loadJson<ManifestEntry[]>('deploy/public-assets.manifest.json');
  const files = manifest.map((entry) => entry.file);
  assert.equal(new Set(files).size, files.length, 'two manifest entries share a file name');
});

void test('publishing refuses to overwrite a key that holds different bytes', async () => {
  // These objects go out `max-age=31536000, immutable`, so a changed file under
  // an unchanged name never reaches anyone: the edge serves the old copy for a
  // year, and a browser or OPFS store that already has it never asks again.
  // Re-encoding the GameCube images hit exactly this — new sizes in the
  // registry, old bytes on the CDN — which is what the version suffixes in
  // names like `kingdom-hearts-v1.chd` are for.
  const upload = await readFile(path.resolve(root, 'tools/storage-upload.mjs'), 'utf8');
  assert.match(upload, /max-age=31536000, immutable/, 'the long cache is the reason the guard exists');
  assert.match(upload, /existing\.sha256 !== asset\.sha256/);
  assert.match(upload, /already holds different content/);
  assert.match(upload, /STORAGE_FORCE_UPLOAD=1/, 'there has to be a documented way past it');
});
