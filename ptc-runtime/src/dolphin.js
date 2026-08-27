/**
 * Starting Dolphin, and the argument list it is started with.
 *
 * The argv is built here and nowhere else, from values the runtime already
 * resolved itself. Nothing a page sent reaches this file except by way of a
 * catalogue entry the runtime fetched and validated — no flags, no switches, no
 * "extra arguments" field. A page that could append one argument to an emulator
 * invocation could append `--exec` to something else.
 *
 * Dolphin is launched as a separate process, never linked into this one. That
 * is the arrangement its GPL licence is easiest to satisfy under, and it also
 * means a crash in the emulator cannot take the runtime with it.
 */

/** Where Dolphin usually lives, in probe order. Windows first; this ships there first. */
export const DOLPHIN_CANDIDATES = Object.freeze({
  win32: [
    'C:\\Program Files\\Dolphin\\Dolphin.exe',
    'C:\\Program Files (x86)\\Dolphin\\Dolphin.exe'
  ],
  darwin: ['/Applications/Dolphin.app/Contents/MacOS/Dolphin'],
  linux: ['/usr/bin/dolphin-emu', '/usr/local/bin/dolphin-emu']
});

/**
 * The complete argument list for one launch.
 *
 * `--batch` stops Dolphin opening its own library window, `--exec` names the
 * disc image, and `--config` pins the two settings a cabinet depends on. The
 * shape is fixed: the only value that varies is the image path, and that came
 * from the catalogue rather than the page.
 */
export function buildDolphinArgs({ imagePath, userDirectory, fullscreen = true }) {
  if (typeof imagePath !== 'string' || imagePath === '') {
    throw new Error('A launch needs a resolved image path.');
  }
  // A path beginning with a dash would be read as a flag rather than a file.
  if (imagePath.startsWith('-')) throw new Error('Refusing an image path that would parse as a flag.');

  const args = ['--batch', `--exec=${imagePath}`];
  if (userDirectory) args.push(`--user=${userDirectory}`);
  args.push(`--config=Dolphin.Display.Fullscreen=${fullscreen ? 'True' : 'False'}`);
  // The player came from a browser and expects the window to be theirs; without
  // this Dolphin can start behind the browser with no indication it started.
  args.push('--config=Dolphin.Display.RenderToMain=False');
  return args;
}

/**
 * Finds an installed Dolphin.
 *
 * A configured path wins, so a player with a portable build is not forced into
 * a standard location. `exists` is injected rather than imported so this is
 * testable on a machine with no Dolphin at all — which is every machine this
 * repository's tests run on.
 */
export function locateDolphin({ platform, configuredPath, exists, candidates = DOLPHIN_CANDIDATES }) {
  if (configuredPath) {
    return exists(configuredPath)
      ? { ok: true, path: configuredPath, source: 'configured' }
      : { ok: false, reason: 'configured-path-missing', path: configuredPath };
  }
  for (const candidate of candidates[platform] ?? []) {
    if (exists(candidate)) return { ok: true, path: candidate, source: 'discovered' };
  }
  return { ok: false, reason: 'not-found' };
}

/**
 * Turns an exit into something the page can render.
 *
 * A player closing the emulator window is the ordinary ending, and it must not
 * read as an error — the arcade releases the cabinet either way, but the
 * message the player sees is different. Dolphin exits non-zero on a clean
 * close often enough that the code alone cannot carry that distinction, so a
 * signal or a failure before the window appeared is what marks a real fault.
 */
export function interpretExit({ code, signal, ranForMs, windowAppeared }) {
  if (signal) return { outcome: 'terminated', reason: `signal ${signal}` };
  // Nothing on screen and gone within a couple of seconds is a failure to
  // start, whatever it exited with.
  if (!windowAppeared && ranForMs < 2_000) {
    return { outcome: 'failed', reason: code === 0 ? 'exited immediately' : `exited with code ${code}` };
  }
  if (code === 0 || windowAppeared) return { outcome: 'closed', reason: 'the player closed the emulator' };
  return { outcome: 'failed', reason: `exited with code ${code}` };
}

/**
 * One launch at a time.
 *
 * Two Dolphins on one disc image fight over the same save files, and the arcade
 * holds one cabinet per player anyway. Refusing here keeps that true even if a
 * second page, or a stale tab, asks.
 */
export class LaunchGuard {
  #active = null;

  get active() { return this.#active; }

  claim(sessionId) {
    if (this.#active) return { ok: false, reason: 'already-running', activeSessionId: this.#active };
    this.#active = sessionId;
    return { ok: true };
  }

  release(sessionId) {
    if (this.#active === sessionId) this.#active = null;
  }
}
