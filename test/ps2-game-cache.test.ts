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

void test('the arcade prefers a cached file and prefetches only the emulator runtime', async () => {
  const arcade = await readFile(path.resolve(process.cwd(), 'arcade.js'), 'utf8');
  assert.match(arcade, /launchEmulator\(cached\|\|cabinet\.hostedGame\)/);
  assert.match(arcade, /CACHING \$\{percent\}%/);
  // Warming is driven by cabinet proximity and now covers every hosted system,
  // not just PS2.
  assert.match(arcade, /warmEmulatorCore\(near\?\.system\)/);
  assert.match(arcade, /\['emulators\/play\/Play\.wasm','fetch'\]/);
  assert.match(arcade, /cdn\.emulatorjs\.org\/stable\/data\/loader\.js/);
  assert.match(arcade, /emulators\/gecko\/pkg\/web_bg\.wasm/);
  // The runtime is prefetched; the multi hundred megabyte game image never is.
  assert.doesNotMatch(arcade, /link\.href=cabinet\.hostedGame/);
});
