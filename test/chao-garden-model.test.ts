import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();

void test('the supplied Chao Garden GLB replaces the procedural runtime garden', async () => {
  const [arcade, modelStats] = await Promise.all([
    readFile(path.resolve(root, 'arcade.js'), 'utf8'),
    stat(path.resolve(root, 'assets/models/chao-garden.glb'))
  ]);

  assert.equal(modelStats.size, 2_493_028, 'the copied Sonic Adventure 2 GLB should remain intact');
  assert.match(arcade, /function installChaoGardenModel\(\)/);
  assert.match(arcade, /assets\/models\/chao-garden\.glb\?v=/);
  assert.doesNotMatch(arcade, /buildChaoGarden\(ANNEX_ROOM_CENTER_X,13\.2\)/,
    'the retained rollback builder must not instantiate the old garden');
  assert.doesNotMatch(arcade, /assets\/models\/chao-garden-props\.glb/);
});

void test('the island installs whole: uniform scale, cave-mouth alignment, aquarium clamp', async () => {
  const arcade = await readFile(path.resolve(root, 'arcade.js'), 'utf8');

  assert.match(arcade, /const GARDEN_SCALE=.9,GARDEN_TX=26.52,GARDEN_TY=.15,GARDEN_TZ=15.81;/,
    'one uniform scale and a fixed transform that lands the cave arch in the door gap');
  assert.match(arcade, /source\.rotation\.y=Math\.PI\/2;mount\.add\(source\)/);
  assert.match(arcade, /mount\.scale\.setScalar\(GARDEN_SCALE\)/,
    'the island must not be squashed to fit a room ellipse');
  assert.doesNotMatch(arcade, /Math\.hypot\(candidateCenter\.x,candidateCenter\.z\)>20/,
    'the far-field discard is gone: the ocean and far islands ship');
  assert.match(arcade, /Math\.max\(worldVertex\.x,21\.72\)/,
    'stray west vertices squash onto the partition plane instead of poking the hall');
  assert.match(arcade, /Cube\.00\[2-9\]_Material\.018/,
    'only the eight distant cloud cards are dropped');
  assert.match(arcade, /Cube\(\.001\)\?_Material\.006/,
    'the black cards sealing the cave arches are dropped');
});

void test('the Metroid room re-homed behind the prize counter and its old slot sealed', async () => {
  const arcade = await readFile(path.resolve(root, 'arcade.js'), 'utf8');

  assert.match(arcade, /const OPEN_DOOR_Z_EAST=\[-25\.2,13\.2\];/,
    'the old Metroid door and the squeezed room door are sealed');
  assert.match(arcade, /const EAST_REMOVED_WALL_Z=new Set\(\[0,16\.8\]\);/,
    'the dividers inside the garden zone are gone');
  assert.match(arcade, /metroid-room-mural\.webp\?v=metroid-2/,
    'the murals hang in the new room');
  assert.match(arcade, /lightRoom\(18,-54\.6,14\.4,25\.2,0x7dff67\)/);
  assert.match(arcade, /lightThreshold\(18,POKEMON_SOUTH_Z,true\)/,
    'the new doorway is lit like every other threshold');
});

void test('the visual replacement preserves authoritative Chao Garden collision geometry', async () => {
  const [arcade, server, worker] = await Promise.all([
    readFile(path.resolve(root, 'arcade.js'), 'utf8'),
    readFile(path.resolve(root, 'server/src/players/player-manager.ts'), 'utf8'),
    readFile(path.resolve(root, 'cloudflare/src/index.ts'), 'utf8')
  ]);
  const authoritative = /const CHAO_GARDEN = \{ cx: 27\.6, cz: 16\.8, ax: 5\.5, az: 4\.6, laneHalfWidth: 1\.05, doorZ: 13\.2, laneEndX: 25 \};/;
  const zoneRule = /inChaoGardenZone\(toX, toZ\) && !insideChaoGarden\(toX, toZ\) && !inChaoGardenLane\(toX, toZ\)/;

  assert.match(arcade, /const CHAO_GARDEN=\{cx:27\.6,cz:16\.8,ax:5\.5,az:4\.6,laneHalfWidth:1\.05,doorZ:13\.2,laneEndX:25\};/);
  assert.match(server, authoritative);
  assert.match(worker, authoritative);
  assert.match(server, zoneRule);
  assert.match(worker, zoneRule);
  const metroidWall = /The Metroid room's west wall/;
  assert.match(arcade, metroidWall);
  assert.match(server, metroidWall);
  assert.match(worker, metroidWall);
});

void test('Pages packages the Chao Garden model explicitly', async () => {
  const builder = await readFile(path.resolve(root, 'tools/build-pages.mjs'), 'utf8');

  assert.match(builder, /const requiredEnvironmentModels = new Set\(\['chao-garden\.glb'\]\)/);
  assert.match(builder, /requiredEnvironmentModels\.has\(path\.basename\(normalized\)\)/);
});
