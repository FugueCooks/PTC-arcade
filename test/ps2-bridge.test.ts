import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

void test('the PS2 cabinet waits for Play! readiness and acknowledges disc handoff', async () => {
  const arcade = await readFile(path.resolve(process.cwd(), 'arcade.js'), 'utf8');
  const player = await readFile(path.resolve(process.cwd(), 'emulators/play/index.html'), 'utf8');
  // Phase 11 moved the PS2 half of this protocol into its adapter. The contract
  // with the frame is unchanged, so the same messages are asserted at their new
  // home; arcade.js keeps only the origin check and the generic pump.
  const adapter = await readFile(path.resolve(process.cwd(), 'emulators/adapters/play-ps2-adapter.js'), 'utf8');

  assert.match(arcade, /event\.source!==activeEmulatorFrame\?\.contentWindow/);
  assert.match(arcade, /signal\.needsSource&&pendingEmulatorSource/);
  assert.match(adapter, /message\?\.core === 'ps2-play'/);
  assert.match(adapter, /type: 'arcade:ps2-load-file', file: context\.localFile/);
  assert.match(adapter, /type: 'arcade:ps2-load-remote'/);
  assert.match(adapter, /message\?\.type === 'arcade:ps2-source-accepted'/);
  assert.match(player, /type: 'arcade:ps2-source-accepted', core: 'ps2-play'/);
  assert.match(player, /Range: `bytes=\$\{start\}-\$\{end - 1\}`/);
  assert.match(player, /response\.status !== 206/);
  assert.match(player, /const RANGE_CHUNK_BYTES = 4 \* 1024 \* 1024/);
  assert.match(player, /const chunkSize = RANGE_CHUNK_BYTES/);
  assert.match(player, /const maxCachedChunks = 40/);
  assert.match(player, /navigator\.connection\?\.downlink >= 10 \? 4 : 2/);
  assert.match(player, /void cachedChunk\(nextChunk\)\.catch/);
  assert.match(player, /navigator\.storage\?\.getDirectory/);
  assert.match(player, /retro-arcade-ps2-ranges-v1/);
  assert.match(player, /persistent\?\.get\(index, end - start\)/);
  assert.match(player, /persistent\.put\(index, buffer\)/);
  assert.match(player, /arrayBuffer: \(\) => read\(safeStart, safeEnd\)\.catch/);
  assert.match(player, /const expectedRange = `bytes \$\{start\}-\$\{end - 1\}\//);
  assert.match(player, /buffer\.byteLength !== end - start/);
  assert.match(player, /type: 'arcade:ps2-disc-error'/);
  assert.match(player, /BLACK INTRO MOVIE\? PRESS ENTER ONCE TO SKIP/);
  assert.match(adapter, /message\?\.type === 'arcade:ps2-disc-error'/);
  assert.match(player, /document\.body\.classList\.add\('remote-disc'\)/);
});

void test('PS2 sessions suspend competing arcade render work', async () => {
  const arcade = await readFile(path.resolve(process.cwd(), 'arcade.js'), 'utf8');
  const multiplayer = await readFile(path.resolve(process.cwd(), 'multiplayer-client.js'), 'utf8');
  const world = await readFile(path.resolve(process.cwd(), 'world/world-manager.js'), 'utf8');

  assert.match(arcade, /setEmulatorRuntimeActive\(true\)/);
  assert.match(arcade, /setEmulatorRuntimeActive\(false\)/);
  assert.match(arcade, /if\(emulatorRuntimeActive\)return/);
  // Asserts the guard exists, not how it is written. The avatar loop may use
  // an early return or a wrapping condition; both suspend the work.
  assert.match(multiplayer, /arcade\.isEmulatorActive\?\.\(\)/);
  assert.match(world, /arcade:emulator-mode-changed/);
  assert.match(world, /if \(this\.suspended \|\| now < this\.nextFrameAt\) return/);
});

void test('closing a PS2 session releases the selected disc image reference', async () => {
  const arcade = await readFile(path.resolve(process.cwd(), 'arcade.js'), 'utf8');
  assert.match(arcade, /activeEmulatorFrame=null;pendingEmulatorSource=null;activeEmulatorAdapter=null/);
  assert.match(arcade, /romInput\.value='';romLoaded=false/);
  assert.match(arcade, /querySelector\('\.screen-wrap \.scanlines'\)\.style\.display='block'/);
  assert.match(arcade, /querySelector\('\.screen-wrap \.scanlines'\)\.style\.display='none'/);
});

void test('hosted GameCube loading reports progress and is not canceled by the outer timeout', async () => {
  const arcade = await readFile(path.resolve(process.cwd(), 'arcade.js'), 'utf8');
  const gecko = await readFile(path.resolve(process.cwd(), 'emulators/gecko/main.js'), 'utf8');
  const geckoStyles = await readFile(path.resolve(process.cwd(), 'emulators/gecko/main.css'), 'utf8');

  // As with PS2, the GameCube protocol moved into its adapter; arcade.js keeps
  // the generic signal handling that clears the load deadline.
  const geckoAdapter = await readFile(path.resolve(process.cwd(), 'emulators/adapters/gecko-gamecube-adapter.js'), 'utf8');
  assert.match(geckoAdapter, /message\?\.type === 'arcade:gamecube-source-loading'/);
  assert.match(arcade, /signal\.kind==='source-loading'\)\{clearTimeout\(emulatorLoadTimer\)/);
  assert.match(geckoAdapter, /message\?\.type === 'arcade:gamecube-load-progress'/);
  assert.match(gecko, /document\.body\.classList\.add\('hosted-game'\)/);
  assert.match(gecko, /type: 'arcade:gamecube-source-loading'/);
  assert.match(gecko, /type: 'arcade:gamecube-load-progress'/);
  assert.match(gecko, /Number\(response\.headers\.get\('content-length'\)\) \|\| Number\(expectedBytes\)/);
  assert.match(gecko, /Downloading \$\{name\} · \$\{percent\}%/);
  assert.match(gecko, /querySelectorAll\('\.picker, output, #start'\)/);
  assert.match(geckoStyles, /\[hidden\]\{display:none!important\}/);
  assert.match(geckoAdapter, /emulators\/gecko\/index\.html\?v=gecko-hosted-clean-1/);
});

void test('hosted GameCube images are cached persistently while the first download feeds Gecko', async () => {
  const gecko = await readFile(path.resolve(process.cwd(), 'emulators/gecko/main.js'), 'utf8');

  assert.match(gecko, /navigator\.storage\?\.getDirectory/);
  assert.match(gecko, /getCachedGame\(name, requestedBytes\)/);
  assert.match(gecko, /response\.body\.tee\(\)/);
  assert.match(gecko, /cacheStream\.pipeTo\(cacheTarget\.writable\)/);
  assert.match(gecko, /streamIntoDiscBuffer\(cached\.stream\(\), cached\.size, name\)/);
  assert.match(gecko, /file\.size !== totalBytes/);
});

void test('hosted GameCube sessions load and validate the required DSP system ROM', async () => {
  const arcade = await readFile(path.resolve(process.cwd(), 'arcade.js'), 'utf8');
  const gecko = await readFile(path.resolve(process.cwd(), 'emulators/gecko/main.js'), 'utf8');

  assert.match(arcade, /gameCubeDspAssetUrl/);
  assert.match(arcade, /dspUrl:gameCubeDspAssetUrl/);
  assert.match(gecko, /GAMECUBE_DSP_ROM_BYTES = 8192/);
  assert.match(gecko, /GAMECUBE_DSP_ROM_SHA256 = '49d987ee/);
  assert.match(gecko, /Promise\.all\(\[\s*loadRemoteFile\(url, name, size\),\s*loadDspRom\(dspUrl\)/);
  assert.match(gecko, /startRuntime\(discBuffer, name, dspBytes\)/);
});
