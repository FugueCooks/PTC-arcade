import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

void test('the PS2 room has visible barriers, collision, and an approach notification', async () => {
  const arcade = await readFile(path.resolve(process.cwd(), 'arcade.js'), 'utf8');
  const edge = await readFile(path.resolve(process.cwd(), 'cloudflare/src/index.ts'), 'utf8');

  assert.match(arcade, /constructionTapeTexture/);
  assert.match(arcade, /for\(const z of \[-15\.25,15\.25\]\)/);
  assert.match(arcade, /PS2 Room Under Construction\./);
  assert.match(arcade, /nearPs2ConstructionBarrier\(\)/);
  assert.match(arcade, /wallHalfLength=isPlaystationWall\?16\.8/);
  assert.match(edge, /PS2_ROOM_BOUNDARY_X = -14/);
  assert.match(edge, /player\.p\[0\] >= PS2_ROOM_BOUNDARY_X/);
});
