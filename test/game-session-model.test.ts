import assert from 'node:assert/strict';
import test from 'node:test';
import {
  InvalidSessionTransitionError, canTransition, createGameSession, dispose, isTerminal, stop, transition,
  type GameSession, type GameSessionStatus
} from '../server/src/domain/game-session.js';

function session(): GameSession {
  return createGameSession({
    sessionId: 's-1', playerId: 'p-1', roomId: 'main', cabinetId: 'pixel-rally',
    gameId: 'tony-hawks-pro-skater-2', emulatorAdapterId: 'emulatorjs', now: 1_000
  });
}

/** Drives a session along the ordinary happy path. */
function advance(from: GameSession, path: readonly GameSessionStatus[], now = 2_000): GameSession {
  return path.reduce((current, status) => transition(current, status, { now }), from);
}

void test('a new session starts in CREATED with no lifecycle timestamps', () => {
  const created = session();
  assert.equal(created.status, 'CREATED');
  assert.equal(created.createdAt, 1_000);
  assert.equal(created.startedAt, null);
  assert.equal(created.endedAt, null);
  assert.equal(created.stopReason, null);
  // Declared Phase 12 seams stay inert.
  assert.equal(created.competitiveAttemptId, null);
  assert.equal(created.replayCaptureStatus, 'NOT_APPLICABLE');
  assert.equal(created.scoreSubmissionStatus, 'NOT_APPLICABLE');
});

void test('the full lifecycle stamps each timestamp on the right transition', () => {
  // Milestone 11.40 test 6: session lifecycle transitions are valid.
  const ready = advance(session(), ['PREFLIGHT', 'READY'], 2_000);
  assert.equal(ready.preflightCompletedAt, 2_000);

  const active = advance(ready, ['STARTING', 'ACTIVE'], 3_000);
  assert.equal(active.startedAt, 3_000);

  const paused = transition(active, 'PAUSED', { now: 4_000 });
  assert.equal(paused.pausedAt, 4_000);

  const resumed = transition(paused, 'ACTIVE', { now: 5_000 });
  assert.equal(resumed.pausedAt, null);
  assert.equal(resumed.startedAt, 3_000, 'resuming must not restamp the original start');

  const completed = transition(stop(resumed, 'player-exit', 6_000), 'COMPLETED', { now: 6_000 });
  assert.equal(completed.endedAt, 6_000);
  assert.equal(completed.stopReason, 'player-exit');
});

void test('invalid transitions are rejected rather than silently coerced', () => {
  const created = session();
  assert.throws(() => transition(created, 'ACTIVE'), InvalidSessionTransitionError);
  assert.throws(() => transition(created, 'COMPLETED'), InvalidSessionTransitionError);
  assert.throws(() => transition(created, 'DISPOSED'), InvalidSessionTransitionError);

  const disposed = dispose(session(), 7_000);
  assert.equal(disposed.status, 'DISPOSED');
  for (const status of ['CREATED', 'ACTIVE', 'COMPLETED'] as GameSessionStatus[]) {
    assert.throws(() => transition(disposed, status), InvalidSessionTransitionError);
  }
  assert.equal(canTransition('DISPOSED', 'ACTIVE'), false);
  assert.equal(canTransition('ACTIVE', 'STOPPING'), true);
});

void test('repeated stop is harmless and preserves the first reason', () => {
  // Milestone 11.40 test 7. A cabinet release, a disconnect, and an emulator
  // error can all race to end one session; the first reason is the true one.
  const active = advance(session(), ['PREFLIGHT', 'READY', 'STARTING', 'ACTIVE']);
  const stopped = stop(active, 'player-exit', 5_000);
  const again = stop(stopped, 'disconnect', 6_000);
  const third = stop(again, 'emulator-error', 7_000);
  assert.equal(again, stopped, 'a second stop must return the same object');
  assert.equal(third, stopped);
  assert.equal(stopped.stopReason, 'player-exit');
  assert.equal(stopped.status, 'STOPPING');
});

void test('repeated dispose is idempotent from any state', () => {
  for (const path of [[], ['PREFLIGHT'], ['PREFLIGHT', 'READY'], ['PREFLIGHT', 'READY', 'STARTING', 'ACTIVE']] as GameSessionStatus[][]) {
    const disposed = dispose(advance(session(), path), 8_000);
    assert.equal(disposed.status, 'DISPOSED');
    assert.equal(dispose(disposed, 9_000), disposed, 'a second dispose must be a no-op');
    assert.ok(isTerminal(disposed.status));
  }
});

void test('a failed session can still be disposed and keeps its failure reason', () => {
  // Milestone 11.40 test 8's precondition: an emulator failure must settle the
  // session so the cabinet release path can run.
  const preflighting = transition(session(), 'PREFLIGHT', { now: 2_000 });
  const failed = transition(preflighting, 'FAILED', { now: 3_000, stopReason: 'preflight-failed' });
  assert.equal(failed.endedAt, 3_000);
  const disposed = dispose(failed, 4_000);
  assert.equal(disposed.status, 'DISPOSED');
  assert.equal(disposed.stopReason, 'preflight-failed');
  assert.equal(disposed.endedAt, 3_000, 'dispose must not restamp the end time');
});

void test('sessions are frozen so no caller can mutate one in place', () => {
  const created = session();
  assert.ok(Object.isFrozen(created));
  assert.throws(() => { (created as { status: string }).status = 'ACTIVE'; }, TypeError);
});
