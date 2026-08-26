import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

void test('the PS2 local cache is explicit, quota-aware, and removes partial downloads', async () => {
  const cache = await readFile(path.resolve(process.cwd(), 'games/ps2-game-cache.js'), 'utf8');
  assert.match(cache, /navigator\.storage\.persist\?\.\(\)/);
  assert.match(cache, /navigator\.storage\.estimate\?\.\(\)/);
  assert.match(cache, /game\.sizeBytes \+ STORAGE_HEADROOM_BYTES/);
  assert.match(cache, /fetch\(url, \{ credentials: 'omit', signal \}\)/);
  assert.match(cache, /await writable\.write\(value\)/);
  assert.match(cache, /file\.size !== game\.sizeBytes/);
  assert.match(cache, /await directory\.removeEntry\(name\)/);
});

void test('the arcade uses a cached game when present and otherwise streams immediately', async () => {
  const arcade = await readFile(path.resolve(process.cwd(), 'arcade.js'), 'utf8');

  // PLAY performs only a cache lookup. A cache miss launches the hosted URL so
  // range-capable emulators can boot without first downloading the whole disc.
  assert.match(arcade, /resolveCachedHostedGame\(cabinet\)/);
  assert.match(arcade, /return await ps2Cache\.get\(descriptor\)/);
  assert.match(arcade, /launchEmulator\(prepared\|\|cabinet\.hostedGame\)/);
  const resolver = arcade.slice(arcade.indexOf('async function resolveCachedHostedGame'), arcade.indexOf("document.querySelector('#play-hosted-game')"));
  assert.doesNotMatch(resolver, /ps2Cache\.download/);
  // A full local download remains an explicit action with visible progress.
  assert.match(arcade, /ps2CacheButton\.addEventListener\('click'[\s\S]*?ps2Cache\.download/);
  assert.match(arcade, /CACHING \$\{percent\}%/);

  // Warming is still driven by cabinet proximity, but each adapter now owns the
  // list of runtime assets to prefetch for its own core.
  assert.match(arcade, /warmEmulatorCore\(near\)/);
  const [emulatorJs, play, gecko] = await Promise.all([
    readFile(path.resolve(process.cwd(), 'emulators/adapters/emulatorjs-adapter.js'), 'utf8'),
    readFile(path.resolve(process.cwd(), 'emulators/adapters/play-ps2-adapter.js'), 'utf8'),
    readFile(path.resolve(process.cwd(), 'emulators/adapters/gecko-gamecube-adapter.js'), 'utf8')
  ]);
  assert.match(play, /'emulators\/play\/Play\.wasm', 'fetch'/);
  assert.match(emulatorJs, /cdn\.emulatorjs\.org\/stable\/data\/loader\.js/);
  assert.match(gecko, /emulators\/gecko\/pkg\/web_bg\.wasm/);
  // The runtime is prefetched; the multi hundred megabyte image never is.
  assert.doesNotMatch(arcade, /link\.href=cabinet\.hostedGame/);
});
