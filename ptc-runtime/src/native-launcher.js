import { spawn } from 'node:child_process';
import { interpretExit } from './dolphin.js';

/**
 * Runs a native emulator and watches it.
 *
 * Everything here is the same whichever emulator it is: spawn without a shell,
 * treat surviving a few seconds as the window having appeared, turn the exit
 * into something the page can render, and give a core mid-write to a memory
 * card a moment before SIGKILL. Only the binary, its argument list, and the
 * reason given when it is missing differ, so those are injected and this is
 * the one copy of the part that matters.
 *
 * `spawn` without a shell, always: a shell between here and the emulator would
 * reintroduce quoting as an attack surface, and there is nothing a shell would
 * add. The argument list comes from a builder that takes named values rather
 * than a list, so there is no seam where an extra argument could be appended.
 */
export class NativeEmulatorLauncher {
  #binaryPath;
  #buildArgs;
  #missingReason;
  #spawnImpl;
  #now;
  #active = new Map();

  constructor({ binaryPath, buildArgs, missingReason, spawnImpl = spawn, now = () => Date.now() }) {
    this.#binaryPath = binaryPath ?? null;
    this.#buildArgs = buildArgs;
    this.#missingReason = missingReason;
    this.#spawnImpl = spawnImpl;
    this.#now = now;
  }

  get available() { return Boolean(this.#binaryPath); }

  async launch({ sessionId, imagePath }) {
    if (!this.#binaryPath) return { ok: false, reason: this.#missingReason };

    let args;
    try {
      args = this.#buildArgs({ imagePath });
    } catch {
      return { ok: false, reason: 'launch-failed' };
    }

    const startedAt = this.#now();
    let child;
    try {
      child = this.#spawnImpl(this.#binaryPath, args, {
        // No shell, and no inherited stdio: the runtime's console is not the
        // emulator's, and a full pipe buffer would stall the game.
        shell: false,
        stdio: 'ignore',
        detached: false,
        windowsHide: false
      });
    } catch {
      return { ok: false, reason: 'launch-failed' };
    }

    const record = { child, startedAt, windowAppeared: false };
    this.#active.set(sessionId, record);

    // Neither emulator signals that its window opened, so survival stands in
    // for it: a process still alive after a few seconds got past the failures
    // that kill it immediately — a missing DLL, an unreadable image, a bad flag.
    const windowTimer = setTimeout(() => { record.windowAppeared = true; }, 3_000);
    if (typeof windowTimer.unref === 'function') windowTimer.unref();

    const exited = new Promise((resolve) => {
      const finish = (code, signal) => {
        clearTimeout(windowTimer);
        this.#active.delete(sessionId);
        resolve(interpretExit({
          code, signal,
          ranForMs: this.#now() - startedAt,
          windowAppeared: record.windowAppeared
        }));
      };
      child.once('exit', finish);
      child.once('error', () => finish(null, null));
    });

    return { ok: true, exited };
  }

  /** Closes a running emulator, for a player who left the cabinet in the arcade. */
  async terminate(sessionId) {
    const record = this.#active.get(sessionId);
    if (!record) return;
    record.child.kill();
    await new Promise((resolve) => {
      const timer = setTimeout(() => { record.child.kill('SIGKILL'); resolve(); }, 5_000);
      record.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}
