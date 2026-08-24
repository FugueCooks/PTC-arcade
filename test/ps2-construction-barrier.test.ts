import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

void test('the PS2 and Xbox rooms have visible barriers, collision, and approach notifications', async () => {
  const arcade = await readFile(path.resolve(process.cwd(), 'arcade.js'), 'utf8');
  const edge = await readFile(path.resolve(process.cwd(), 'cloudflare/src/index.ts'), 'utf8');

  assert.match(arcade, /constructionTapeTexture/);
  assert.match(arcade, /for\(const wallX of \[PLAYSTATION_WALL_X,N64_WALL_X\]\)/);
  assert.match(arcade, /wallX<0\?'PS2':'Xbox'/);
  assert.match(arcade, /nearbyConstructionRoom\(\)/);
  assert.match(arcade, /Room Under Construction\./);
  assert.match(arcade, /const wallHalfLength=16\.8/);
  assert.match(edge, /PS2_ROOM_BOUNDARY_X = -14/);
  assert.match(edge, /XBOX_ROOM_BOUNDARY_X = 14/);
  assert.match(edge, /player\.p\[0\] >= PS2_ROOM_BOUNDARY_X/);
  assert.match(edge, /player\.p\[0\] <= XBOX_ROOM_BOUNDARY_X/);
});
