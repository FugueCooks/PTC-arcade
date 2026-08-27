import assert from 'node:assert/strict';
import test from 'node:test';
import { importBrowserModule } from './helpers/browser-module.js';

const dolphin = await importBrowserModule<any>('ptc-runtime/src/dolphin.js');
const adapterModule = await importBrowserModule<any>('emulators/adapters/ptc-runtime-gamecube-adapter.js');
const { createDefaultAdapterRegistry } = await importBrowserModule<any>('emulators/emulator-adapter-registry.js');
const { assertValidAdapter } = await importBrowserModule<any>('emulators/emulator-adapter.js');

void test('the argument list is fixed, and only the image path varies', () => {
  const args = dolphin.buildDolphinArgs({ imagePath: 'C:\\Library\\wind-waker.rvz', userDirectory: 'C:\\PTC\\user' });
  assert.deepEqual(args, [
    '--batch',
    '--exec=C:\\Library\\wind-waker.rvz',
    '--user=C:\\PTC\\user',
    '--config=Dolphin.Display.Fullscreen=True',
    '--config=Dolphin.Display.RenderToMain=False'
  ]);
});

void test('there is no way to append an argument', () => {
  // The function takes named values, not a list. If a caller could pass extra
  // arguments, a page that reached that caller could pass them too.
  const args = dolphin.buildDolphinArgs({
    imagePath: '/library/game.rvz',
    userDirectory: null,
    // Anything unrecognized must simply be ignored rather than forwarded.
    extraArgs: ['--exec=/etc/passwd'],
    args: ['--anything']
  } as never);
  assert.equal(args.filter((a: string) => a.startsWith('--exec=')).length, 1);
  assert.ok(!args.includes('--anything'));
  assert.ok(!args.some((a: string) => a.includes('/etc/passwd')));
});

void test('an image path that would parse as a flag is refused', () => {
  assert.throws(() => dolphin.buildDolphinArgs({ imagePath: '--exec=/etc/passwd' }), /parse as a flag/);
  assert.throws(() => dolphin.buildDolphinArgs({ imagePath: '' }), /resolved image path/);
  assert.throws(() => dolphin.buildDolphinArgs({ imagePath: undefined as never }), /resolved image path/);
});

void test('a configured Dolphin wins, and a missing one is reported not guessed', () => {
  const exists = (p: string) => p === 'D:\\Portable\\Dolphin.exe' || p === 'C:\\Program Files\\Dolphin\\Dolphin.exe';

  const configured = dolphin.locateDolphin({ platform: 'win32', configuredPath: 'D:\\Portable\\Dolphin.exe', exists });
  assert.deepEqual(configured, { ok: true, path: 'D:\\Portable\\Dolphin.exe', source: 'configured' });

  const missingConfigured = dolphin.locateDolphin({ platform: 'win32', configuredPath: 'D:\\Gone.exe', exists });
  assert.equal(missingConfigured.ok, false);
  assert.equal(missingConfigured.reason, 'configured-path-missing');

  const discovered = dolphin.locateDolphin({ platform: 'win32', configuredPath: null, exists });
  assert.equal(discovered.path, 'C:\\Program Files\\Dolphin\\Dolphin.exe');

  const nothing = dolphin.locateDolphin({ platform: 'win32', configuredPath: null, exists: () => false });
  assert.deepEqual(nothing, { ok: false, reason: 'not-found' });
});

void test('closing the emulator window is an ending, not an error', () => {
  // Dolphin exits non-zero on a clean close often enough that the code alone
  // cannot carry the distinction the player sees.
  const closed = dolphin.interpretExit({ code: 1, signal: null, ranForMs: 900_000, windowAppeared: true });
  assert.equal(closed.outcome, 'closed');

  const cleanExit = dolphin.interpretExit({ code: 0, signal: null, ranForMs: 900_000, windowAppeared: true });
  assert.equal(cleanExit.outcome, 'closed');
});

void test('a process that dies before showing a window is a failure', () => {
  const failed = dolphin.interpretExit({ code: 3, signal: null, ranForMs: 120, windowAppeared: false });
  assert.equal(failed.outcome, 'failed');

  const silentZero = dolphin.interpretExit({ code: 0, signal: null, ranForMs: 50, windowAppeared: false });
  assert.equal(silentZero.outcome, 'failed', 'exiting instantly with zero is still a failure to start');

  const killed = dolphin.interpretExit({ code: null, signal: 'SIGKILL', ranForMs: 5_000, windowAppeared: true });
  assert.equal(killed.outcome, 'terminated');
});

void test('only one emulator runs at a time', () => {
  // Two Dolphins on one image fight over the same save files.
  const guard = new dolphin.LaunchGuard();
  assert.equal(guard.claim('a'.repeat(32)).ok, true);

  const second = guard.claim('b'.repeat(32));
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'already-running');

  guard.release('b'.repeat(32));
  assert.equal(guard.active, 'a'.repeat(32), 'releasing a session that never held the lock changes nothing');

  guard.release('a'.repeat(32));
  assert.equal(guard.claim('c'.repeat(32)).ok, true);
});

void test('the runtime adapter satisfies the adapter contract', () => {
  // It runs a native process rather than a core in a frame, but it is still an
  // adapter: the arcade's session machinery tracks cabinet ownership through
  // exactly this interface.
  const adapter = adapterModule.createPtcRuntimeGameCubeAdapter({ detectRuntime: async () => ({ present: false }) });
  assert.doesNotThrow(() => assertValidAdapter(adapter));
  assert.deepEqual([...adapter.supportedPlatforms], ['gamecube']);
});

void test('the frame is told the game id, never a download URL', () => {
  // A frame that can hand the runtime a URL can hand it any URL.
  const adapter = adapterModule.createPtcRuntimeGameCubeAdapter({ detectRuntime: async () => ({ present: true, usable: true }) });
  const handshake = adapter.initialHandshake({
    game: { id: 'wind-waker', system: 'gamecube' },
    gameUrl: 'https://cdn.example/arcade/games/wind-waker.rvz',
    displayName: 'The Legend of Zelda: The Wind Waker',
    cabinetId: 'gamecube-cabinet-01'
  });
  assert.equal(handshake.gameId, 'wind-waker');
  assert.equal(handshake.platformId, 'gamecube');
  const serialized = JSON.stringify(handshake);
  assert.ok(!serialized.includes('cdn.example'), 'no URL may cross into the frame');
  assert.ok(!serialized.includes('.rvz'), 'nor a file name');
});

void test('the adapter refuses before a cabinet commits when the runtime is absent', async () => {
  const absent = adapterModule.createPtcRuntimeGameCubeAdapter({ detectRuntime: async () => ({ present: false }) });
  const verdict = await absent.preflight({ game: { id: 'pikmin', system: 'gamecube' } });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'runtime-absent');

  const noDolphin = adapterModule.createPtcRuntimeGameCubeAdapter({
    detectRuntime: async () => ({ present: true, usable: true, dolphinPresent: false })
  });
  assert.equal((await noDolphin.preflight({ game: { id: 'pikmin', system: 'gamecube' } })).reason, 'dolphin-missing');

  const outdated = adapterModule.createPtcRuntimeGameCubeAdapter({
    detectRuntime: async () => ({ present: true, usable: false, reason: 'protocol-mismatch' })
  });
  assert.equal((await outdated.preflight({ game: { id: 'pikmin', system: 'gamecube' } })).reason, 'protocol-mismatch');
});

void test('a non-GameCube game never reaches the runtime', async () => {
  const adapter = adapterModule.createPtcRuntimeGameCubeAdapter({ detectRuntime: async () => ({ present: true, usable: true }) });
  const verdict = await adapter.preflight({ game: { id: 'crash', system: 'psx' } });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'unsupported-platform');
});

void test('the runtime is preferred when present, and Gecko carries the rest', async () => {
  const adapters = createDefaultAdapterRegistry();
  adapters.register(adapterModule.createPtcRuntimeGameCubeAdapter({ detectRuntime: async () => ({ present: true }) }));

  const withRuntime = adapterModule.chooseGameCubeAdapter({
    adapters, detection: { present: true, usable: true, dolphinPresent: true }
  });
  assert.equal(withRuntime.adapter.id, 'ptc-runtime-gamecube');

  const withoutRuntime = adapterModule.chooseGameCubeAdapter({ adapters, detection: { present: false } });
  assert.equal(withoutRuntime.adapter.id, 'gecko-gamecube', 'the browser core remains the fallback');
  assert.equal(withoutRuntime.reason, 'runtime-absent');

  // An installed runtime that cannot run anything must not be preferred over a
  // fallback that can.
  const brokenRuntime = adapterModule.chooseGameCubeAdapter({
    adapters, detection: { present: true, usable: true, dolphinPresent: false }
  });
  assert.equal(brokenRuntime.adapter.id, 'gecko-gamecube');
});

void test('a phone is told before the download, not during it', async () => {
  const adapters = createDefaultAdapterRegistry();
  const onMobile = adapterModule.chooseGameCubeAdapter({
    adapters, detection: { present: false }, isMobileDevice: true
  });
  assert.equal(onMobile.adapter, null);
  assert.equal(onMobile.reason, 'desktop-only');
});

const { DolphinLauncher } = await importBrowserModule<any>('ptc-runtime/src/dolphin-launcher.js');

/** A stand-in for a spawned emulator, so supervision is deterministic. */
function fakeChild() {
  const listeners = new Map<string, Array<(...args: any[]) => void>>();
  return {
    killed: [] as string[],
    once(event: string, handler: (...args: any[]) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), handler]);
      return this;
    },
    kill(signal?: string) { this.killed.push(signal ?? 'SIGTERM'); },
    emit(event: string, ...args: any[]) { for (const h of listeners.get(event) ?? []) h(...args); }
  };
}

void test('the launcher spawns without a shell, with the fixed argument list', async () => {
  // A shell between here and the emulator would reintroduce quoting as an
  // attack surface, and would add nothing.
  let seen: any = null;
  const child = fakeChild();
  const launcher = new DolphinLauncher({
    dolphinPath: 'C:\\Dolphin\\Dolphin.exe',
    userDirectory: 'C:\\PTC\\user',
    spawnImpl: (command: string, args: string[], options: any) => { seen = { command, args, options }; return child; }
  });

  const launched = await launcher.launch({ sessionId: 'a'.repeat(32), imagePath: 'C:\\Library\\wind-waker.rvz' });
  assert.equal(launched.ok, true);
  assert.equal(seen.command, 'C:\\Dolphin\\Dolphin.exe');
  assert.equal(seen.options.shell, false, 'never through a shell');
  assert.equal(seen.options.stdio, 'ignore', 'a full pipe buffer would stall the game');
  assert.ok(seen.args.includes('--exec=C:\\Library\\wind-waker.rvz'));
});

void test('an emulator that dies immediately is reported as a failure to start', async () => {
  const child = fakeChild();
  let clock = 1_000;
  const launcher = new DolphinLauncher({
    dolphinPath: '/usr/bin/dolphin-emu', spawnImpl: () => child, now: () => clock
  });

  const launched = await launcher.launch({ sessionId: 'a'.repeat(32), imagePath: '/library/game.rvz' });
  clock += 150;
  child.emit('exit', 3, null);

  assert.deepEqual(await launched.exited, { outcome: 'failed', reason: 'exited with code 3' });
});

void test('a spawn that throws does not take the runtime with it', async () => {
  const launcher = new DolphinLauncher({
    dolphinPath: '/usr/bin/dolphin-emu',
    spawnImpl: () => { throw new Error('ENOENT'); }
  });
  const launched = await launcher.launch({ sessionId: 'a'.repeat(32), imagePath: '/library/game.rvz' });
  assert.equal(launched.ok, false);
  assert.equal(launched.reason, 'launch-failed');
});

void test('a launcher with no Dolphin refuses rather than spawning nothing', async () => {
  let spawned = false;
  const launcher = new DolphinLauncher({ dolphinPath: null, spawnImpl: () => { spawned = true; return fakeChild(); } });
  const launched = await launcher.launch({ sessionId: 'a'.repeat(32), imagePath: '/library/game.rvz' });
  assert.equal(launched.reason, 'dolphin-missing');
  assert.equal(spawned, false);
});

void test('terminating asks politely before it insists', async () => {
  // A core mid-write to a memory card deserves a moment.
  const child = fakeChild();
  const launcher = new DolphinLauncher({ dolphinPath: '/usr/bin/dolphin-emu', spawnImpl: () => child });
  await launcher.launch({ sessionId: 'b'.repeat(32), imagePath: '/library/game.rvz' });

  const terminating = launcher.terminate('b'.repeat(32));
  child.emit('exit', 0, null);
  await terminating;
  assert.deepEqual(child.killed, ['SIGTERM'], 'a process that exits on request is never killed harder');
});

void test('a detection that has not finished yet lands on the browser core', () => {
  // The probe runs once at startup. A player who reaches a cabinet before it
  // finishes gets exactly what they would have had without the runtime, rather
  // than an error or a wait.
  const adapters = createDefaultAdapterRegistry();
  adapters.register(adapterModule.createPtcRuntimeGameCubeAdapter({}));
  for (const detection of [null, undefined, {}]) {
    const chosen = adapterModule.chooseGameCubeAdapter({ adapters, detection });
    assert.equal(chosen.adapter.id, 'gecko-gamecube', String(detection));
  }
});

/* Netplay. Dolphin has no flag for it; --config is the whole lever. */

void test('a host listens, a guest is pointed at the host', () => {
  const host = dolphin.buildNetplayArgs({ role: 'host', port: 2626, nickname: 'HOST' });
  assert.ok(host.includes('--config=Main.NetPlay.HostPort=2626'));
  assert.ok(host.includes('--config=Main.NetPlay.UseUPNP=True'), 'most players are behind a router');
  assert.ok(!host.some((a: string) => a.includes('NetPlay.Address')), 'a host connects to nobody');

  const guest = dolphin.buildNetplayArgs({ role: 'guest', hostAddress: '203.0.113.7', port: 2626, nickname: 'TWO' });
  assert.ok(guest.includes('--config=Main.NetPlay.Address=203.0.113.7'));
  assert.ok(guest.includes('--config=Main.NetPlay.ConnectPort=2626'));
});

void test('direct connection, not traversal', () => {
  // A traversal host code is generated inside Dolphin and shown in its window,
  // so the runtime cannot read it back out to hand to the other players.
  for (const role of ['host', 'guest']) {
    const args = dolphin.buildNetplayArgs({ role, hostAddress: '203.0.113.7', port: 2626, nickname: 'X' });
    assert.ok(args.includes('--config=Main.NetPlay.TraversalChoice=direct'), role);
  }
});

void test('a nickname cannot smuggle a second setting', () => {
  // Every argument is --config=Key=Value, so a comma or an equals sign in a
  // player-supplied name would be read by Dolphin as another assignment.
  const args = dolphin.buildNetplayArgs({
    role: 'host', port: 2626, nickname: 'evil,Main.Core.EnableCheats=True'
  });
  const nickname = args.find((a: string) => a.startsWith('--config=Main.NetPlay.Nickname='))!;
  const value = nickname.slice('--config=Main.NetPlay.Nickname='.length);
  // The separators are what matter, not the surviving letters: without an
  // equals sign or a comma there is no second assignment to be read.
  assert.ok(!value.includes(','), 'no comma survives');
  assert.ok(!value.includes('='), 'no equals sign survives');
  assert.ok(!args.some((a: string) => a.includes('EnableCheats=True')));
});

void test('an empty or unusable nickname still names somebody', () => {
  assert.equal(dolphin.sanitizeNickname('***'), 'PLAYER');
  assert.equal(dolphin.sanitizeNickname(''), 'PLAYER');
  assert.equal(dolphin.sanitizeNickname(null), 'PLAYER');
  assert.equal(dolphin.sanitizeNickname('a'.repeat(80)).length, 24);
});

void test('an address that could carry a setting is refused', () => {
  for (const bad of ['1.2.3.4,Main.Core.EnableCheats=True', 'host name', '', 'a'.repeat(60), '1.2.3.4"']) {
    assert.equal(dolphin.isRoutableAddress(bad), false, bad);
    assert.throws(() => dolphin.buildNetplayArgs({ role: 'guest', hostAddress: bad, port: 2626, nickname: 'X' }));
  }
  for (const good of ['203.0.113.7', '2001:db8::1', 'host.example.com']) {
    assert.equal(dolphin.isRoutableAddress(good), true, good);
  }
});

void test('a nonsense role or port is refused rather than defaulted', () => {
  assert.throws(() => dolphin.buildNetplayArgs({ role: 'spectator', port: 2626, nickname: 'X' }), /host or guest/);
  for (const port of [0, 80, 70000, 2626.5, null]) {
    assert.throws(() => dolphin.buildNetplayArgs({ role: 'host', port, nickname: 'X' }), /usable port/);
  }
});
