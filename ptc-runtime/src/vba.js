/**
 * VisualBoyAdvance-M, the native Game Boy / Game Boy Color / Game Boy Advance
 * path. One emulator covers all three handhelds, which is why the arcade's
 * Game Boy machines share one adapter across the whole line.
 *
 * The shape deliberately matches `pcsx2.js` and `dolphin.js` — one way to
 * locate an emulator, one way to build its arguments.
 */

/** Where VBA-M usually lives, in probe order. Windows first; it ships there first. */
export const VBA_CANDIDATES = Object.freeze({
  win32: [
    'C:\\Program Files\\visualboyadvance-m\\visualboyadvance-m.exe',
    'C:\\Program Files (x86)\\visualboyadvance-m\\visualboyadvance-m.exe',
    'C:\\Program Files\\VisualBoyAdvance-M\\visualboyadvance-m.exe'
  ],
  darwin: ['/Applications/visualboyadvance-m.app/Contents/MacOS/visualboyadvance-m'],
  linux: ['/usr/bin/visualboyadvance-m', '/usr/local/bin/visualboyadvance-m']
});

/**
 * The complete argument list for one launch: VBA-M takes the ROM path
 * positionally, zipped or raw — it reads archives itself. `--fullscreen`
 * gives the player the screen they came for.
 */
export function buildVbaArgs({ imagePath }) {
  if (typeof imagePath !== 'string' || imagePath.length === 0) {
    throw new Error('VisualBoyAdvance-M needs the path of the image it should boot.');
  }
  return Object.freeze(['--fullscreen', imagePath]);
}

/** The same discovery shape as every other launcher: ok, path, source. */
export function locateVba({ platform, configuredPath = null, exists, candidates = VBA_CANDIDATES }) {
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
