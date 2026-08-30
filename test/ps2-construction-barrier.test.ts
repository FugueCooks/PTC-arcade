import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

void test('no room in the building is sealed; every one of them is open', async () => {
  // The ring came down to one barrier, and then to none: the tournament hall
  // is the south approach to the Temple of Time now, so its tape came down
  // with the bound behind it. Nothing in the building is behind tape — PS2,
  // PlayStation, Mega Man, Nintendo 64, GameCube, Xbox, the four rooms across
  // the top and the south hall are all walkable.
  const arcade = await readFile(path.resolve(process.cwd(), 'arcade.js'), 'utf8');
  const edge = await readFile(path.resolve(process.cwd(), 'cloudflare/src/index.ts'), 'utf8');

  assert.match(arcade, /constructionTapeTexture/);
  assert.doesNotMatch(arcade, /futureConstructionBarrier|Future Console Room Under Construction/);
  assert.doesNotMatch(arcade, /ps2ConstructionBarrier|PS2 Room Under Construction/);
  // The builder stays, because a room may need sealing again while it is being
  // re-themed. What must not come back quietly is a call to it.
  assert.match(arcade, /function sealDoorway\(roomName,x,z,facing\)/);
  assert.equal((arcade.match(/sealDoorway\('/g) ?? []).length, 0, 'no room in the building is sealed');
  // The console games are all out in the foyer while the rooms are re-themed,
  // so their layouts are slots in the two hall rows rather than wall positions.
  assert.match(arcade, /const ps2CabinetLayout=Array\.from\(\{length:5\}/);
  assert.match(arcade, /const FOYER_ROW_X=11\.5/);
  assert.match(arcade, /const gamecubeCabinetLayout=/);
  assert.match(arcade, /Room Under Construction\./);

  // The doorways that are open are stated once, per side, and the same table is
  // stated again on the authoritative path. A room whose doorway is not listed
  // is shut, which is what makes the barrier standing in it true.
  // Every doorway in both partition walls is open, stated once and mirrored on
  // the authoritative path.
  // The east column re-planned around the grown garden, so each wall carries
  // its own door list and the two no longer mirror each other.
  assert.match(arcade, /const OPEN_DOOR_Z_WEST=\[-25\.2,-8,8,25\.2\];/);
  assert.match(arcade, /const OPEN_DOOR_Z_EAST=\[-25\.2,-3\.6,13\.2,27\.6\];/);
  assert.match(edge, /const OPEN_DOOR_Z_WEST = \[-25\.2, -8, 8, 25\.2\];/);
  assert.match(edge, /const OPEN_DOOR_Z_EAST = \[-25\.2, -3\.6, 13\.2, 27\.6\];/);
  // The top row is walkable now, so its front wall and the walls between its
  // rooms have to be enforced rather than left to the world bound.
  assert.match(arcade, /function resolveTopRowCollisions\(previousX,previousZ\)/);
  assert.match(edge, /const TOP_ROW_WALL_Z = -50\.4;/);
  assert.match(edge, /throughTopRowDoor\(crossingX\)/);
  assert.match(edge, /PARTITION_WALL_X = 21\.6/);

  // The prompt reads the room off the barrier the player is standing at, so a
  // room added to the table cannot arrive without one.
  assert.match(arcade, /for\(const barrier of constructionBarriers\)/);
});
