/**
 * The contract between the arcade page and the PTC Arcade Runtime.
 *
 * Deliberately one plain-JavaScript module imported by both sides rather than a
 * TypeScript type shared by one and re-typed by the other. The GameCube launch
 * path already lost a day to exactly that: the browser registry called a field
 * `system`, the server called it `platformId`, and every SNES cabinet quietly
 * launched on the PlayStation core. A local process and a web page drifting
 * apart the same way would be far harder to see, because half the evidence
 * lives on the player's machine.
 *
 * Everything here is pure: no I/O, no Node, no DOM. Both sides import it.
 */

/**
 * Bumped only for a breaking change. The runtime refuses a page speaking a
 * different major version rather than guessing at the difference — a
 * mismatched launch means a native process started with the wrong arguments.
 */
export const PROTOCOL_VERSION = 1;

/** The loopback port range the runtime binds, in probe order. */
export const RUNTIME_PORTS = Object.freeze([49731, 49732, 49733, 49734]);

/** Pages the runtime will speak to. Anything else is refused outright. */
export const ALLOWED_ORIGINS = Object.freeze([
  'https://ptcarcade.fun',
  'https://www.ptcarcade.fun',
  // Development only, and only loopback: a LAN address here would let anything
  // on the network drive a local process.
  'http://localhost:8099',
  'http://127.0.0.1:8099'
]);

/** Platforms the runtime claims. GameCube first; others follow the same path. */
export const RUNTIME_PLATFORMS = Object.freeze(['gamecube', 'ps2']);

export const RUNTIME_ADAPTER_ID = 'ptc-runtime-gamecube';
export const RUNTIME_PS2_ADAPTER_ID = 'ptc-runtime-ps2';
/** Which adapter drives which platform natively. */
export const RUNTIME_ADAPTER_IDS = Object.freeze({ gamecube: RUNTIME_ADAPTER_ID, ps2: RUNTIME_PS2_ADAPTER_ID });

/** Session lifecycle, as reported to the page. */
export const SESSION_STATES = Object.freeze({
  RESOLVING: 'resolving',
  DOWNLOADING: 'downloading',
  VERIFYING: 'verifying',
  LAUNCHING: 'launching',
  RUNNING: 'running',
  EXITED: 'exited',
  FAILED: 'failed'
});

const TERMINAL_STATES = new Set([SESSION_STATES.EXITED, SESSION_STATES.FAILED]);

/** Transitions the runtime may report. A skipped state is a bug, not a shortcut. */
const ALLOWED_TRANSITIONS = Object.freeze({
  [SESSION_STATES.RESOLVING]: [SESSION_STATES.DOWNLOADING, SESSION_STATES.VERIFYING, SESSION_STATES.LAUNCHING, SESSION_STATES.FAILED],
  [SESSION_STATES.DOWNLOADING]: [SESSION_STATES.VERIFYING, SESSION_STATES.FAILED],
  [SESSION_STATES.VERIFYING]: [SESSION_STATES.LAUNCHING, SESSION_STATES.FAILED],
  [SESSION_STATES.LAUNCHING]: [SESSION_STATES.RUNNING, SESSION_STATES.FAILED],
  [SESSION_STATES.RUNNING]: [SESSION_STATES.EXITED, SESSION_STATES.FAILED],
  [SESSION_STATES.EXITED]: [],
  [SESSION_STATES.FAILED]: []
});

export function isTerminalState(state) {
  return TERMINAL_STATES.has(state);
}

export function canTransition(from, to) {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

/** Failure reasons the page renders. Codes, not sentences, so the page owns wording. */
export const FAILURE_REASONS = Object.freeze({
  RUNTIME_ABSENT: 'runtime-absent',
  PROTOCOL_MISMATCH: 'protocol-mismatch',
  NOT_PAIRED: 'not-paired',
  UNKNOWN_GAME: 'unknown-game',
  PLATFORM_UNSUPPORTED: 'platform-unsupported',
  DOLPHIN_MISSING: 'dolphin-missing',
  PCSX2_MISSING: 'pcsx2-missing',
  DOWNLOAD_FAILED: 'download-failed',
  INTEGRITY_FAILED: 'integrity-failed',
  DISK_FULL: 'disk-full',
  LAUNCH_FAILED: 'launch-failed',
  ALREADY_RUNNING: 'already-running'
});

/**
 * A launch request names a game, never a path and never a command.
 *
 * This is the whole security posture in one rule. The runtime can start a
 * native process, so a page that could name the file to run would be naming an
 * executable to run — and any site the player visits could then name one. The
 * page names an id; the runtime resolves it against a catalogue it fetched from
 * the arcade itself over TLS, and refuses anything it cannot find there.
 */
export function isValidLaunchRequest(value) {
  if (!value || typeof value !== 'object') return false;
  if (value.protocolVersion !== PROTOCOL_VERSION) return false;
  if (!isValidGameId(value.gameId)) return false;
  if (!RUNTIME_PLATFORMS.includes(value.platformId)) return false;
  if (value.cabinetId !== undefined && !isValidCabinetId(value.cabinetId)) return false;
  // Anything resembling a path or an argument is refused rather than sanitized:
  // there is no legitimate request that carries one.
  for (const forbidden of ['path', 'file', 'filePath', 'executable', 'command', 'args', 'argv', 'exe']) {
    if (Object.hasOwn(value, forbidden)) return false;
  }
  return true;
}

export function isValidGameId(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{1,63}$/.test(value);
}

export function isValidCabinetId(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{1,63}$/.test(value);
}

/** A session id the runtime minted. Opaque to the page beyond its shape. */
export function isValidSessionId(value) {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
}

/**
 * A catalogue entry, as fetched from the arcade origin. The digest is what
 * makes an untrusted download safe to hand to a native emulator, so an entry
 * without one is not usable and is rejected here rather than at launch.
 */
export function isValidCatalogEntry(value) {
  if (!value || typeof value !== 'object') return false;
  if (!isValidGameId(value.gameId)) return false;
  if (!RUNTIME_PLATFORMS.includes(value.platformId)) return false;
  if (typeof value.downloadUrl !== 'string' || !isHttpsUrl(value.downloadUrl)) return false;
  if (!isValidFileName(value.fileName)) return false;
  if (!Number.isSafeInteger(value.sizeBytes) || value.sizeBytes <= 0) return false;
  if (typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256)) return false;
  return true;
}

/**
 * Plain https, and never a credentialed URL: `https://user:pass@host/` would
 * put a secret into the runtime's logs and process list.
 */
export function isHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

/**
 * A bare file name. The catalogue names what to call the file on disk, and a
 * name that can traverse would let a catalogue entry write outside the library
 * directory.
 */
export function isValidFileName(value) {
  return typeof value === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(value)
    && !value.includes('..');
}

/** Messages the session frame exchanges with the arcade page. */
export const FRAME_MESSAGES = Object.freeze({
  READY: 'arcade:runtime-ready',
  PROGRESS: 'arcade:runtime-progress',
  RUNNING: 'arcade:runtime-running',
  CLOSED: 'arcade:runtime-closed',
  ERROR: 'arcade:runtime-error'
});
