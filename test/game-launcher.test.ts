import assert from 'node:assert/strict';
import test from 'node:test';
import { importBrowserModule } from './helpers/browser-module.js';

const { GameLauncher, launchFailureMessage } = await importBrowserModule<any>('games/game-launcher.js');
const { createDefaultAdapterRegistry } = await importBrowserModule<any>('emulators/emulator-adapter-registry.js');

const cabinet = { id: 'crash-bandicoot', enabled: true, gameId: 'crash', zoneId: 'main-floor-west' };
const game = {
  id: 'crash', displayName: 'Crash Bandicoot', platformId: 'psx', emulatorAdapterId: 'emulatorjs', enabled: true,
  assetRequirements: [{ kind: 'game-image', assetId: 'crash.chd', sizeBytes: 100, required: true, label: null }]
};

/** Records every mechanism call so cleanup can be asserted, not assumed. */
function trackingRuntime(overrides: any = {}) {
  const calls: string[] = [];
  return {
    calls,
    mount(session: any) { calls.push('mount'); return overrides.mount ? overrides.mount(session) : { frame: session.frame }; },
    terminate() { calls.push('terminate'); },
    release() { calls.push('release'); }
  };
}

function setup(options: any = {}) {
  const runtime = options.runtime ?? trackingRuntime();
  const launcher = new GameLauncher({
    cabinets: new Map([[cabinet.id, options.cabinet ?? cabinet]]),
    games: new Map([[game.id, options.game ?? game]]),
    adapters: createDefaultAdapterRegistry(),
    runtime,
    entitlements: options.entitlements,
    logger: () => undefined
  });
  return { launcher, runtime };
}

void test('a cabinet resolves through the launcher to game and adapter', () => {
  // Milestone 11.40 tests 1 and 2, through the real chain.
  const { launcher } = setup();
  const resolved = launcher.resolve('crash-bandicoot');
  assert.equal(resolved.ok, true);
  assert.equal(resolved.game.id, 'crash');
  assert.equal(resolved.adapter.id, 'emulatorjs');
});

void test('cabinet code never instantiates an emulator: only the launcher does', async () => {
  // Milestone 11.40 test 3. The cabinet definition names a game ID and nothing
  // else; every core decision is made downstream of it.
  const { launcher, runtime } = setup();
  assert.equal(Object.hasOwn(cabinet, 'system'), false);
  assert.equal(Object.hasOwn(cabinet, 'emulatorId'), false);
  const result = await launcher.launch('crash-bandicoot', { gameUrl: 'https://cdn.example/crash.chd', resolveAsset: () => true });
  assert.equal(result.ok, true);
  assert.equal(result.adapter.id, 'emulatorjs');
  assert.ok(result.session.frame.src.startsWith('player.html?'));
  assert.deepEqual(runtime.calls, ['mount']);
});

void test('unknown cabinets, games, and adapters each fail safely and distinctly', async () => {
  // Milestone 11.40 tests 4 and 5.
  const { launcher } = setup();
  assert.equal((await launcher.launch('no-such-cabinet')).reason, 'unknown-cabinet');

  const disabled = setup({ cabinet: { ...cabinet, enabled: false } });
  assert.equal((await disabled.launcher.launch('crash-bandicoot')).reason, 'cabinet-disabled');

  const unassigned = setup({ cabinet: { ...cabinet, gameId: null } });
  assert.equal((await unassigned.launcher.launch('crash-bandicoot')).reason, 'no-game-assigned');

  const missingGame = setup({ cabinet: { ...cabinet, gameId: 'ghost-game' } });
  assert.equal((await missingGame.launcher.launch('crash-bandicoot')).reason, 'unknown-game');

  const badAdapter = setup({ game: { ...game, emulatorAdapterId: 'nonexistent' } });
  assert.equal((await badAdapter.launcher.launch('crash-bandicoot')).reason, 'unknown-adapter');

  const offRotation = setup({ game: { ...game, enabled: false } });
  assert.equal((await offRotation.launcher.launch('crash-bandicoot')).reason, 'game-disabled');
});

void test('no failure path mounts a frame', async () => {
  const runtime = trackingRuntime();
  const { launcher } = setup({ runtime, cabinet: { ...cabinet, gameId: null } });
  await launcher.launch('crash-bandicoot');
  assert.deepEqual(runtime.calls, [], 'a refused launch must not touch the runtime');
  assert.equal(launcher.activeSession, null);
});

void test('a failed preflight reports the missing asset and starts nothing', async () => {
  const runtime = trackingRuntime();
  const { launcher } = setup({ runtime });
  const result = await launcher.launch('crash-bandicoot', { resolveAsset: () => false });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing-assets');
  assert.deepEqual(result.missingAssets, ['crash.chd']);
  assert.deepEqual(runtime.calls, []);
});

void test('an emulator failure disposes the session and releases the cabinet', async () => {
  // Milestone 11.40 test 8: emulator failure releases cabinet ownership.
  const runtime = trackingRuntime({ mount: () => { throw new Error('wasm blew up'); } });
  const { launcher } = setup({ runtime });
  const result = await launcher.launch('crash-bandicoot', { resolveAsset: () => true });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'start-failed');
  assert.ok(runtime.calls.includes('release'), 'the failed session must be disposed');
  assert.equal(launcher.activeSession, null, 'no session may survive a failed start');
});

void test('a dispose failure during cleanup does not mask the original error', async () => {
  const runtime = {
    mount: () => { throw new Error('mount failed'); },
    terminate: () => undefined,
    release: () => { throw new Error('release also failed'); }
  };
  const { launcher } = setup({ runtime });
  const result = await launcher.launch('crash-bandicoot', { resolveAsset: () => true });
  assert.equal(result.reason, 'start-failed');
});

void test('entitlement refusal blocks the launch before any download', async () => {
  const runtime = trackingRuntime();
  const { launcher } = setup({ runtime, entitlements: { check: () => ({ ok: false }) } });
  const result = await launcher.launch('crash-bandicoot', { resolveAsset: () => true });
  assert.equal(result.reason, 'not-entitled');
  assert.deepEqual(runtime.calls, []);
});

void test('repeated stop is harmless', async () => {
  // Milestone 11.40 test 7, at the launcher level.
  const runtime = trackingRuntime();
  const { launcher } = setup({ runtime });
  await launcher.launch('crash-bandicoot', { resolveAsset: () => true });

  const first = await launcher.stop('player-exit');
  assert.equal(first.stopped, true);
  assert.equal(first.cabinetId, 'crash-bandicoot');

  const second = await launcher.stop('player-exit');
  assert.equal(second.stopped, false, 'a second stop must be a no-op');
  const third = await launcher.stop('disconnect');
  assert.equal(third.stopped, false);
  assert.equal(runtime.calls.filter((call: string) => call === 'terminate').length, 1);
});

void test('frame messages route to the adapter that owns the running session', async () => {
  const { launcher } = setup();
  assert.equal(launcher.interpret({ type: 'arcade:emulator-ready' }).kind, 'ignore', 'no session means nothing to interpret');
  await launcher.launch('crash-bandicoot', { resolveAsset: () => true });
  assert.equal(launcher.interpret({ type: 'arcade:emulator-ready' }).kind, 'ready');
  assert.equal(launcher.interpret({ type: 'arcade:emulator-error' }).kind, 'error');
});

void test('every failure reason has a player-facing message', () => {
  for (const reason of ['unknown-cabinet', 'cabinet-disabled', 'no-game-assigned', 'unknown-game', 'game-disabled',
    'unknown-adapter', 'platform-unsupported', 'not-entitled', 'desktop-only', 'missing-assets', 'start-failed']) {
    assert.match(launchFailureMessage(reason), /^[A-Z0-9 .,'—-]+$/, `${reason} needs an uppercase message`);
  }
  assert.equal(launchFailureMessage('something-unmapped'), 'CABINET COULD NOT OPEN.');
});
