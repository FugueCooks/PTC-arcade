import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

void test('the PS2 doorway is open while Xbox and GameCube retain their barriers', async () => {
  const arcade = await readFile(path.resolve(process.cwd(), 'arcade.js'), 'utf8');
  const edge = await readFile(path.resolve(process.cwd(), 'cloudflare/src/index.ts'), 'utf8');

  assert.match(arcade, /constructionTapeTexture/);
  assert.doesNotMatch(arcade, /futureConstructionBarrier|Future Console Room Under Construction/);
  assert.match(arcade, /xboxConstructionBarrier\.userData\.roomName='Xbox'/);
  assert.doesNotMatch(arcade, /ps2ConstructionBarrier|PS2 Room Under Construction/);
  assert.match(arcade, /gamecubeConstructionBarrier\.userData\.roomName='GameCube'/);
  assert.match(arcade, /xboxConstructionPanel\.rotation\.y=-Math\.PI\/2/);
  assert.match(arcade, /gamecubeConstructionPanel\.rotation\.y=Math\.PI/);
  assert.doesNotMatch(arcade, /ConstructionPanel=new THREE\.Mesh\([^\n]+side:THREE\.DoubleSide/);
  assert.match(arcade, /const ps2CabinetLayout=\[\[1,-29\.2,-30/);
  // Room signage was removed on purpose: the wall logos identify each room,
  // so asserting the old text plates would pin behaviour that is now gone.
  assert.match(arcade, /playerPosition\.z>13\.2&&Math\.abs\(playerPosition\.x\)<2\.5/);
  assert.match(arcade, /Math\.abs\(playerPosition\.x-PS2_ROOM_CENTER_X\)<ROOM_DOOR_HALF_WIDTH-PLAYER_COLLISION_RADIUS/);
  assert.match(arcade, /const gamecubeCabinetLayout=/);
  assert.match(arcade, /nearbyConstructionRoom\(\)/);
  assert.match(arcade, /Room Under Construction\./);
  assert.match(arcade, /const minimumZ=wallX===PLAYSTATION_WALL_X\?PS2_ROOM_BACK_Z:-16\.8/);
  assert.match(edge, /PARTITION_WALL_X = 14/);
  assert.match(edge, /PLAYABLE_ROOM_DOOR_Z = -8/);
  assert.match(edge, /PS2_ROOM_DOOR_Z = -16\.8/);
  assert.match(edge, /Math\.abs\(crossingZ - PLAYABLE_ROOM_DOOR_Z\)/);
  assert.match(edge, /crossingX - PS2_ROOM_CENTER_X/);
});
