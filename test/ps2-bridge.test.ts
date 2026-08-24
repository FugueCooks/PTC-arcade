import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

void test('the PS2 cabinet waits for Play! readiness and acknowledges disc handoff', async () => {
  const arcade = await readFile(path.resolve(process.cwd(), 'arcade.js'), 'utf8');
  const player = await readFile(path.resolve(process.cwd(), 'emulators/play/index.html'), 'utf8');

  assert.match(arcade, /event\.source!==activeEmulatorFrame\?\.contentWindow/);
  assert.match(arcade, /event\.data\?\.core==='ps2-play'&&pendingPs2Source/);
  assert.match(arcade, /type:'arcade:ps2-load-file',file:pendingPs2Source\.file/);
  assert.match(arcade, /type:'arcade:ps2-load-remote'/);
  assert.match(arcade, /event\.data\?\.type==='arcade:ps2-source-accepted'/);
  assert.match(player, /type: 'arcade:ps2-source-accepted', core: 'ps2-play'/);
  assert.match(player, /Range: `bytes=\$\{start\}-\$\{end - 1\}`/);
  assert.match(player, /response\.status !== 206/);
  assert.match(player, /const chunkSize = 4 \* 1024 \* 1024/);
  assert.match(player, /const maxCachedChunks = 40/);
  assert.match(player, /const readAheadChunks = navigator\.connection\?\.saveData \? 0 : 2/);
  assert.match(player, /void cachedChunk\(nextChunk\)\.catch/);
  assert.match(player, /arrayBuffer: \(\) => read\(safeStart, safeEnd\)\.catch/);
  assert.match(player, /const expectedRange = `bytes \$\{start\}-\$\{end - 1\}\//);
  assert.match(player, /buffer\.byteLength !== end - start/);
  assert.match(player, /type: 'arcade:ps2-disc-error'/);
  assert.match(player, /BLACK INTRO MOVIE\? PRESS ENTER ONCE TO SKIP/);
  assert.match(arcade, /event\.data\?\.type==='arcade:ps2-disc-error'/);
  assert.match(player, /document\.body\.classList\.add\('remote-disc'\)/);
});

void test('PS2 sessions suspend competing arcade render work', async () => {
  const arcade = await readFile(path.resolve(process.cwd(), 'arcade.js'), 'utf8');
  const multiplayer = await readFile(path.resolve(process.cwd(), 'multiplayer-client.js'), 'utf8');
  const world = await readFile(path.resolve(process.cwd(), 'world/world-manager.js'), 'utf8');

  assert.match(arcade, /setEmulatorRuntimeActive\(true\)/);
  assert.match(arcade, /setEmulatorRuntimeActive\(false\)/);
  assert.match(arcade, /if\(emulatorRuntimeActive\)return/);
  assert.match(multiplayer, /!arcade\.isEmulatorActive\?\.\(\)/);
  assert.match(world, /arcade:emulator-mode-changed/);
  assert.match(world, /if \(this\.suspended \|\| now < this\.nextFrameAt\) return/);
});

void test('closing a PS2 session releases the selected disc image reference', async () => {
  const arcade = await readFile(path.resolve(process.cwd(), 'arcade.js'), 'utf8');
  assert.match(arcade, /activeEmulatorFrame=null;pendingPs2Source=null/);
  assert.match(arcade, /romInput\.value='';romLoaded=false/);
  assert.match(arcade, /querySelector\('\.screen-wrap \.scanlines'\)\.style\.display='block'/);
  assert.match(arcade, /querySelector\('\.screen-wrap \.scanlines'\)\.style\.display='none'/);
});
