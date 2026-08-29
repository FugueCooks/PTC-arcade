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
export async function fetchDiscRange(url, start, end, { attempts = 5, timeoutMs = 20000, signal, priority } = {}) {
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
        signal: controller.signal,
        // Chrome schedules a low-priority range behind the ones the core is
        // waiting on. Ignored where it is not supported, which is fine: the
        // caller still aborts a speculative read when a demand read arrives.
        ...(priority ? { priority } : {})
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
 * The store worker, one per page, shared by every disc it opens.
 *
 * OPFS costs used to land on the thread the PS2 core renders on: reading a
 * chunk materializes 4 MB, and committing one through createWritable().close()
 * copies a swap file into place. The frame's BLOCKED readout measured those as
 * long tasks approaching 300 ms. The worker pays them instead, uses the
 * worker-only synchronous access handles, and transfers chunks back rather
 * than copying them.
 */
const WORKER_CALL_TIMEOUT_MS = 10000;
let workerChannelPromise = null;

function cacheWorkerChannel() {
  if (workerChannelPromise !== null) return workerChannelPromise;
  workerChannelPromise = (async () => {
    // Node (the tests) and old browsers take the in-page store below.
    if (typeof Worker !== 'function' || typeof document === 'undefined') return null;
    try {
      const worker = new Worker(new URL('./disc-cache-worker.js?v=poke-7', import.meta.url), { type: 'module' });
      const pending = new Map();
      let nextId = 1;
      worker.onmessage = ({ data }) => {
        const resolve = pending.get(data?.id);
        if (!resolve) return;
        pending.delete(data.id);
        resolve(data);
      };
      worker.onerror = () => {
        for (const resolve of pending.values()) resolve(null);
        pending.clear();
      };
      const call = (message, transfer = []) => new Promise(resolve => {
        const id = nextId++;
        pending.set(id, resolve);
        // A wedged worker must read as a miss, never hang a read the core is
        // blocked on.
        const bail = setTimeout(() => { pending.delete(id); resolve(null); }, WORKER_CALL_TIMEOUT_MS);
        const settle = pending.get(id);
        pending.set(id, value => { clearTimeout(bail); settle(value); });
        try { worker.postMessage({ ...message, id }, transfer); }
        catch { clearTimeout(bail); pending.delete(id); resolve(null); }
      });
      const capable = await call({ op: 'capability' });
      if (!capable?.ok) { worker.terminate(); return null; }
      return { call };
    } catch {
      return null;
    }
  })();
  return workerChannelPromise;
}

/** The same store surface as below, served from the worker. */
async function openWorkerBackedCache(source, maxChunks, pinnedChunks) {
  const channel = await cacheWorkerChannel();
  if (!channel) return null;
  const key = discCacheKey(source);
  const opened = await channel.call({
    op: 'open', storeId: key, directory: RANGE_CACHE_DIRECTORY, key, maxChunks, pinnedChunks
  });
  if (!opened?.ok || !Array.isArray(opened.keys)) return null;
  // Membership mirror, so has() and size never wait on a message round trip.
  const stored = new Set(opened.keys);
  return {
    has(index) {
      return stored.has(index);
    },
    get size() {
      return stored.size;
    },
    async get(index, expectedBytes) {
      const result = await channel.call({ op: 'get', storeId: key, index, expectedBytes });
      if (result?.removed) stored.delete(index);
      return result?.buffer ?? null;
    },
    /**
     * `transfer` hands the buffer to the worker without a copy — for callers
     * that are done with it. The default clones, because the frame stores the
     * same buffer it persists and a detached chunk would reach the core.
     */
    async put(index, buffer, { transfer = false } = {}) {
      const result = await channel.call({ op: 'put', storeId: key, index, buffer }, transfer ? [buffer] : []);
      if (!result?.ok) return false;
      stored.add(index);
      for (const evicted of result.evicted ?? []) stored.delete(evicted);
      return true;
    }
  };
}

/**
 * Opens the on-disk chunk store for one disc. Returns null where OPFS is
 * unavailable — every caller treats persistence as an optimisation, never a
 * requirement, so a private window still plays, it just re-fetches.
 *
 * Served from a worker where the platform allows, so neither the arcade's
 * render loop nor the PS2 core pays for disk IO; the in-page store below is
 * the fallback, and the semantics of the two are identical.
 */
export async function openDiscRangeCache(source, maxChunks, { pinnedChunks = 0 } = {}) {
  if (typeof navigator.storage?.getDirectory !== 'function') return null;
  try {
    await navigator.storage.persist?.();
    const offThread = await openWorkerBackedCache(source, maxChunks, pinnedChunks).catch(() => null);
    if (offThread) return offThread;
    const root = await navigator.storage.getDirectory();
    const cache = await root.getDirectoryHandle(RANGE_CACHE_DIRECTORY, { create: true });
    const directory = await cache.getDirectoryHandle(discCacheKey(source), { create: true });
    // Insertion order is the recency order: a Map re-keyed on every hit is the
    // whole LRU. What was on disk at open has no recorded order, so it starts
    // as the oldest and earns its place back the first time it is read.
    const stored = new Map();
    for await (const name of directory.keys()) {
      const match = /^(\d+)\.chunk$/.exec(name);
      if (match) stored.set(Number(match[1]), true);
    }
    const touch = index => {
      if (!stored.has(index)) return;
      stored.delete(index);
      stored.set(index, true);
    };
    /**
     * Frees one slot, never touching the pinned opening chunks. Those are what
     * the next launch reads first, so evicting them to make room for something
     * read once, deep in a level, would trade a fast boot for nothing.
     */
    const evictOne = async () => {
      for (const index of stored.keys()) {
        if (index < pinnedChunks) continue;
        stored.delete(index);
        try {
          await directory.removeEntry(`${index}.chunk`);
        } catch (error) {
          if (error?.name !== 'NotFoundError') console.warn('Could not evict a cached disc range.', error);
        }
        return true;
      }
      return false;
    };
    return {
      /** True where a chunk is on disk, without paying to read it back. */
      has(index) {
        return stored.has(index);
      },
      get size() {
        return stored.size;
      },
      async get(index, expectedBytes) {
        const name = `${index}.chunk`;
        try {
          const handle = await directory.getFileHandle(name);
          const file = await handle.getFile();
          if (file.size === expectedBytes) {
            touch(index);
            return file.arrayBuffer();
          }
          await directory.removeEntry(name);
          stored.delete(index);
        } catch (error) {
          if (error?.name !== 'NotFoundError') console.warn('Could not read a cached disc range.', error);
        }
        return null;
      },
      async put(index, buffer) {
        const isNew = !stored.has(index);
        // A full cache used to stop accepting anything, so whatever a player
        // happened to read first was all they ever kept: every later session
        // re-fetched the rest of a multi-gigabyte disc from scratch.
        while (isNew && stored.size >= maxChunks) {
          if (!await evictOne()) return false;
        }
        stored.set(index, true);
        touch(index);
        const handle = await directory.getFileHandle(`${index}.chunk`, { create: true });
        const writable = await handle.createWritable({ keepExistingData: false });
        try {
          await writable.write(buffer);
          await writable.close();
          return true;
        } catch (error) {
          if (isNew) stored.delete(index);
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
export async function prewarmDiscRanges(source, { chunks = 3, chunkList = null, maxChunks = 128, signal, priority = 'low' } = {}) {
  if (!source?.url?.startsWith('https://') || !Number.isSafeInteger(source.size) || source.size <= 0) return { warmed: 0, skipped: true };
  const wanted = bootChunkOrder(source, { chunks, chunkList });
  if (!wanted.length) return { warmed: 0, skipped: true };
  const cache = await openDiscRangeCache(source, maxChunks, { pinnedChunks: chunks });
  if (!cache) return { warmed: 0, skipped: true };
  let warmed = 0;
  for (const index of wanted) {
    if (signal?.aborted) break;
    if (cache.has(index)) continue;
    const start = index * RANGE_CHUNK_BYTES;
    const end = Math.min(source.size, start + RANGE_CHUNK_BYTES);
    try {
      // Speculative by definition: nobody is waiting on these, so they queue
      // behind any read the core is actually blocked on.
      const buffer = await fetchDiscRange(source.url, start, end, { attempts: 2, signal, priority });
      await cache.put(index, buffer, { transfer: true });
      warmed += 1;
    } catch (error) {
      if (signal?.aborted) break;
      console.warn('Could not warm a disc range ahead of play.', error);
      break;
    }
  }
  return { warmed, skipped: false };
}

/**
 * Which chunks to warm, and in what order.
 *
 * Warming the opening chunks is a guess that holds for a disc whose executable
 * sits near the front, and misses for one that does not. A title that has been
 * observed booting can say exactly which chunks it read instead — see
 * `bootChunkRecorder` — and that list is warmed in the order it was read, so
 * the first thing the core asks for is the first thing on disk.
 */
export function bootChunkOrder(source, { chunks = 3, chunkList = null } = {}) {
  const available = Math.ceil(source.size / RANGE_CHUNK_BYTES);
  if (Array.isArray(chunkList) && chunkList.length) {
    const seen = new Set();
    for (const value of chunkList) {
      if (Number.isSafeInteger(value) && value >= 0 && value < available) seen.add(value);
    }
    // The budget bounds a measured list too. Mega Man X7 reads 46 chunks before
    // its title screen — 184 MB — and fetching all of that because somebody
    // walked past the cabinet is worse than the wait it was meant to remove.
    // Taking them in the order they were read means the budget buys the ones
    // the core asks for first.
    if (seen.size) return [...seen].slice(0, Math.max(0, chunks));
  }
  const count = Math.min(chunks, available);
  return Array.from({ length: Math.max(0, count) }, (_unused, index) => index);
}

/**
 * Records the chunks a core reads while booting, so a title can be measured
 * once and warmed exactly thereafter. Order matters and duplicates do not: what
 * is wanted is the sequence of first touches.
 */
export function bootChunkRecorder({ limit = 64 } = {}) {
  const order = [];
  const seen = new Set();
  return {
    record(index) {
      if (!Number.isSafeInteger(index) || seen.has(index) || order.length >= limit) return;
      seen.add(index);
      order.push(index);
    },
    get chunks() {
      return [...order];
    }
  };
}
