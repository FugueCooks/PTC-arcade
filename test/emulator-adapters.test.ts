import assert from 'node:assert/strict';
import test from 'node:test';
import { importBrowserModule } from './helpers/browser-module.js';

const { EMULATOR_CAPABILITY_KEYS, assertValidAdapter, createCapabilities, estimateLoadTimeoutMs, preflightAssets } =
  await importBrowserModule<any>('emulators/emulator-adapter.js');
const { createEmulatorJsAdapter } = await importBrowserModule<any>('emulators/adapters/emulatorjs-adapter.js');
const { PLAY_FRAME_SRC, createPlayPs2Adapter, fileNameFromUrl } = await importBrowserModule<any>('emulators/adapters/play-ps2-adapter.js');
const { GECKO_FRAME_SRC, createGeckoGameCubeAdapter } = await importBrowserModule<any>('emulators/adapters/gecko-gamecube-adapter.js');
const { EmulatorAdapterRegistry, createDefaultAdapterRegistry } = await importBrowserModule<any>('emulators/emulator-adapter-registry.js');

const psxGame = {
  id: 'crash-bandicoot', displayName: 'Crash Bandicoot', platformId: 'psx',
  emulatorAdapterId: 'emulatorjs', enabled: true,
  assetRequirements: [{ kind: 'game-image', assetId: 'crash.chd', sizeBytes: 100, required: true, label: null }]
};

void test('every adapter declares all capabilities, and defaults them to false', () => {
  // Milestone 11.4: never claim a capability the adapter does not provide.
  for (const adapter of createDefaultAdapterRegistry().all()) {
    for (const key of EMULATOR_CAPABILITY_KEYS) {
      assert.equal(typeof adapter.capabilities[key], 'boolean', `${adapter.id}.${key}`);
    }
    assert.ok(
      EMULATOR_CAPABILITY_KEYS.every((key: any) => adapter.capabilities[key] === false),
      `${adapter.id} must not claim capabilities across an opaque iframe boundary`
    );
  }
});

void test('createCapabilities rejects an unknown capability name', () => {
  assert.throws(() => createCapabilities({ timeTravel: true }), /Unknown emulator capability/);
  assert.equal(createCapabilities({ saveStates: true }).saveStates, true);
  assert.equal(createCapabilities({ saveStates: true }).pauseSupport, false);
});

void test('a malformed adapter is refused at registration, not at a cabinet', () => {
  const registry = new EmulatorAdapterRegistry();
  assert.throws(() => registry.register({ id: 'broken' }), /missing/);
  assert.throws(() => assertValidAdapter({ ...createEmulatorJsAdapter(), id: 'BAD ID' }), /must match/);
  assert.throws(() => assertValidAdapter({ ...createEmulatorJsAdapter(), supportedPlatforms: [] }), /at least one platform/);
  assert.throws(() => assertValidAdapter({ ...createEmulatorJsAdapter(), capabilities: {} }), /does not declare capability/);
  assert.throws(() => assertValidAdapter({ ...createEmulatorJsAdapter(), start: 'nope' }), /must be a function/);
});

void test('the registry refuses duplicate adapter IDs', () => {
  const registry = new EmulatorAdapterRegistry();
  registry.register(createEmulatorJsAdapter());
  assert.throws(() => registry.register(createEmulatorJsAdapter()), /Duplicate emulator adapter/);
  assert.equal(registry.size, 1);
});

void test('a game resolves to the adapter it declares', () => {
  // Milestone 11.40 test 2.
  const registry = createDefaultAdapterRegistry();
  assert.equal(registry.resolveForGame(psxGame).adapter.id, 'emulatorjs');
  assert.equal(registry.resolveForGame({ ...psxGame, platformId: 'ps2', emulatorAdapterId: 'play-ps2' }).adapter.id, 'play-ps2');
  assert.equal(registry.resolveForGame({ ...psxGame, platformId: 'gamecube', emulatorAdapterId: 'gecko-gamecube' }).adapter.id, 'gecko-gamecube');
});

void test('an unknown or mismatched adapter fails safely instead of substituting one', () => {
  // Milestone 11.40 test 5. A silent fallback would boot the wrong core.
  const registry = createDefaultAdapterRegistry();
  assert.deepEqual(registry.resolveForGame(undefined), { ok: false, reason: 'unknown-game' });
  const missing = registry.resolveForGame({ ...psxGame, emulatorAdapterId: 'nonexistent' });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'unknown-adapter');
  const mismatched = registry.resolveForGame({ ...psxGame, platformId: 'ps2', emulatorAdapterId: 'emulatorjs' });
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.reason, 'platform-unsupported');
});

void test('the EmulatorJS frame URL preserves the pre-Phase-11 contract', () => {
  // Milestone 11.5: a compatibility layer, not a rewrite. The snes -> snes9x
  // core rename and the PSX-only BIOS parameter must both survive.
  const adapter = createEmulatorJsAdapter();
  assert.equal(adapter.coreFor('psx'), 'psx');
  assert.equal(adapter.coreFor('n64'), 'n64');
  assert.equal(adapter.coreFor('snes'), 'snes9x');
  assert.equal(adapter.coreFor('unknown'), 'psx');

  const frame = adapter.describeFrame({ game: psxGame, gameUrl: 'https://cdn.example/crash.chd', biosUrl: 'https://cdn.example/bios.bin', displayName: 'Crash Bandicoot', emulatorContentId: 94154 });
  const parameters = new URLSearchParams(frame.src.split('?')[1]);
  assert.ok(frame.src.startsWith('player.html?'));
  assert.equal(parameters.get('core'), 'psx');
  assert.equal(parameters.get('game'), 'https://cdn.example/crash.chd');
  assert.equal(parameters.get('bios'), 'https://cdn.example/bios.bin');
  assert.equal(parameters.get('id'), '94154');
  assert.equal(frame.allow, 'autoplay; fullscreen');
});

void test('the BIOS parameter is PlayStation-only and empty when unconfigured', () => {
  const adapter = createEmulatorJsAdapter();
  const n64 = adapter.describeFrame({ game: { ...psxGame, platformId: 'n64' }, gameUrl: 'g', biosUrl: 'https://cdn.example/bios.bin' });
  assert.equal(new URLSearchParams(n64.src.split('?')[1]).get('bios'), '');
  // Absent BIOS must still launch, as it did before Phase 11.
  const psx = adapter.describeFrame({ game: psxGame, gameUrl: 'g' });
  assert.equal(new URLSearchParams(psx.src.split('?')[1]).get('bios'), '');
});

void test('blob URLs are tracked for revocation, remote URLs are not', () => {
  const adapter = createEmulatorJsAdapter();
  assert.deepEqual(adapter.describeFrame({ game: psxGame, gameUrl: 'blob:abc', biosUrl: 'blob:def' }).objectUrls, ['blob:abc', 'blob:def']);
  assert.deepEqual(adapter.describeFrame({ game: psxGame, gameUrl: 'https://cdn.example/g.chd' }).objectUrls, []);
});

void test('the wasm adapters keep their pinned frame URLs', () => {
  assert.equal(createPlayPs2Adapter().describeFrame({}).src, PLAY_FRAME_SRC);
  assert.equal(createGeckoGameCubeAdapter().describeFrame({}).src, GECKO_FRAME_SRC);
  assert.match(PLAY_FRAME_SRC, /^emulators\/play\/index\.html\?v=/);
  assert.match(GECKO_FRAME_SRC, /^emulators\/gecko\/index\.html\?v=/);
});

void test('the PS2 adapter hands over a local file directly and a hosted image by URL', () => {
  const adapter = createPlayPs2Adapter();
  const file = { name: 'local.iso', size: 42 };
  assert.deepEqual(adapter.initialHandshake({ localFile: file }), { type: 'arcade:ps2-load-file', file });

  const remote = adapter.initialHandshake({ gameUrl: 'https://cdn.example/arcade/god-of-war.chd', downloadBytes: 100, displayName: 'God of War' });
  assert.equal(remote.type, 'arcade:ps2-load-remote');
  assert.equal(remote.name, 'god-of-war.chd');
  assert.equal(remote.size, 100);
});

void test('the GameCube adapter always forwards the DSP firmware URL', () => {
  const adapter = createGeckoGameCubeAdapter();
  const dspUrl = 'https://cdn.example/dsp_rom.bin';
  assert.equal(adapter.initialHandshake({ gameUrl: 'https://cdn.example/pikmin.rvz', dspUrl, displayName: 'Pikmin' }).dspUrl, dspUrl);
  assert.equal(adapter.initialHandshake({ localFile: { name: 'local.rvz' }, dspUrl }).dspUrl, dspUrl);
});

void test('GameCube preflight refuses mobile devices before any download starts', () => {
  const context = { game: { ...psxGame, platformId: 'gamecube' }, resolveAsset: () => true, isMobileDevice: true };
  return createGeckoGameCubeAdapter().preflight(context).then((result: any) => {
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'desktop-only');
  });
});

void test('file names are recovered from URLs, with a usable fallback', () => {
  assert.equal(fileNameFromUrl('https://cdn.example/a/b/game%20one.iso', 'X', 'iso'), 'game one.iso');
  assert.equal(fileNameFromUrl('', 'My Game', 'iso'), 'My Game.iso');
  assert.equal(fileNameFromUrl(undefined, 'My Game', 'rvz'), 'My Game.rvz');
  assert.equal(fileNameFromUrl('::not a url::', 'My Game', 'iso'), 'My Game.iso');
});

void test('each backend interprets only its own frame messages', () => {
  const emulatorJs = createEmulatorJsAdapter();
  const play = createPlayPs2Adapter();
  const gecko = createGeckoGameCubeAdapter();

  assert.equal(emulatorJs.interpretMessage({ type: 'arcade:emulator-ready' }).kind, 'ready');
  // A core-tagged ready belongs to that core alone.
  assert.equal(play.interpretMessage({ type: 'arcade:emulator-ready', core: 'ps2-play' }).kind, 'ready');
  assert.equal(play.interpretMessage({ type: 'arcade:emulator-ready', core: 'gamecube-gecko' }).kind, 'ignore');
  assert.equal(gecko.interpretMessage({ type: 'arcade:emulator-ready', core: 'gamecube-gecko' }).kind, 'ready');
  assert.equal(gecko.interpretMessage({ type: 'arcade:emulator-ready', core: 'ps2-play' }).kind, 'ignore');

  assert.equal(play.interpretMessage({ type: 'arcade:ps2-source-accepted' }).kind, 'source-accepted');
  assert.equal(play.interpretMessage({ type: 'arcade:ps2-disc-error' }).kind, 'error');
  assert.equal(gecko.interpretMessage({ type: 'arcade:gamecube-load-progress', percent: 40 }).percent, 40);
  assert.equal(gecko.interpretMessage({ type: 'arcade:gamecube-load-progress', percent: Number.NaN }).kind, 'ignore');
  assert.equal(emulatorJs.interpretMessage({ type: 'totally-unrelated' }).kind, 'ignore');
  assert.equal(emulatorJs.interpretMessage(null).kind, 'ignore');
});

void test('preflight reports the specific missing required assets', () => {
  const game = {
    ...psxGame,
    assetRequirements: [
      { kind: 'game-image', assetId: 'disc-1.chd', required: true },
      { kind: 'game-image', assetId: 'disc-2.chd', required: false },
      { kind: 'bios', assetId: 'SCPH1001.BIN', required: true }
    ]
  };
  const present = preflightAssets({ game, resolveAsset: () => true });
  assert.deepEqual(present, { ok: true, missingAssets: [] });

  const missing = preflightAssets({ game, resolveAsset: (asset: any) => asset.assetId !== 'SCPH1001.BIN' });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missingAssets, ['SCPH1001.BIN'], 'optional assets must not be reported as missing');
});

void test('the load timeout scales with download size within fixed bounds', () => {
  assert.equal(estimateLoadTimeoutMs(0), 20_000);
  assert.equal(estimateLoadTimeoutMs(undefined), 20_000);
  assert.equal(estimateLoadTimeoutMs(Number.NaN), 20_000);
  assert.ok(estimateLoadTimeoutMs(500_000_000) > 20_000);
  assert.equal(estimateLoadTimeoutMs(Number.MAX_SAFE_INTEGER), 180_000, 'a huge image must not produce an unbounded timeout');
});
