import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

void test('the future, PS2, Xbox, and GameCube rooms have visible barriers, collision, and approach notifications', async () => {
  const arcade = await readFile(path.resolve(process.cwd(), 'arcade.js'), 'utf8');
  const edge = await readFile(path.resolve(process.cwd(), 'cloudflare/src/index.ts'), 'utf8');

  assert.match(arcade, /constructionTapeTexture/);
  assert.match(arcade, /futureConstructionBarrier\.userData\.roomName='Future Console'/);
  assert.match(arcade, /xboxConstructionBarrier\.userData\.roomName='Xbox'/);
  assert.match(arcade, /ps2ConstructionBarrier\.userData\.roomName='PS2'/);
  assert.match(arcade, /gamecubeConstructionBarrier\.userData\.roomName='GameCube'/);
  assert.match(arcade, /const ps2CabinetLayout=\[\[1,-29\.2,-30/);
  assert.match(arcade, /addRoomSign\('PS2 ROOM'/);
  assert.match(arcade, /addRoomSign\('GAMECUBE ROOM'/);
  assert.match(arcade, /playerPosition\.z>13\.2&&Math\.abs\(playerPosition\.x\)<2\.5/);
  assert.match(arcade, /const gamecubeCabinetLayout=/);
  assert.match(arcade, /nearbyConstructionRoom\(\)/);
  assert.match(arcade, /Room Under Construction\./);
  assert.match(arcade, /const minimumZ=wallX===PLAYSTATION_WALL_X\?PS2_ROOM_BACK_Z:-16\.8/);
  assert.match(edge, /PARTITION_WALL_X = 14/);
  assert.match(edge, /PLAYABLE_ROOM_DOOR_Z = -8/);
  assert.match(edge, /PS2_ROOM_DOOR_Z = -16\.8/);
  assert.match(edge, /Math\.abs\(crossingZ - PLAYABLE_ROOM_DOOR_Z\)/);
  assert.match(edge, /fromZ - PS2_ROOM_DOOR_Z/);
});
