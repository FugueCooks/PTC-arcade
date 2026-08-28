import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

void test('PS2 is open; Xbox and GameCube keep their barriers', async () => {
  // GameCube is sealed again while its runtime is finished. Its cabinets stay in
  // the registry and the match system still seats four at them, so reopening the
  // room is this barrier plus the world bound behind it, not a rebuild.
  const arcade = await readFile(path.resolve(process.cwd(), 'arcade.js'), 'utf8');
  const edge = await readFile(path.resolve(process.cwd(), 'cloudflare/src/index.ts'), 'utf8');

  assert.match(arcade, /constructionTapeTexture/);
  assert.doesNotMatch(arcade, /futureConstructionBarrier|Future Console Room Under Construction/);
  assert.match(arcade, /xboxConstructionBarrier\.userData\.roomName='Xbox'/);
  assert.doesNotMatch(arcade, /ps2ConstructionBarrier|PS2 Room Under Construction/);
  assert.match(arcade, /xboxConstructionPanel\.rotation\.y=-Math\.PI\/2/);
  assert.match(arcade, /gamecubeConstructionBarrier\.userData\.roomName='GameCube'/);
  // GameCube changed room, not status: the barrier moved into the doorway of
  // the gallery behind Nintendo 64, and the Multiplayer / Tournament room took
  // the doorway it used to stand in.
  assert.match(arcade, /gamecubeConstructionBarrier\.position\.set\(ANNEX_ROOM_CENTER_X,0,PS2_ROOM_DOOR_Z\)/);
  assert.match(arcade, /tournamentConstructionBarrier\.userData\.roomName='Multiplayer \/ Tournament'/);
  assert.match(arcade, /tournamentConstructionBarrier\.position\.set\(0,0,16\.55\)/);
  assert.doesNotMatch(arcade, /ConstructionPanel=new THREE\.Mesh\([^\n]+side:THREE\.DoubleSide/);
  assert.match(arcade, /const ps2CabinetLayout=\[\[1,-33\.8,-30/);
  // Room signage was removed on purpose: the wall logos identify each room,
  // so asserting the old text plates would pin behaviour that is now gone.
  // The GameCube doorway reports the room as closed, because it is.
  assert.match(arcade, /playerPosition\.z>13\.2&&Math\.abs\(playerPosition\.x\)<2\.5/);
  assert.match(arcade, /Math\.abs\(playerPosition\.x-PS2_ROOM_CENTER_X\)<ROOM_DOOR_HALF_WIDTH-PLAYER_COLLISION_RADIUS/);
  assert.match(arcade, /const gamecubeCabinetLayout=/);
  assert.match(arcade, /nearbyConstructionRoom\(\)/);
  assert.match(arcade, /Room Under Construction\./);
  // Both partition walls run the full depth now: each side has a rear gallery
  // behind it, so neither stops at the back of the playable rooms.
  assert.match(arcade, /const minimumZ=PS2_ROOM_BACK_Z;/);
  assert.match(edge, /PARTITION_WALL_X = 14/);
  assert.match(edge, /PLAYABLE_ROOM_DOOR_Z = -8/);
  assert.match(edge, /PS2_ROOM_DOOR_Z = -16\.8/);
  assert.match(edge, /Math\.abs\(crossingZ - PLAYABLE_ROOM_DOOR_Z\)/);
  assert.match(edge, /throughRearDoor\(crossingX\)/);
});
