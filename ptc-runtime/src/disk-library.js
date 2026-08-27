import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { FAILURE_REASONS } from '../../emulators/ptc-runtime/protocol.js';
import { DownloadError, downloadAndDigest, resolveLibraryPath } from './library.js';

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
      const stats = await stat(resolved.path);
      return {
        present: stats.isFile(),
        sizeBytes: stats.size,
        verifiedSha256: this.#verified.get(resolved.path) ?? null
      };
    } catch {
      return { present: false };
    }
  }

  async download(entry, { signal, onProgress } = {}) {
    const resolved = this.#pathFor(entry);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    await mkdir(this.#root, { recursive: true });

    // A temporary name unique to this attempt: two runtimes, or a retry after a
    // crash, must not write the same partial file.
    const temporary = `${resolved.path}.${process.pid}.partial`;
    let handle;
    try {
      const response = await this.#fetchImpl(entry.downloadUrl, { signal, redirect: 'follow' });
      if (!response.ok || !response.body) return { ok: false, reason: FAILURE_REASONS.DOWNLOAD_FAILED };

      handle = createWriteStream(temporary);
      const written = { write: (chunk) => new Promise((resolve, reject) => {
        handle.write(chunk, (error) => (error ? reject(error) : resolve()));
      }) };

      const { sha256 } = await downloadAndDigest({
        source: Readable.fromWeb(response.body),
        sink: written,
        expectedBytes: entry.sizeBytes,
        onProgress,
        signal
      });
      await new Promise((resolve, reject) => handle.end((error) => (error ? reject(error) : resolve())));
      handle = null;

      // Renamed only once the bytes are known good. Before this point nothing
      // on disk is named like a game the runtime would launch.
      if (sha256 !== entry.sha256) {
        await rm(temporary, { force: true });
        return { ok: false, reason: FAILURE_REASONS.INTEGRITY_FAILED, sha256 };
      }
      await rename(temporary, resolved.path);
      this.#verified.set(resolved.path, sha256);
      return { ok: true, sha256 };
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      if (error instanceof DownloadError) return { ok: false, reason: FAILURE_REASONS.DOWNLOAD_FAILED };
      if (error?.code === 'ENOSPC') return { ok: false, reason: FAILURE_REASONS.DISK_FULL };
      return { ok: false, reason: FAILURE_REASONS.DOWNLOAD_FAILED };
    } finally {
      if (handle) handle.destroy();
    }
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
      if (sha256 === entry.sha256) this.#verified.set(resolved.path, sha256);
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
    await rm(resolved.path, { force: true }).catch(() => {});
  }
}
