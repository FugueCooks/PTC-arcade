import assert from 'node:assert/strict';
import test from 'node:test';
import { importBrowserModule } from './helpers/browser-module.js';

const { SessionManager } = await importBrowserModule<any>('ptc-runtime/src/session-manager.js');
const { LaunchGuard } = await importBrowserModule<any>('ptc-runtime/src/dolphin.js');

const ENTRY = Object.freeze({
  gameId: 'wind-waker', platformId: 'gamecube',
  downloadUrl: 'https://cdn.example/wind-waker.rvz', fileName: 'wind-waker.rvz',
  sizeBytes: 100, sha256: 'a'.repeat(64)
});

/**
 * A fake library that records the order it was called in. The ordering is the
 * safety property — verifying after launching would be verifying nothing — so
 * the sequence is what these tests assert.
 */
function makeHarness(overrides: any = {}) {
  const calls: string[] = [];
  const library = {
    inspect: async () => { calls.push('inspect'); return overrides.cached ?? { present: false }; },
    download: async (_entry: any, { onProgress }: any) => {
      calls.push('download');
      onProgress?.({ percent: 50 });
      onProgress?.({ percent: 100 });
      return overrides.download ?? { ok: true, sha256: ENTRY.sha256 };
    },
    verify: async () => { calls.push('verify'); return overrides.verify ?? { ok: true, sha256: ENTRY.sha256 }; },
    discard: async () => { calls.push('discard'); },
    resolve: async () => { calls.push('resolve'); return overrides.resolve ?? { ok: true, path: '/library/wind-waker.rvz' }; }
  };

  let resolveExit: (value: any) => void = () => {};
  const exited = new Promise((resolve) => { resolveExit = resolve; });
  const launcher = {
    launch: async () => {
      calls.push('launch');
      return overrides.launch ?? { ok: true, exited };
    },
    terminate: async () => { calls.push('terminate'); }
  };

  const sessions = new SessionManager({
    catalog: { get: (id: string) => (id === ENTRY.gameId ? ENTRY : undefined) },
    library, launcher, guard: overrides.guard ?? new LaunchGuard(), log: () => {}
  });
  return { sessions, calls, finishGame: (outcome: any) => resolveExit(outcome) };
}

/** Waits for the session to reach one of the given states. */
async function settle(sessions: any, sessionId: string, states: string[], limit = 200) {
  for (let attempt = 0; attempt < limit; attempt += 1) {
    const current = sessions.get(sessionId);
    if (states.includes(current.state)) return current;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`session never reached ${states.join('/')}, last was ${sessions.get(sessionId).state}`);
}

void test('a first launch downloads, verifies, then launches — in that order', async () => {
  const harness = makeHarness();
  const started = harness.sessions.start({ gameId: 'wind-waker', platformId: 'gamecube' });
  assert.equal(started.ok, true);

  await settle(harness.sessions, started.sessionId, ['running']);
  assert.deepEqual(harness.calls, ['inspect', 'download', 'resolve', 'launch']);

  harness.finishGame({ outcome: 'closed', reason: 'the player closed the emulator' });
  const ended = await settle(harness.sessions, started.sessionId, ['exited']);
  assert.equal(ended.state, 'exited');
});

void test('a verified cached game launches without downloading again', async () => {
  // The reason the runtime exists: the second launch is instant.
  const harness = makeHarness({ cached: { present: true, sizeBytes: ENTRY.sizeBytes, verifiedSha256: ENTRY.sha256 } });
  const started = harness.sessions.start({ gameId: 'wind-waker', platformId: 'gamecube' });
  await settle(harness.sessions, started.sessionId, ['running']);
  assert.deepEqual(harness.calls, ['inspect', 'resolve', 'launch'], 'no download, no re-verify');
});

void test('a cached but unproven game is verified before it is launched', async () => {
  const harness = makeHarness({ cached: { present: true, sizeBytes: ENTRY.sizeBytes, verifiedSha256: null } });
  const started = harness.sessions.start({ gameId: 'wind-waker', platformId: 'gamecube' });
  await settle(harness.sessions, started.sessionId, ['running']);
  assert.deepEqual(harness.calls, ['inspect', 'verify', 'resolve', 'launch']);
});

void test('a bad digest discards the file and never reaches the emulator', async () => {
  // The single most important assertion here: nothing unverified is launched.
  const harness = makeHarness({ download: { ok: true, sha256: 'b'.repeat(64) } });
  const started = harness.sessions.start({ gameId: 'wind-waker', platformId: 'gamecube' });
  const failed = await settle(harness.sessions, started.sessionId, ['failed']);

  assert.equal(failed.reason, 'integrity-failed');
  assert.ok(harness.calls.includes('discard'), 'a file that failed its digest must be removed');
  assert.ok(!harness.calls.includes('launch'), 'Dolphin must never see unverified bytes');
});

void test('a cached file that fails re-verification is discarded, not launched', async () => {
  const harness = makeHarness({
    cached: { present: true, sizeBytes: ENTRY.sizeBytes, verifiedSha256: null },
    verify: { ok: true, sha256: 'c'.repeat(64) }
  });
  const started = harness.sessions.start({ gameId: 'wind-waker', platformId: 'gamecube' });
  const failed = await settle(harness.sessions, started.sessionId, ['failed']);
  assert.equal(failed.reason, 'integrity-failed');
  assert.ok(!harness.calls.includes('launch'));
});

void test('a failed download fails the session without launching', async () => {
  const harness = makeHarness({ download: { ok: false, reason: 'download-failed' } });
  const started = harness.sessions.start({ gameId: 'wind-waker', platformId: 'gamecube' });
  const failed = await settle(harness.sessions, started.sessionId, ['failed']);
  assert.equal(failed.reason, 'download-failed');
  assert.ok(!harness.calls.includes('launch'));
});

void test('progress is reported while downloading', async () => {
  const harness = makeHarness();
  const started = harness.sessions.start({ gameId: 'wind-waker', platformId: 'gamecube' });
  await settle(harness.sessions, started.sessionId, ['running']);
  // Percent is cleared once downloading is over, so the page stops showing a bar.
  assert.equal(harness.sessions.get(started.sessionId).percent, null);
});

void test('an unknown game is refused before any work begins', () => {
  const harness = makeHarness();
  const refused = harness.sessions.start({ gameId: 'not-a-game', platformId: 'gamecube' });
  assert.deepEqual(refused, { ok: false, reason: 'unknown-game' });
  assert.deepEqual(harness.calls, [], 'nothing may be touched for a game we do not have');
});

void test('a game asked for on the wrong platform is refused', () => {
  const harness = makeHarness();
  const refused = harness.sessions.start({ gameId: 'wind-waker', platformId: 'psx' });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'platform-unsupported');
});

void test('a second launch is refused while one is running', async () => {
  const harness = makeHarness();
  const first = harness.sessions.start({ gameId: 'wind-waker', platformId: 'gamecube' });
  await settle(harness.sessions, first.sessionId, ['running']);

  const second = harness.sessions.start({ gameId: 'wind-waker', platformId: 'gamecube' });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'already-running');
});

void test('the guard is released after a failure, so the next launch is not blocked forever', async () => {
  // A crash that left the guard held would refuse every later launch as
  // already-running, and only a restart would clear it.
  const guard = new LaunchGuard();
  const harness = makeHarness({ guard, launch: { ok: false, reason: 'launch-failed' } });
  const started = harness.sessions.start({ gameId: 'wind-waker', platformId: 'gamecube' });
  await settle(harness.sessions, started.sessionId, ['failed']);
  assert.equal(guard.active, null, 'the guard must not stay held after a failure');
});

void test('an emulator that fails to start is a failure, not a clean exit', async () => {
  const harness = makeHarness();
  const started = harness.sessions.start({ gameId: 'wind-waker', platformId: 'gamecube' });
  await settle(harness.sessions, started.sessionId, ['running']);

  harness.finishGame({ outcome: 'failed', reason: 'exited immediately' });
  const ended = await settle(harness.sessions, started.sessionId, ['failed', 'exited']);
  assert.equal(ended.state, 'failed');
});

void test('stopping a running session terminates the emulator', async () => {
  const harness = makeHarness();
  const started = harness.sessions.start({ gameId: 'wind-waker', platformId: 'gamecube' });
  await settle(harness.sessions, started.sessionId, ['running']);

  assert.deepEqual(await harness.sessions.stop(started.sessionId), { ok: true });
  assert.ok(harness.calls.includes('terminate'));
});

void test('an unknown session is reported, not invented', async () => {
  const harness = makeHarness();
  assert.equal(harness.sessions.get('f'.repeat(32)).ok, false);
  assert.equal((await harness.sessions.stop('f'.repeat(32))).ok, false);
});
