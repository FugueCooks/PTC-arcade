import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

void test('the edge worker fronts R2 and caches bounded disc ranges as independent objects', async () => {
  const worker = await readFile(path.resolve(process.cwd(), 'cloudflare/src/index.ts'), 'utf8');
  const config = await readFile(path.resolve(process.cwd(), 'cloudflare/wrangler.jsonc'), 'utf8');

  assert.match(config, /"pattern": "assets\.ptcarcade\.fun\/\*"/);
  assert.match(config, /"binding": "ARCADE_ASSETS"/);
  assert.match(config, /"bucket_name": "retro-arcade-assets"/);
  assert.match(worker, /url\.hostname === 'assets\.ptcarcade\.fun'/);
  assert.match(worker, /MAX_EDGE_CHUNK_BYTES = 8 \* 1024 \* 1024/);
  assert.match(worker, /caches\.default\.match\(cacheKey\)/);
  assert.match(worker, /caches\.default\.put\(cacheKey, cacheable\.clone\(\)\)/);
  assert.match(worker, /x-arcade-edge-cache/);
  assert.match(worker, /\^arcade\\\/\(games\|bios\)\\\//);
  assert.doesNotMatch(worker, /ARCADE_ASSETS\.(put|delete)\(/);
});
