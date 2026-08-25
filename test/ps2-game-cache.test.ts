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

void test('the arcade loads hosted games cache first and prefetches only the runtime', async () => {
  const arcade = await readFile(path.resolve(process.cwd(), 'arcade.js'), 'utf8');

  // The first launch downloads through the cache so the bytes are kept, and
  // the launch prefers whatever that returned over the hosted URL.
  assert.match(arcade, /prepareHostedGame\(cabinet\)/);
  assert.match(arcade, /launchEmulator\(prepared\|\|cabinet\.hostedGame\)/);
  // A failed or oversized cache write must still leave the game playable.
  assert.match(arcade, /STREAMING FROM CDN/);
  // Progress is surfaced while the download runs, not just a static size.
  assert.match(arcade, /DOWNLOADING \$\{Math\.floor\(progress\*100\)}%/);
  assert.match(arcade, /formatRate/);
  assert.match(arcade, /formatEta/);

  // Warming is driven by cabinet proximity and covers every hosted system.
  assert.match(arcade, /warmEmulatorCore\(near\?\.system\)/);
  assert.match(arcade, /\['emulators\/play\/Play\.wasm','fetch'\]/);
  assert.match(arcade, /cdn\.emulatorjs\.org\/stable\/data\/loader\.js/);
  assert.match(arcade, /emulators\/gecko\/pkg\/web_bg\.wasm/);
  // The runtime is prefetched; the multi hundred megabyte image never is.
  assert.doesNotMatch(arcade, /link\.href=cabinet\.hostedGame/);
});
