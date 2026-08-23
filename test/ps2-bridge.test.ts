import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

void test('the PS2 cabinet waits for Play! readiness and acknowledges local file handoff', async () => {
  const arcade = await readFile(path.resolve(process.cwd(), 'arcade.js'), 'utf8');
  const player = await readFile(path.resolve(process.cwd(), 'emulators/play/index.html'), 'utf8');

  assert.match(arcade, /event\.source!==activeEmulatorFrame\?\.contentWindow/);
  assert.match(arcade, /event\.data\?\.core==='ps2-play'&&pendingPs2File/);
  assert.match(arcade, /type:'arcade:ps2-load-file',file:pendingPs2File/);
  assert.match(arcade, /event\.data\?\.type==='arcade:ps2-file-accepted'/);
  assert.match(player, /type: 'arcade:ps2-file-accepted', core: 'ps2-play'/);
});

void test('closing a PS2 session releases the selected disc image reference', async () => {
  const arcade = await readFile(path.resolve(process.cwd(), 'arcade.js'), 'utf8');
  assert.match(arcade, /activeEmulatorFrame=null;pendingPs2File=null/);
  assert.match(arcade, /romInput\.value='';romLoaded=false/);
});
