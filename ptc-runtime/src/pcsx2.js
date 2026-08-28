/**
 * PCSX2, the native PlayStation 2 path.
 *
 * The browser core plays some PS2 titles well and others badly. Mega Man X7
 * holds a median of 40 f/s in Play! with dips into the twenties, and no amount
 * of caching or scheduling moves that: it is the core's speed for that game.
 * So demanding titles take the same route GameCube already does — a native
 * emulator, driven by this runtime, with the arcade still owning the session.
 *
 * The shape here deliberately matches `dolphin.js`. Two emulators launched two
 * different ways would be two things to reason about when a launch fails.
 */

/** Where PCSX2 usually lives, in probe order. Windows first; this ships there first. */
export const PCSX2_CANDIDATES = Object.freeze({
  win32: [
    'C:\\Program Files\\PCSX2\\pcsx2-qt.exe',
    'C:\\Program Files\\PCSX2\\pcsx2.exe',
    'C:\\Program Files (x86)\\PCSX2\\pcsx2-qt.exe',
    'C:\\Program Files (x86)\\PCSX2\\pcsx2.exe'
  ],
  darwin: ['/Applications/PCSX2.app/Contents/MacOS/PCSX2'],
  linux: ['/usr/bin/pcsx2-qt', '/usr/local/bin/pcsx2-qt', '/usr/bin/pcsx2']
});

/**
 * The complete argument list for one launch.
 *
 * `-batch` starts the game and skips the library window, `-fullscreen` gives
 * the player the screen they came for, and `--` ends the flags so a path can
 * never be read as one. As with Dolphin the shape is fixed and only the image
 * path varies, and that came from the catalogue rather than from the page.
 */
export function buildPcsx2Args({ imagePath, fullscreen = true }) {
  if (typeof imagePath !== 'string' || imagePath === '') {
    throw new Error('A launch needs a resolved image path.');
  }
  // Belt and braces: `--` already ends the flags, but a path that looks like a
  // flag is a sign something upstream is wrong and is worth refusing outright.
  if (imagePath.startsWith('-')) throw new Error('Refusing an image path that would parse as a flag.');

  const args = ['-batch'];
  if (fullscreen) args.push('-fullscreen');
  args.push('--', imagePath);
  return args;
}

/**
 * Finds an installed PCSX2.
 *
 * A configured path wins, so a portable build is not forced into a standard
 * location, and `exists` is injected so this is testable on a machine with no
 * PCSX2 at all — which is every machine this repository's tests run on.
 */
export function locatePcsx2({ platform, configuredPath, exists, candidates = PCSX2_CANDIDATES }) {
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
