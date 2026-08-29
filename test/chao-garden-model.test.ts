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
  assert.match(arcade, /assets\/models\/chao-garden\.glb\?v=gba-row-1/);
  assert.doesNotMatch(arcade, /buildChaoGarden\(ANNEX_ROOM_CENTER_X,13\.2\)/,
    'the retained rollback builder must not instantiate the old garden');
  assert.doesNotMatch(arcade, /assets\/models\/chao-garden-props\.glb/);
});

void test('the Chao Garden model is grounded, fitted, lazy, and resilient', async () => {
  const arcade = await readFile(path.resolve(root, 'arcade.js'), 'utf8');

  assert.match(arcade, /const bounds=new THREE\.Box3\(\)\.setFromObject\(source\)/);
  assert.match(arcade, /source\.rotation\.y=Math\.PI\/2;mount\.add\(source\)/);
  assert.match(arcade, /Math\.max\(candidateSize\.x,candidateSize\.z\)>80\|\|Math\.hypot\(candidateCenter\.x,candidateCenter\.z\)>20/);
  assert.match(arcade, /node\.name\.startsWith\('Plane\.006_Material\.004'\)/);
  assert.match(arcade, /const scaleX=CHAO_GARDEN\.ax\*1\.96\/size\.x,scaleZ=CHAO_GARDEN\.az\*1\.96\/size\.z/);
  assert.match(arcade, /node\.castShadow=false;node\.receiveShadow=false/);
  assert.match(arcade, /scene\.add\(mount\);chaoGardenFallback\.visible=false/,
    'the loading floor should disappear only after the model has loaded');
  assert.match(arcade, /if\(!chaoGardenModelStarted&&playerPosition\.x>14&&playerPosition\.z>4&&playerPosition\.z<22\)/);
});

void test('Pages packages the Chao Garden model explicitly', async () => {
  const builder = await readFile(path.resolve(root, 'tools/build-pages.mjs'), 'utf8');

  assert.match(builder, /const requiredEnvironmentModels = new Set\(\['chao-garden\.glb'\]\)/);
  assert.match(builder, /requiredEnvironmentModels\.has\(path\.basename\(normalized\)\)/);
});

void test('the visual replacement preserves authoritative Chao Garden collision geometry', async () => {
  const [arcade, server, worker] = await Promise.all([
    readFile(path.resolve(root, 'arcade.js'), 'utf8'),
    readFile(path.resolve(root, 'server/src/players/player-manager.ts'), 'utf8'),
    readFile(path.resolve(root, 'cloudflare/src/index.ts'), 'utf8')
  ]);
  const authoritative = /const CHAO_GARDEN = \{ cx: 32\.4, cz: 13\.2, ax: 10\.2, az: 7\.8, laneHalfWidth: 1\.5, doorZ: 13\.2 \};/;

  assert.match(arcade, /ANNEX_ROOM_CENTER_X=32\.4/);
  assert.match(arcade, /const CHAO_GARDEN=\{cx:ANNEX_ROOM_CENTER_X,cz:13\.2,ax:10\.2,az:7\.8,laneHalfWidth:1\.5,doorZ:13\.2\};/);
  assert.match(server, authoritative);
  assert.match(worker, authoritative);
});
