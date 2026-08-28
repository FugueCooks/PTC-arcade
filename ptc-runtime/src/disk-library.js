import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { FAILURE_REASONS } from '../../emulators/ptc-runtime/protocol.js';
import { DownloadError, downloadAndDigest, resolveLibraryPath } from './library.js';

const STATE_VERSION = 1;
const LOCK_INITIALIZATION_GRACE_MS = 30_000;

function stateKey(entry) {
  return createHash('sha256')
    .update(`${entry.platformId}\0${entry.gameId}\0${entry.fileName}`)
    .digest('hex');
}

function statePaths(root, entry) {
  const stateRoot = path.join(root, '.ptc-runtime');
  const key = stateKey(entry);
  return {
    root: stateRoot,
    partial: path.join(stateRoot, `${key}.partial`),
    partialMetadata: path.join(stateRoot, `${key}.partial.json`),
    verifiedMetadata: path.join(stateRoot, `${key}.verified.json`),
    lock: path.join(stateRoot, `${key}.download.lock`)
  };
}

async function readJson(filePath) {
  try { return JSON.parse(await readFile(filePath, 'utf8')); } catch { return null; }
}

async function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  // Windows does not replace an existing destination atomically. A missing or
  // truncated metadata record is safe (the image is re-verified), whereas a
  // stale record is not, so remove the old record immediately before rename.
  await rm(filePath, { force: true });
  await rename(temporary, filePath);
}

async function fileFingerprint(filePath) {
  const stats = await stat(filePath, { bigint: true });
  return {
    isFile: stats.isFile(),
    sizeBytes: Number(stats.size),
    mtimeNs: stats.mtimeNs.toString(),
    ctimeNs: stats.ctimeNs.toString(),
    device: stats.dev.toString(),
    inode: stats.ino.toString()
  };
}

function sameFingerprint(left, right) {
  return Boolean(left && right)
    && left.isFile === true && right.isFile === true
    && left.sizeBytes === right.sizeBytes
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.device === right.device
    && left.inode === right.inode;
}

function metadataMatchesEntry(metadata, entry) {
  return metadata?.version === STATE_VERSION
    && metadata.gameId === entry.gameId
    && metadata.platformId === entry.platformId
    && metadata.fileName === entry.fileName
    && metadata.sizeBytes === entry.sizeBytes
    && metadata.sha256 === entry.sha256
    && metadata.downloadUrl === entry.downloadUrl;
}

function parseContentRange(value, expectedStart, expectedTotal) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value ?? '');
  if (!match) return false;
  const [, start, end, total] = match.map(Number);
  return start === expectedStart && end >= start && end < total && total === expectedTotal;
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

async function acquireDownloadLock(lockPath) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      return handle;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const record = await readJson(lockPath);
      if (processIsAlive(record?.pid)) return null;
      // Do not steal a lock in the tiny interval between another process
      // creating it and writing its owner record.
      const lockStats = await stat(lockPath).catch(() => null);
      if (!record && lockStats && Date.now() - lockStats.mtimeMs < LOCK_INITIALIZATION_GRACE_MS) return null;
      await rm(lockPath, { force: true });
    }
  }
  return null;
}

async function hashPartial(filePath, signal) {
  const hash = createHash('sha256');
  let receivedBytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    if (signal?.aborted) throw new DownloadError('aborted', 'The download was cancelled.');
    hash.update(chunk);
    receivedBytes += chunk.length;
  }
  return { hash, receivedBytes };
}

/**
 * The library on disk.
 *
 * Downloads land on a temporary name and are renamed into place only after
 * their digest matches, so an interrupted transfer can never be mistaken for a
 * complete game. A partial file under the real name would pass a size check on
 * the next launch and be handed straight to Dolphin.
 */
export class DiskLibrary {
  #root;
  #fetchImpl;
  #verified = new Map();

  constructor({ root, fetchImpl = (...args) => globalThis.fetch(...args) }) {
    this.#root = root;
    this.#fetchImpl = fetchImpl;
  }

  #pathFor(entry) {
    return resolveLibraryPath(this.#root, entry, path.join, path.resolve);
  }

  async resolve(entry) {
    const resolved = this.#pathFor(entry);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    return { ok: true, path: resolved.path };
  }

  /** What is already on disk, and whether this run has proven it. */
  async inspect(entry) {
    const resolved = this.#pathFor(entry);
    if (!resolved.ok) return { present: false };
    try {
      const fingerprint = await fileFingerprint(resolved.path);
      if (!fingerprint.isFile) return { present: false };
      const paths = statePaths(this.#root, entry);
      let verifiedSha256 = null;
      const inMemory = this.#verified.get(resolved.path);
      if (inMemory?.sha256 === entry.sha256 && sameFingerprint(inMemory.fingerprint, fingerprint)) {
        verifiedSha256 = entry.sha256;
      } else {
        const persisted = await readJson(paths.verifiedMetadata);
        if (metadataMatchesEntry(persisted, entry) && sameFingerprint(persisted.fingerprint, fingerprint)) {
          verifiedSha256 = entry.sha256;
          this.#verified.set(resolved.path, { sha256: entry.sha256, fingerprint });
        } else {
          this.#verified.delete(resolved.path);
          await rm(paths.verifiedMetadata, { force: true }).catch(() => {});
        }
      }
      return {
        present: true,
        sizeBytes: fingerprint.sizeBytes,
        verifiedSha256
      };
    } catch {
      return { present: false };
    }
  }

  async download(entry, { signal, onProgress } = {}) {
    const resolved = this.#pathFor(entry);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    await mkdir(this.#root, { recursive: true });
    const paths = statePaths(this.#root, entry);
    await mkdir(paths.root, { recursive: true });
    const lock = await acquireDownloadLock(paths.lock);
    if (!lock) return { ok: false, reason: FAILURE_REASONS.DOWNLOAD_FAILED };

    let handle;
    try {
      let partialMetadata = await readJson(paths.partialMetadata);
      let partialFingerprint = await fileFingerprint(paths.partial).catch(() => null);
      if (!partialFingerprint?.isFile
        || partialFingerprint.sizeBytes <= 0
        || partialFingerprint.sizeBytes > entry.sizeBytes
        || !metadataMatchesEntry(partialMetadata, entry)) {
        await this.#clearPartial(paths);
        partialMetadata = null;
        partialFingerprint = null;
      }

      let initialHash = createHash('sha256');
      let initialBytes = 0;
      if (partialFingerprint) {
        const prefix = await hashPartial(paths.partial, signal);
        initialHash = prefix.hash;
        initialBytes = prefix.receivedBytes;
        onProgress?.({
          percent: Math.floor((initialBytes / entry.sizeBytes) * 100),
          receivedBytes: initialBytes,
          totalBytes: entry.sizeBytes,
          resumed: true
        });
      }

      // A crash can happen after the final byte reaches disk but before rename.
      // Prove and promote that complete partial without touching the network.
      if (initialBytes === entry.sizeBytes) {
        const sha256 = initialHash.digest('hex');
        if (sha256 !== entry.sha256) {
          await this.#clearPartial(paths);
          return { ok: false, reason: FAILURE_REASONS.INTEGRITY_FAILED, sha256 };
        }
        return await this.#promote(entry, resolved.path, paths, sha256);
      }

      const requestHeaders = {};
      if (initialBytes > 0) {
        requestHeaders.Range = `bytes=${initialBytes}-`;
        const validator = partialMetadata?.etag ?? partialMetadata?.lastModified;
        if (validator) requestHeaders['If-Range'] = validator;
      }
      const response = await this.#fetchImpl(entry.downloadUrl, {
        signal, redirect: 'follow', headers: requestHeaders
      });
      if (!response.ok || !response.body) return { ok: false, reason: FAILURE_REASONS.DOWNLOAD_FAILED };

      let append = false;
      if (initialBytes > 0 && response.status === 206) {
        if (!parseContentRange(response.headers.get('content-range'), initialBytes, entry.sizeBytes)) {
          await response.body.cancel().catch(() => {});
          return { ok: false, reason: FAILURE_REASONS.DOWNLOAD_FAILED };
        }
        const resumedEtag = response.headers.get('etag');
        if (partialMetadata?.etag && resumedEtag && partialMetadata.etag !== resumedEtag) {
          await response.body.cancel().catch(() => {});
          await this.#clearPartial(paths);
          return { ok: false, reason: FAILURE_REASONS.DOWNLOAD_FAILED };
        }
        append = true;
      } else if (initialBytes > 0 && response.status === 200) {
        // The origin ignored Range or rejected If-Range. Reuse this complete
        // response, but truncate the old prefix so bytes are never appended to
        // a different object.
        initialHash = createHash('sha256');
        initialBytes = 0;
      } else if (initialBytes === 0 && response.status === 206) {
        if (!parseContentRange(response.headers.get('content-range'), 0, entry.sizeBytes)) {
          await response.body.cancel().catch(() => {});
          return { ok: false, reason: FAILURE_REASONS.DOWNLOAD_FAILED };
        }
      } else if (response.status !== 200) {
        await response.body.cancel().catch(() => {});
        return { ok: false, reason: FAILURE_REASONS.DOWNLOAD_FAILED };
      }

      await writeJsonAtomic(paths.partialMetadata, {
        version: STATE_VERSION,
        gameId: entry.gameId,
        platformId: entry.platformId,
        fileName: entry.fileName,
        sizeBytes: entry.sizeBytes,
        sha256: entry.sha256,
        downloadUrl: entry.downloadUrl,
        etag: response.headers.get('etag'),
        lastModified: response.headers.get('last-modified'),
        updatedAt: new Date().toISOString()
      });

      handle = createWriteStream(paths.partial, append
        ? { flags: 'r+', start: initialBytes }
        : { flags: 'w' });
      const written = { write: (chunk) => new Promise((resolve, reject) => {
        handle.write(chunk, (error) => (error ? reject(error) : resolve()));
      }) };

      const { sha256 } = await downloadAndDigest({
        source: Readable.fromWeb(response.body),
        sink: written,
        expectedBytes: entry.sizeBytes,
        onProgress,
        signal,
        initialHash,
        initialBytes
      });
      await new Promise((resolve, reject) => handle.end((error) => (error ? reject(error) : resolve())));
      handle = null;

      // Renamed only once the bytes are known good. Before this point nothing
      // on disk is named like a game the runtime would launch.
      if (sha256 !== entry.sha256) {
        await this.#clearPartial(paths);
        return { ok: false, reason: FAILURE_REASONS.INTEGRITY_FAILED, sha256 };
      }
      return await this.#promote(entry, resolved.path, paths, sha256);
    } catch (error) {
      // A short, cancelled, or disconnected transfer remains resumable. Only a
      // prefix that has grown beyond the catalogue size is unsafe to retain.
      const partialStats = await stat(paths.partial).catch(() => null);
      if (partialStats?.size > entry.sizeBytes) await this.#clearPartial(paths);
      if (error instanceof DownloadError) return { ok: false, reason: FAILURE_REASONS.DOWNLOAD_FAILED };
      if (error?.code === 'ENOSPC') return { ok: false, reason: FAILURE_REASONS.DISK_FULL };
      return { ok: false, reason: FAILURE_REASONS.DOWNLOAD_FAILED };
    } finally {
      if (handle) handle.destroy();
      await lock.close().catch(() => {});
      await rm(paths.lock, { force: true }).catch(() => {});
    }
  }

  async #clearPartial(paths) {
    await Promise.all([
      rm(paths.partial, { force: true }).catch(() => {}),
      rm(paths.partialMetadata, { force: true }).catch(() => {})
    ]);
  }

  async #recordVerified(entry, resolvedPath, paths, sha256) {
    const fingerprint = await fileFingerprint(resolvedPath);
    await writeJsonAtomic(paths.verifiedMetadata, {
      version: STATE_VERSION,
      gameId: entry.gameId,
      platformId: entry.platformId,
      fileName: entry.fileName,
      sizeBytes: entry.sizeBytes,
      sha256,
      downloadUrl: entry.downloadUrl,
      fingerprint,
      verifiedAt: new Date().toISOString()
    });
    this.#verified.set(resolvedPath, { sha256, fingerprint });
  }

  async #promote(entry, resolvedPath, paths, sha256) {
    // The old final file may be a truncated or outdated image. It remains in
    // place until the replacement partial has passed SHA-256, then is replaced.
    await rm(resolvedPath, { force: true });
    await rename(paths.partial, resolvedPath);
    await rm(paths.partialMetadata, { force: true });
    await this.#recordVerified(entry, resolvedPath, paths, sha256);
    return { ok: true, sha256 };
  }

  /** Re-reads a cached file this run has not yet proven. */
  async verify(entry, { signal } = {}) {
    const resolved = this.#pathFor(entry);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    try {
      const hash = createHash('sha256');
      await pipeline(createReadStream(resolved.path), async function* (source) {
        for await (const chunk of source) {
          if (signal?.aborted) throw new Error('aborted');
          hash.update(chunk);
          yield chunk;
        }
      }, async (source) => { for await (const _chunk of source) { /* drained */ } });
      const sha256 = hash.digest('hex');
      if (sha256 === entry.sha256) {
        const paths = statePaths(this.#root, entry);
        await mkdir(paths.root, { recursive: true });
        await this.#recordVerified(entry, resolved.path, paths, sha256);
      }
      return { ok: true, sha256 };
    } catch {
      return { ok: false, reason: FAILURE_REASONS.INTEGRITY_FAILED };
    }
  }

  /** Removes a file that failed verification. Never repaired, never retried in place. */
  async discard(entry) {
    const resolved = this.#pathFor(entry);
    if (!resolved.ok) return;
    this.#verified.delete(resolved.path);
    const paths = statePaths(this.#root, entry);
    await Promise.all([
      rm(resolved.path, { force: true }).catch(() => {}),
      rm(paths.partial, { force: true }).catch(() => {}),
      rm(paths.partialMetadata, { force: true }).catch(() => {}),
      rm(paths.verifiedMetadata, { force: true }).catch(() => {})
    ]);
  }
}
