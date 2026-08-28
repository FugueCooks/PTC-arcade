/**
 * The disc range store, off the main thread.
 *
 * OPFS reads and writes were being paid for on the thread the PS2 core runs
 * on: materializing a 4 MB chunk with file.arrayBuffer(), and — worse —
 * committing one with createWritable().close(), which copies the swap file
 * into place. The frame's own BLOCKED readout measured those as long tasks
 * approaching 300 ms, which is a visible hitch in a game that renders in 16.
 *
 * This worker owns the store instead. It uses synchronous access handles —
 * worker-only API, and the fast path through OPFS — and hands chunks back as
 * transferables, so the main thread never copies more than it must. When a
 * handle is locked (the arcade's prewarm and the frame briefly share a store),
 * an op falls back to the async file API rather than failing: still off the
 * main thread, which is the whole point.
 *
 * The LRU and its pinned boot region mirror the in-page store in
 * disc-range-cache.js exactly; the client keeps a membership mirror so has()
 * and size stay synchronous.
 */

const stores = new Map();

function reply(message, transfer = []) {
  self.postMessage(message, transfer);
}

async function openStore({ id, storeId, directory, key, maxChunks, pinnedChunks }) {
  try {
    const root = await navigator.storage.getDirectory();
    const cache = await root.getDirectoryHandle(directory, { create: true });
    const store = await cache.getDirectoryHandle(key, { create: true });
    // Insertion order is the recency order, exactly as in the page store: what
    // was on disk at open starts oldest and earns its place back when read.
    const stored = new Map();
    for await (const name of store.keys()) {
      const match = /^(\d+)\.chunk$/.exec(name);
      if (match) stored.set(Number(match[1]), true);
    }
    stores.set(storeId, { directory: store, stored, maxChunks, pinnedChunks, queue: Promise.resolve() });
    reply({ id, ok: true, keys: [...stored.keys()] });
  } catch (error) {
    reply({ id, ok: false, reason: error?.message ?? 'open failed' });
  }
}

function touch(store, index) {
  if (!store.stored.has(index)) return;
  store.stored.delete(index);
  store.stored.set(index, true);
}

async function evictOne(store) {
  for (const index of store.stored.keys()) {
    if (index < store.pinnedChunks) continue;
    store.stored.delete(index);
    try {
      await store.directory.removeEntry(`${index}.chunk`);
    } catch (error) {
      if (error?.name !== 'NotFoundError') console.warn('Could not evict a cached disc range.', error);
    }
    return index;
  }
  return null;
}

async function readChunk(store, index, expectedBytes) {
  const name = `${index}.chunk`;
  const handle = await store.directory.getFileHandle(name);
  let access = null;
  try {
    access = await handle.createSyncAccessHandle();
  } catch {
    // Another context holds the lock. The async path is slower but correct.
    const file = await handle.getFile();
    if (file.size !== expectedBytes) return { buffer: null, wrongSize: true };
    return { buffer: await file.arrayBuffer() };
  }
  try {
    if (access.getSize() !== expectedBytes) return { buffer: null, wrongSize: true };
    const buffer = new ArrayBuffer(expectedBytes);
    access.read(new Uint8Array(buffer), { at: 0 });
    return { buffer };
  } finally {
    access.close();
  }
}

async function writeChunk(store, index, buffer) {
  const handle = await store.directory.getFileHandle(`${index}.chunk`, { create: true });
  let access = null;
  try {
    access = await handle.createSyncAccessHandle();
  } catch {
    const writable = await handle.createWritable({ keepExistingData: false });
    try {
      await writable.write(buffer);
      await writable.close();
    } catch (error) {
      try { await writable.abort(); } catch { /* Already closed. */ }
      throw error;
    }
    return;
  }
  try {
    access.truncate(0);
    access.write(new Uint8Array(buffer), { at: 0 });
    access.flush();
  } finally {
    access.close();
  }
}

async function getChunk(store, { id, index, expectedBytes }) {
  try {
    const { buffer, wrongSize } = await readChunk(store, index, expectedBytes);
    if (wrongSize) {
      await store.directory.removeEntry(`${index}.chunk`).catch(() => {});
      store.stored.delete(index);
      reply({ id, buffer: null, removed: true });
      return;
    }
    touch(store, index);
    reply({ id, buffer }, [buffer]);
  } catch (error) {
    if (error?.name !== 'NotFoundError') console.warn('Could not read a cached disc range.', error);
    reply({ id, buffer: null });
  }
}

async function putChunk(store, { id, index, buffer }) {
  try {
    const isNew = !store.stored.has(index);
    const evicted = [];
    while (isNew && store.stored.size >= store.maxChunks) {
      const gone = await evictOne(store);
      if (gone === null) {
        reply({ id, ok: false, evicted });
        return;
      }
      evicted.push(gone);
    }
    store.stored.set(index, true);
    touch(store, index);
    try {
      await writeChunk(store, index, buffer);
    } catch (error) {
      if (isNew) store.stored.delete(index);
      throw error;
    }
    reply({ id, ok: true, evicted });
  } catch (error) {
    console.warn('Could not persist a disc range.', error);
    reply({ id, ok: false, evicted: [] });
  }
}

self.onmessage = ({ data }) => {
  if (!data || typeof data !== 'object') return;
  if (data.op === 'capability') {
    reply({
      id: data.id,
      ok: typeof FileSystemFileHandle !== 'undefined'
        && typeof navigator.storage?.getDirectory === 'function'
    });
    return;
  }
  if (data.op === 'open') { void openStore(data); return; }
  const store = stores.get(data.storeId);
  if (!store) { reply({ id: data.id, ok: false, buffer: null }); return; }
  // One op at a time per store: eviction bookkeeping and file writes must not
  // interleave across await points.
  if (data.op === 'get') store.queue = store.queue.then(() => getChunk(store, data));
  else if (data.op === 'put') store.queue = store.queue.then(() => putChunk(store, data));
};
