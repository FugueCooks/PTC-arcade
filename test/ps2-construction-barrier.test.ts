import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

void test('only the tournament hall is sealed; every other room is open', async () => {
  // The ring came down to one barrier. Nothing else in the building is behind
  // tape: PS2, PlayStation, Mega Man, Nintendo 64, GameCube, Xbox and the four
  // rooms across the top are all walkable.
  const arcade = await readFile(path.resolve(process.cwd(), 'arcade.js'), 'utf8');
  const edge = await readFile(path.resolve(process.cwd(), 'cloudflare/src/index.ts'), 'utf8');

  assert.match(arcade, /constructionTapeTexture/);
  assert.doesNotMatch(arcade, /futureConstructionBarrier|Future Console Room Under Construction/);
  assert.doesNotMatch(arcade, /ps2ConstructionBarrier|PS2 Room Under Construction/);
  // Every sealed doorway in the ring is one call against one builder. Nine of
  // them are sealed, and three hand-written copies of the same six lines was
  // already two too many.
  assert.match(arcade, /function sealDoorway\(roomName,x,z,facing\)/);
  assert.match(arcade, /sealDoorway\('Multiplayer \/ Tournament',0,TOURNAMENT_MIN_Z-\.25,Math\.PI\)/);
  // Exactly one call, so a barrier cannot come back without this failing.
  assert.equal((arcade.match(/sealDoorway\('/g) ?? []).length, 1, 'the tournament hall is the only sealed room');
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
  assert.match(arcade, /const OPEN_DOOR_Z=\[-25\.2,-8,8,25\.2\];/);
  assert.match(edge, /const OPEN_DOOR_Z = \[-25\.2, -8, 8, 25\.2\];/);
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
