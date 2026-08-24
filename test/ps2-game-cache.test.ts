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

void test('the arcade prefers a complete cached PS2 file and prefetches only the emulator core', async () => {
  const arcade = await readFile(path.resolve(process.cwd(), 'arcade.js'), 'utf8');
  assert.match(arcade, /launchEmulator\(cached\|\|cabinet\.hostedGame\)/);
  assert.match(arcade, /CACHING \$\{percent\}%/);
  assert.match(arcade, /if\(near\?\.system==='ps2'\)warmPs2Core\(\)/);
  assert.match(arcade, /\['emulators\/play\/Play\.wasm','fetch'\]/);
  assert.doesNotMatch(arcade, /link\.href=cabinet\.hostedGame/);
});
