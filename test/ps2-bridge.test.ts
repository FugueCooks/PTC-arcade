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
  assert.match(player, /const maxCachedChunks = 32/);
  assert.match(player, /return \{ arrayBuffer: \(\) => read\(safeStart, safeEnd\) \}/);
  assert.match(player, /document\.body\.classList\.add\('remote-disc'\)/);
});

void test('closing a PS2 session releases the selected disc image reference', async () => {
  const arcade = await readFile(path.resolve(process.cwd(), 'arcade.js'), 'utf8');
  assert.match(arcade, /activeEmulatorFrame=null;pendingPs2Source=null/);
  assert.match(arcade, /romInput\.value='';romLoaded=false/);
  assert.match(arcade, /querySelector\('\.screen-wrap \.scanlines'\)\.style\.display='block'/);
  assert.match(arcade, /querySelector\('\.screen-wrap \.scanlines'\)\.style\.display='none'/);
});
