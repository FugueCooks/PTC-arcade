import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const read = (file: string): Promise<string> => readFile(path.resolve(process.cwd(), file), 'utf8');

void test('arcade.js holds no emulator core knowledge', async () => {
  // Milestone 11.40 test 3, and the Phase 11 success criterion that cabinets no
  // longer depend directly on emulator implementations. These strings are the
  // fingerprints of the pre-Phase-11 inline selection; each now lives in exactly
  // one adapter. Asserting their absence is what stops the coupling creeping back.
  const arcade = await read('arcade.js');
  for (const fingerprint of [
    'snes9x',                       // EmulatorJS core rename
    'player.html?core=',            // EmulatorJS frame contract
    'emulators/play/index.html',    // Play! frame
    'emulators/gecko/index.html',   // Gecko frame
    'arcade:ps2-load-remote',       // Play! source handshake
    'arcade:gamecube-load-remote',  // Gecko source handshake
    'cdn.emulatorjs.org'            // EmulatorJS runtime host
  ]) {
    assert.ok(!arcade.includes(fingerprint), `arcade.js must not contain "${fingerprint}"`);
  }
});

void test('each emulator frame contract lives in exactly one adapter', async () => {
  const [emulatorJs, play, gecko] = await Promise.all([
    read('emulators/adapters/emulatorjs-adapter.js'),
    read('emulators/adapters/play-ps2-adapter.js'),
    read('emulators/adapters/gecko-gamecube-adapter.js')
  ]);
  assert.ok(emulatorJs.includes('player.html?'));
  assert.ok(!play.includes('player.html?') && !gecko.includes('player.html?'));

  assert.ok(play.includes('emulators/play/index.html'));
  assert.ok(!emulatorJs.includes('emulators/play/') && !gecko.includes('emulators/play/'));

  assert.ok(gecko.includes('emulators/gecko/index.html'));
  assert.ok(!emulatorJs.includes('emulators/gecko/') && !play.includes('emulators/gecko/'));
});

void test('no adapter reaches for the DOM', async () => {
  // Adapters are policy; the DOM is mechanism, owned by the host runtime. This
  // separation is what lets the adapters be tested without a browser at all.
  for (const file of [
    'emulators/emulator-adapter.js',
    'emulators/emulator-adapter-registry.js',
    'emulators/adapters/emulatorjs-adapter.js',
    'emulators/adapters/play-ps2-adapter.js',
    'emulators/adapters/gecko-gamecube-adapter.js',
    'games/game-launcher.js'
  ]) {
    const source = await read(file);
    for (const forbidden of ['document.', 'window.', 'createObjectURL', 'postMessage(']) {
      assert.ok(!source.includes(forbidden), `${file} must not use ${forbidden}`);
    }
  }
});

void test('the launcher chain is wired into the page exactly once', async () => {
  const bootstrap = await read('app-bootstrap.js');
  assert.match(bootstrap, /createDefaultAdapterRegistry/);
  assert.match(bootstrap, /window\.ARCADE_EMULATOR_ADAPTERS = createDefaultAdapterRegistry\(\)/);

  const arcade = await read('arcade.js');
  // One resolution helper, one launch path, one message pump.
  assert.equal(arcade.match(/function resolveEmulatorAdapter\(/g)?.length, 1);
  assert.equal(arcade.match(/function launchEmulator\(/g)?.length, 1);
  assert.equal(arcade.match(/addEventListener\('message'/g)?.length, 1);
  assert.match(arcade, /adapter\.describeFrame\(context\)/);
  assert.match(arcade, /adapter\.interpretMessage\(event\.data\)/);
});

void test('the load timeout formula is preserved verbatim from before the refactor', async () => {
  // A behaviour-preservation check: Milestone 11.5 forbids changing how the
  // existing emulators behave, and this formula governs every launch deadline.
  const arcade = await read('arcade.js');
  const adapter = await read('emulators/emulator-adapter.js');
  assert.match(arcade, /Math\.max\(20000,Math\.min\(180000,20000\+\(Number\(downloadBytes\)\|\|0\)\/524288\*1000\)\)/);
  assert.match(adapter, /Math\.max\(20_000, Math\.min\(180_000, 20_000 \+ \(Number\(downloadBytes\) \|\| 0\) \/ 524_288 \* 1_000\)\)/);
});
