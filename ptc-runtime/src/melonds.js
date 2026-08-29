/**
 * melonDS, the native Nintendo DS path.
 *
 * There is no browser DS core in the arcade at all: the DS machines in the
 * Pokemon arena run through the runtime or not at all, the way GameCube would
 * without Gecko. The shape deliberately matches `pcsx2.js` and `dolphin.js` —
 * one way to locate an emulator, one way to build its arguments.
 */

/** Where melonDS usually lives, in probe order. Windows first; it ships there first. */
export const MELONDS_CANDIDATES = Object.freeze({
  win32: [
    'C:\\Program Files\\melonDS\\melonDS.exe',
    'C:\\Program Files (x86)\\melonDS\\melonDS.exe'
  ],
  darwin: ['/Applications/melonDS.app/Contents/MacOS/melonDS'],
  linux: ['/usr/bin/melonDS', '/usr/local/bin/melonDS']
});

/**
 * The complete argument list for one launch: melonDS takes the ROM path
 * positionally, zipped or raw — it reads archives itself. `-f` asks for
 * fullscreen, which it honours from 0.9.5 on and ignores harmlessly before.
 */
export function buildMelondsArgs({ imagePath }) {
  if (typeof imagePath !== 'string' || imagePath.length === 0) {
    throw new Error('melonDS needs the path of the image it should boot.');
  }
  return Object.freeze(['-f', imagePath]);
}

/** The same discovery shape as every other launcher: ok, path, source. */
export function locateMelonds({ platform, configuredPath = null, exists, candidates = MELONDS_CANDIDATES }) {
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
