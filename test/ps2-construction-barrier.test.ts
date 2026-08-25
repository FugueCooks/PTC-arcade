import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

void test('the PS2, Xbox, and GameCube rooms have visible barriers, collision, and approach notifications', async () => {
  const arcade = await readFile(path.resolve(process.cwd(), 'arcade.js'), 'utf8');
  const edge = await readFile(path.resolve(process.cwd(), 'cloudflare/src/index.ts'), 'utf8');

  assert.match(arcade, /constructionTapeTexture/);
  assert.match(arcade, /for\(const wallX of \[PLAYSTATION_WALL_X,N64_WALL_X\]\)/);
  assert.match(arcade, /wallX<0\?'PS2':'Xbox'/);
  assert.match(arcade, /gamecubeConstructionBarrier\.userData\.roomName='GameCube'/);
  assert.match(arcade, /addRoomSign\('GAMECUBE ROOM'/);
  assert.match(arcade, /playerPosition\.z>13\.2&&Math\.abs\(playerPosition\.x\)<2\.5/);
  assert.match(arcade, /const gamecubeCabinetLayout=/);
  assert.match(arcade, /nearbyConstructionRoom\(\)/);
  assert.match(arcade, /Room Under Construction\./);
  assert.match(arcade, /const wallHalfLength=16\.8/);
  assert.match(edge, /PARTITION_WALL_X = 14/);
  assert.match(edge, /PLAYABLE_ROOM_DOOR_Z = -8/);
  assert.match(edge, /Math\.abs\(crossingZ - PLAYABLE_ROOM_DOOR_Z\)/);
});
