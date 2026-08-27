import { spawn } from 'node:child_process';
import { FAILURE_REASONS } from '../../emulators/ptc-runtime/protocol.js';
import { buildDolphinArgs, interpretExit, locateDolphin } from './dolphin.js';

/**
 * Runs Dolphin and watches it.
 *
 * `spawn` without a shell, always: a shell between here and the emulator would
 * reintroduce quoting as an attack surface, and there is nothing a shell would
 * add. The argument list comes from `buildDolphinArgs`, which takes named
 * values rather than a list, so there is no seam where an extra argument could
 * be appended.
 */
export class DolphinLauncher {
  #dolphinPath;
  #userDirectory;
  #spawnImpl;
  #now;
  #active = new Map();

  constructor({ dolphinPath, userDirectory, spawnImpl = spawn, now = () => Date.now() }) {
    this.#dolphinPath = dolphinPath;
    this.#userDirectory = userDirectory;
    this.#spawnImpl = spawnImpl;
    this.#now = now;
  }

  static discover({ platform = process.platform, configuredPath = null, exists }) {
    return locateDolphin({ platform, configuredPath, exists });
  }

  get available() { return Boolean(this.#dolphinPath); }

  async launch({ sessionId, imagePath }) {
    if (!this.#dolphinPath) return { ok: false, reason: FAILURE_REASONS.DOLPHIN_MISSING };

    let args;
    try {
      args = buildDolphinArgs({ imagePath, userDirectory: this.#userDirectory });
    } catch {
      return { ok: false, reason: FAILURE_REASONS.LAUNCH_FAILED };
    }

    const startedAt = this.#now();
    let child;
    try {
      child = this.#spawnImpl(this.#dolphinPath, args, {
        // No shell, and no inherited stdio: the runtime's console is not the
        // emulator's, and a full pipe buffer would stall the game.
        shell: false,
        stdio: 'ignore',
        detached: false,
        windowsHide: false
      });
    } catch {
      return { ok: false, reason: FAILURE_REASONS.LAUNCH_FAILED };
    }

    const record = { child, startedAt, windowAppeared: false };
    this.#active.set(sessionId, record);

    // Dolphin gives no signal that its window opened, so survival stands in for
    // it: a process still alive after a few seconds got past the failures that
    // kill it immediately — a missing DLL, an unreadable image, a bad flag.
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
    // A core mid-write to a memory card deserves a moment before SIGKILL.
    await new Promise((resolve) => {
      const timer = setTimeout(() => { record.child.kill('SIGKILL'); resolve(); }, 5_000);
      record.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}
