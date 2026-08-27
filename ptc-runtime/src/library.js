import { createHash } from 'node:crypto';
import { isValidCatalogEntry, isValidFileName, isValidGameId, isHttpsUrl } from '../../emulators/ptc-runtime/protocol.js';

/**
 * Resolving a launch request into a file on disk, and proving the file is the
 * one the catalogue named.
 *
 * The page never names a path. It names a game id, and everything below turns
 * that id into bytes the runtime is willing to hand to Dolphin. Two rules carry
 * the weight:
 *
 *   - the catalogue comes from the arcade origin over TLS, and an entry that
 *     does not validate is dropped rather than repaired;
 *   - the downloaded file must match the catalogue's SHA-256 before it is
 *     usable, so a corrupted transfer or a substituted response cannot reach
 *     the emulator.
 *
 * The functions here are pure or take their I/O by injection, so the rules can
 * be tested without a network or a disk.
 */

/**
 * Keeps only entries that fully validate.
 *
 * A partly-valid catalogue is worse than a short one: the missing field is
 * usually the digest, and an entry without a digest is an unverifiable download.
 * Dropped entries are returned so the runtime can log what it refused instead
 * of silently offering fewer games than the arcade thinks it has.
 */
export function parseCatalog(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.games)) {
    return { ok: false, reason: 'malformed-catalog', entries: [], rejected: [] };
  }
  const entries = new Map();
  const rejected = [];
  for (const candidate of payload.games) {
    if (!isValidCatalogEntry(candidate)) {
      rejected.push({ gameId: typeof candidate?.gameId === 'string' ? candidate.gameId : null, reason: 'invalid-entry' });
      continue;
    }
    if (entries.has(candidate.gameId)) {
      rejected.push({ gameId: candidate.gameId, reason: 'duplicate' });
      continue;
    }
    entries.set(candidate.gameId, Object.freeze({ ...candidate }));
  }
  return { ok: true, entries, rejected };
}

/**
 * Where a catalogue entry lives on disk.
 *
 * Composed from the library root and the entry's own file name, and refused if
 * the result escapes the root. The file name is already validated on the way in;
 * this is the second check, because a path that escapes here would be a native
 * process pointed at an arbitrary file.
 */
export function resolveLibraryPath(libraryRoot, entry, join, resolve) {
  if (!isValidFileName(entry?.fileName)) return { ok: false, reason: 'invalid-file-name' };
  const candidate = resolve(join(libraryRoot, entry.fileName));
  const root = resolve(libraryRoot);
  const separator = root.endsWith('/') || root.endsWith('\\') ? '' : '/';
  const normalizedCandidate = candidate.replaceAll('\\', '/');
  const normalizedRoot = `${root.replaceAll('\\', '/')}${separator}`;
  if (!normalizedCandidate.startsWith(normalizedRoot)) return { ok: false, reason: 'escapes-library' };
  return { ok: true, path: candidate };
}

/**
 * What a launch needs to do next, given what is already cached.
 *
 * Split out so the decision is testable without touching a disk: the same
 * request either reuses a verified file, re-downloads a corrupted one, or
 * fetches a missing one.
 */
export function planLaunch({ entry, cached }) {
  if (!entry) return { action: 'refuse', reason: 'unknown-game' };
  if (!cached?.present) return { action: 'download', reason: 'not-cached' };
  if (cached.sizeBytes !== entry.sizeBytes) return { action: 'download', reason: 'size-mismatch' };
  if (cached.verifiedSha256 === entry.sha256) return { action: 'launch', reason: 'cached' };
  return { action: 'verify', reason: 'unverified-cache' };
}

/**
 * Streams bytes through a digest, reporting progress.
 *
 * The digest is computed while downloading rather than in a second pass: a
 * GameCube image runs to well over a gigabyte, and reading it twice doubles the
 * slowest part of a first launch.
 */
export async function downloadAndDigest({ source, sink, expectedBytes, onProgress, signal }) {
  const hash = createHash('sha256');
  let received = 0;
  let lastReported = 0;

  for await (const chunk of source) {
    if (signal?.aborted) throw new DownloadError('aborted', 'The download was cancelled.');
    hash.update(chunk);
    received += chunk.length;
    if (received > expectedBytes) {
      throw new DownloadError('size-mismatch', 'The download exceeded the size the catalogue declared.');
    }
    await sink.write(chunk);
    // Progress at whole percents: a per-chunk event on a gigabyte image is tens
    // of thousands of messages the page does nothing useful with.
    const percent = Math.floor((received / expectedBytes) * 100);
    if (percent > lastReported) {
      lastReported = percent;
      onProgress?.({ percent, receivedBytes: received, totalBytes: expectedBytes });
    }
  }

  if (received !== expectedBytes) {
    throw new DownloadError('size-mismatch', 'The download ended before the size the catalogue declared.');
  }
  return { sha256: hash.digest('hex'), receivedBytes: received };
}

export class DownloadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DownloadError';
    this.code = code;
  }
}

/**
 * The digest check, as its own step.
 *
 * A mismatch is never repaired and never retried in place: the file is removed.
 * Whatever produced the wrong bytes — a truncated transfer, a captive portal, a
 * substituted response — the one thing that must not happen is a native
 * emulator opening them.
 */
export function verifyDigest(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return { ok: false, reason: 'missing-digest' };
  if (actual.length !== expected.length) return { ok: false, reason: 'digest-mismatch' };
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) {
    difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0 ? { ok: true } : { ok: false, reason: 'digest-mismatch' };
}

/** The catalogue URL for an arcade origin. Origin only; never a page-supplied URL. */
export function catalogUrlFor(origin) {
  if (!isHttpsUrl(origin) && !origin.startsWith('http://localhost') && !origin.startsWith('http://127.0.0.1')) {
    return { ok: false, reason: 'insecure-origin' };
  }
  return { ok: true, url: new URL('/api/v1/runtime/catalog', origin).toString() };
}

export { isValidGameId };
