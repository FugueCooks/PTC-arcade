import { randomBytes } from 'node:crypto';
import { FAILURE_REASONS, SESSION_STATES, canTransition, isTerminalState } from '../../emulators/ptc-runtime/protocol.js';
import { planLaunch, verifyDigest } from './library.js';

/**
 * One launch, from a game id to a running emulator and back.
 *
 * Everything with a side effect is injected — the catalogue, the library, the
 * launcher, the clock — so the order of operations can be tested without a
 * disk, a network, or Dolphin. That matters more than usual here: the sequence
 * ends in a native process, and the steps that must not be skipped (verify
 * before launch, above all) are exactly the ones hardest to exercise by hand.
 */
export class SessionManager {
  #sessions = new Map();
  #catalog;
  #library;
  #launcher;
  #guard;
  #now;
  #log;
  #retention;

  constructor({ catalog, library, launcher, guard, now = () => Date.now(), log = () => {}, retentionMs = 300_000 }) {
    this.#catalog = catalog;
    this.#library = library;
    this.#launcher = launcher;
    this.#guard = guard;
    this.#now = now;
    this.#log = log;
    this.#retention = retentionMs;
  }

  /**
   * Begins a session and returns immediately.
   *
   * The work runs detached because a first launch downloads well over a
   * gigabyte: holding the request open for that would time out in every layer
   * between the page and here. The page follows progress by polling the session.
   */
  start({ gameId, platformId, cabinetId }) {
    const entry = this.#catalog.get(gameId);
    if (!entry) return { ok: false, reason: FAILURE_REASONS.UNKNOWN_GAME };
    if (entry.platformId !== platformId) return { ok: false, reason: FAILURE_REASONS.PLATFORM_UNSUPPORTED };

    const sessionId = randomBytes(16).toString('hex');
    const claim = this.#guard.claim(sessionId);
    if (!claim.ok) return { ok: false, reason: FAILURE_REASONS.ALREADY_RUNNING };

    const session = {
      sessionId, gameId, cabinetId: cabinetId ?? null,
      state: SESSION_STATES.RESOLVING, percent: null, reason: null,
      startedAt: this.#now(), endedAt: null, controller: new AbortController()
    };
    this.#sessions.set(sessionId, session);
    this.#log('session_started', { sessionId, gameId, cabinetId: session.cabinetId });

    void this.#run(session, entry);
    return { ok: true, sessionId };
  }

  get(sessionId) {
    const session = this.#sessions.get(sessionId);
    if (!session) return { ok: false, reason: 'unknown-session' };
    return {
      ok: true, sessionId, state: session.state, percent: session.percent,
      reason: session.reason, gameId: session.gameId, cabinetId: session.cabinetId
    };
  }

  /** Cancels a download in flight, or closes a running emulator. */
  async stop(sessionId) {
    const session = this.#sessions.get(sessionId);
    if (!session) return { ok: false, reason: 'unknown-session' };
    session.controller.abort();
    if (session.state === SESSION_STATES.RUNNING) await this.#launcher.terminate?.(sessionId);
    return { ok: true };
  }

  /** Sessions the page stopped following, cleared once they are old enough. */
  sweep() {
    const cutoff = this.#now() - this.#retention;
    for (const [id, session] of this.#sessions) {
      if (isTerminalState(session.state) && (session.endedAt ?? 0) < cutoff) this.#sessions.delete(id);
    }
  }

  /**
   * Refuses a transition the protocol does not allow rather than performing it.
   *
   * The order is the safety property — verifying after launching would be
   * verifying nothing — so an out-of-order move is a bug to surface, not a
   * state to accept.
   */
  #move(session, state, extra = {}) {
    if (!canTransition(session.state, state)) {
      this.#log('session_invalid_transition', { sessionId: session.sessionId, from: session.state, to: state });
      return false;
    }
    session.state = state;
    Object.assign(session, extra);
    if (isTerminalState(state)) {
      session.endedAt = this.#now();
      this.#guard.release(session.sessionId);
    }
    return true;
  }

  #fail(session, reason) {
    this.#move(session, SESSION_STATES.FAILED, { reason, percent: null });
    this.#log('session_failed', { sessionId: session.sessionId, reason });
  }

  async #run(session, entry) {
    try {
      const cached = await this.#library.inspect(entry);
      const plan = planLaunch({ entry, cached });

      if (plan.action === 'refuse') return this.#fail(session, FAILURE_REASONS.UNKNOWN_GAME);

      if (plan.action === 'download') {
        if (!this.#move(session, SESSION_STATES.DOWNLOADING, { percent: 0 })) return;
        const downloaded = await this.#library.download(entry, {
          signal: session.controller.signal,
          onProgress: ({ percent }) => { session.percent = percent; }
        });
        if (session.controller.signal.aborted) return this.#fail(session, 'cancelled');
        if (!downloaded.ok) return this.#fail(session, downloaded.reason ?? FAILURE_REASONS.DOWNLOAD_FAILED);

        // The digest computed during the transfer is checked here rather than
        // trusted because it was produced alongside the bytes.
        if (!this.#move(session, SESSION_STATES.VERIFYING, { percent: null })) return;
        const digest = verifyDigest(downloaded.sha256, entry.sha256);
        if (!digest.ok) {
          await this.#library.discard(entry);
          return this.#fail(session, FAILURE_REASONS.INTEGRITY_FAILED);
        }
      } else if (plan.action === 'verify') {
        // Cached but unproven: re-read it rather than launch on the strength of
        // a file merely being the right size.
        if (!this.#move(session, SESSION_STATES.VERIFYING)) return;
        const rechecked = await this.#library.verify(entry, { signal: session.controller.signal });
        if (!rechecked.ok || !verifyDigest(rechecked.sha256, entry.sha256).ok) {
          await this.#library.discard(entry);
          return this.#fail(session, FAILURE_REASONS.INTEGRITY_FAILED);
        }
      }

      if (session.controller.signal.aborted) return this.#fail(session, 'cancelled');

      const resolved = await this.#library.resolve(entry);
      if (!resolved.ok) return this.#fail(session, resolved.reason ?? FAILURE_REASONS.LAUNCH_FAILED);

      if (!this.#move(session, SESSION_STATES.LAUNCHING)) return;
      const launched = await this.#launcher.launch({
        sessionId: session.sessionId, imagePath: resolved.path, gameId: session.gameId
      });
      if (!launched.ok) return this.#fail(session, launched.reason ?? FAILURE_REASONS.LAUNCH_FAILED);

      if (!this.#move(session, SESSION_STATES.RUNNING)) return;
      this.#log('session_running', { sessionId: session.sessionId, gameId: session.gameId });

      const exit = await launched.exited;
      if (exit.outcome === 'failed') return this.#fail(session, FAILURE_REASONS.LAUNCH_FAILED);
      this.#move(session, SESSION_STATES.EXITED, { reason: exit.reason ?? null });
      this.#log('session_exited', { sessionId: session.sessionId, outcome: exit.outcome });
    } catch (error) {
      // A crash here would otherwise leave the guard held and every later
      // launch refused as already-running.
      this.#fail(session, FAILURE_REASONS.LAUNCH_FAILED);
      this.#log('session_crashed', { sessionId: session.sessionId, message: error?.message ?? 'unknown' });
    } finally {
      this.#guard.release(session.sessionId);
    }
  }
}
