/**
 * The byte-range cache behind hosted disc images.
 *
 * A PS2 image is presented to the core as a virtual file whose reads are served
 * from HTTP ranges, so a multi-gigabyte game starts in the time it takes to read
 * its boot sectors rather than the time it takes to download it. This module
 * holds the parts of that scheme that more than one surface needs: the frame
 * that serves the core's reads, and the arcade that warms the boot region while
 * the player is still walking towards the cabinet.
 *
 * Both live on the same origin, so they share one OPFS store: a chunk the
 * arcade fetches on approach is already on disk when the frame asks for it.
 */

export const RANGE_CACHE_DIRECTORY = 'retro-arcade-ps2-ranges-v1';
export const RANGE_CHUNK_BYTES = 4 * 1024 * 1024;

/** Identifies a disc without trusting its name: URL, name, and size all count. */
export function discCacheKey(source) {
  let hash = 2166136261;
  for (const character of `${source.url}|${source.name}|${source.size}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  const safeName = source.name.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').slice(0, 48) || 'disc';
  return `${safeName}-${source.size}-${(hash >>> 0).toString(16)}`;
}

/**
 * One range request, retried. A 206 that does not carry the range we asked for
 * is a failure: a proxy answering with the whole file would otherwise be copied
 * into the cache under a chunk's name and hand the core the wrong sectors.
 */
export async function fetchDiscRange(url, start, end, { attempts = 5, timeoutMs = 20000, signal } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (signal?.aborted) throw signal.reason ?? new Error('Disc range request aborted.');
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        headers: { Range: `bytes=${start}-${end - 1}` },
        credentials: 'omit',
        signal: controller.signal
      });
      if (response.status !== 206) throw new Error(`Remote disc range request failed (${response.status}).`);
      const expectedRange = `bytes ${start}-${end - 1}/`;
      const contentRange = response.headers.get('content-range') ?? '';
      if (!contentRange.toLowerCase().startsWith(expectedRange)) throw new Error('Remote disc returned the wrong byte range.');
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength !== end - start) throw new Error('Remote disc returned an incomplete byte range.');
      return buffer;
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw lastError;
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, attempt * 400));
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }
  throw lastError;
}

/**
 * Opens the on-disk chunk store for one disc. Returns null where OPFS is
 * unavailable — every caller treats persistence as an optimisation, never a
 * requirement, so a private window still plays, it just re-fetches.
 */
export async function openDiscRangeCache(source, maxChunks) {
  if (typeof navigator.storage?.getDirectory !== 'function') return null;
  try {
    await navigator.storage.persist?.();
    const root = await navigator.storage.getDirectory();
    const cache = await root.getDirectoryHandle(RANGE_CACHE_DIRECTORY, { create: true });
    const directory = await cache.getDirectoryHandle(discCacheKey(source), { create: true });
    const storedIndexes = new Set();
    for await (const name of directory.keys()) {
      const match = /^(\d+)\.chunk$/.exec(name);
      if (match) storedIndexes.add(Number(match[1]));
    }
    return {
      /** True where a chunk is on disk, without paying to read it back. */
      has(index) {
        return storedIndexes.has(index);
      },
      async get(index, expectedBytes) {
        const name = `${index}.chunk`;
        try {
          const handle = await directory.getFileHandle(name);
          const file = await handle.getFile();
          if (file.size === expectedBytes) return file.arrayBuffer();
          await directory.removeEntry(name);
          storedIndexes.delete(index);
        } catch (error) {
          if (error?.name !== 'NotFoundError') console.warn('Could not read a cached disc range.', error);
        }
        return null;
      },
      async put(index, buffer) {
        if (!storedIndexes.has(index) && storedIndexes.size >= maxChunks) return false;
        const isNew = !storedIndexes.has(index);
        storedIndexes.add(index);
        const handle = await directory.getFileHandle(`${index}.chunk`, { create: true });
        const writable = await handle.createWritable({ keepExistingData: false });
        try {
          await writable.write(buffer);
          await writable.close();
          return true;
        } catch (error) {
          if (isNew) storedIndexes.delete(index);
          try { await writable.abort(); } catch { /* Already closed. */ }
          throw error;
        }
      }
    };
  } catch (error) {
    console.warn('Persistent disc range caching is unavailable.', error);
    return null;
  }
}

/**
 * Pulls a disc's opening chunks onto disk before anyone asks for them.
 *
 * The core's first reads are the volume descriptor, the root directory, and the
 * boot configuration — all within the first few megabytes. Fetching them while
 * the player walks the last stretch to the cabinet is the difference between a
 * game that starts when the modal opens and one that starts a few seconds later
 * with a progress bar in between.
 *
 * Deliberately quiet: it resolves rather than throwing, because nothing the
 * player asked for has failed if a speculative fetch does.
 */
export async function prewarmDiscRanges(source, { chunks = 3, maxChunks = 128, signal } = {}) {
  if (!source?.url?.startsWith('https://') || !Number.isSafeInteger(source.size) || source.size <= 0) return { warmed: 0, skipped: true };
  const cache = await openDiscRangeCache(source, maxChunks);
  if (!cache) return { warmed: 0, skipped: true };
  const lastChunk = Math.min(chunks, Math.ceil(source.size / RANGE_CHUNK_BYTES));
  let warmed = 0;
  for (let index = 0; index < lastChunk; index += 1) {
    if (signal?.aborted) break;
    if (cache.has(index)) continue;
    const start = index * RANGE_CHUNK_BYTES;
    const end = Math.min(source.size, start + RANGE_CHUNK_BYTES);
    try {
      const buffer = await fetchDiscRange(source.url, start, end, { attempts: 2, signal });
      await cache.put(index, buffer);
      warmed += 1;
    } catch (error) {
      if (signal?.aborted) break;
      console.warn('Could not warm a disc range ahead of play.', error);
      break;
    }
  }
  return { warmed, skipped: false };
}
