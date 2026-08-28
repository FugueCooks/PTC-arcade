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
  assert.doesNotMatch(arcade, /ps2ConstructionBarrier|PS2 Room Under Construction/);
  // Every sealed doorway in the ring is one call against one builder. Nine of
  // them are sealed, and three hand-written copies of the same six lines was
  // already two too many.
  assert.match(arcade, /function sealDoorway\(roomName,x,z,facing\)/);
  assert.match(arcade, /sealDoorway\('Xbox',N64_WALL_X,CONSTRUCTION_ROOM_DOOR_Z,-Math\.PI\/2\)/);
  assert.match(arcade, /sealDoorway\('GameCube',N64_WALL_X,-25\.2,-Math\.PI\/2\)/);
  assert.match(arcade, /sealDoorway\('Multiplayer \/ Tournament',0,TOURNAMENT_MIN_Z-\.25,Math\.PI\)/);
  assert.match(arcade, /for\(const roomX of NORTH_ROOM_X\)sealDoorway\('Console Row'/);
  assert.match(arcade, /const ps2CabinetLayout=\[\[1,-41\.4,-30/);
  assert.match(arcade, /const gamecubeCabinetLayout=/);
  assert.match(arcade, /Room Under Construction\./);

  // The doorways that are open are stated once, per side, and the same table is
  // stated again on the authoritative path. A room whose doorway is not listed
  // is shut, which is what makes the barrier standing in it true.
  assert.match(arcade, /const OPEN_DOOR_Z=\{west:\[-25\.2,-8,8\],east:\[-8\]\};/);
  assert.match(edge, /west: \[-25\.2, -8, 8\], east: \[-8\]/);
  assert.match(edge, /PARTITION_WALL_X = 21\.6/);

  // The prompt reads the room off the barrier the player is standing at, so a
  // room added to the table cannot arrive without one.
  assert.match(arcade, /for\(const barrier of constructionBarriers\)/);
});
