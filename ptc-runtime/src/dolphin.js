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

/**
 * Where Dolphin usually lives, in probe order. Windows first; this ships there
 * first.
 *
 * The installer's own default is "Dolphin Emulator" and the release zips unpack
 * to "Dolphin-x64", so a bare "Dolphin" folder is the one shape a player is
 * least likely to end up with. All three are probed rather than assumed, and a
 * build living anywhere else is what the config's dolphinPath is for.
 */
export const DOLPHIN_CANDIDATES = Object.freeze({
  win32: [
    'C:\\Program Files\\Dolphin Emulator\\Dolphin.exe',
    'C:\\Program Files\\Dolphin-x64\\Dolphin.exe',
    'C:\\Program Files\\Dolphin\\Dolphin.exe',
    'C:\\Program Files (x86)\\Dolphin Emulator\\Dolphin.exe',
    'C:\\Program Files (x86)\\Dolphin-x64\\Dolphin.exe',
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

/**
 * Netplay, as far as Dolphin's command line actually goes.
 *
 * Dolphin has no netplay flag. Its complete option list — read from
 * UICommon/CommandLineParse.cpp rather than remembered — is user, movie, exec,
 * nand_title, config, save_state, debugger, logger, batch, confirm,
 * video_backend and audio_emulation. Nothing starts or joins a session.
 *
 * What `--config` can do is set any value in Dolphin's configuration, and the
 * netplay dialog reads its fields from exactly those values. So the runtime
 * fills in the address, the port and the nickname, and the player presses
 * Connect. That is one click rather than a form, and it is the honest limit of
 * what can be automated without patching Dolphin.
 *
 * Direct connection rather than Dolphin's traversal server: a traversal host
 * code is generated inside Dolphin and shown in its window, so the runtime has
 * no way to read it back out and hand it to the other players. The arcade
 * already knows where every player is connected from, which is what makes the
 * direct path possible at all.
 */
const NETPLAY = Object.freeze({
  traversalChoice: 'Main.NetPlay.TraversalChoice',
  hostPort: 'Main.NetPlay.HostPort',
  address: 'Main.NetPlay.Address',
  connectPort: 'Main.NetPlay.ConnectPort',
  nickname: 'Main.NetPlay.Nickname',
  useUpnp: 'Main.NetPlay.UseUPNP'
});

/** A nickname Dolphin will accept, and that cannot smuggle a second setting. */
export function sanitizeNickname(displayName) {
  const cleaned = String(displayName ?? '')
    .normalize('NFKC')
    // A comma or an equals sign would be read as another config assignment.
    .replace(/[^A-Za-z0-9 ._-]/g, '')
    .trim()
    .slice(0, 24);
  return cleaned || 'PLAYER';
}

/**
 * The `--config` arguments that prepare one seat's netplay.
 *
 * Seat zero hosts and listens; everyone else connects to it. The role comes
 * from the server's seat order, so the two sides cannot disagree about who is
 * waiting for whom.
 */
export function buildNetplayArgs({ role, hostAddress, port, nickname }) {
  if (role !== 'host' && role !== 'guest') throw new Error('A netplay seat is either host or guest.');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Netplay needs a usable port.');

  const args = [
    `--config=${NETPLAY.traversalChoice}=direct`,
    `--config=${NETPLAY.nickname}=${sanitizeNickname(nickname)}`
  ];

  if (role === 'host') {
    args.push(`--config=${NETPLAY.hostPort}=${port}`);
    // Most players are behind a router, and without this the guests cannot
    // reach the host at all.
    args.push(`--config=${NETPLAY.useUpnp}=True`);
    return args;
  }

  if (!isRoutableAddress(hostAddress)) throw new Error('A guest needs the host address.');
  args.push(`--config=${NETPLAY.address}=${hostAddress}`);
  args.push(`--config=${NETPLAY.connectPort}=${port}`);
  return args;
}

/**
 * An address the runtime will pass on.
 *
 * Refuses anything that is not a plain host: a value carrying a comma or an
 * equals sign would be read by Dolphin as a further configuration assignment,
 * which would turn "who am I connecting to" into "change any setting you like".
 */
export function isRoutableAddress(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 45) return false;
  if (/[,=\s"']/.test(value)) return false;
  return /^[0-9.]+$/.test(value) || /^[0-9a-fA-F:]+$/.test(value) || /^[A-Za-z0-9.-]+$/.test(value);
}
