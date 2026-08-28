import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const rangeCache = await import(pathToFileURL(path.resolve(process.cwd(), 'emulators/disc-range-cache.js')).href);

const disc = { url: 'https://assets.example/ps2/kingdom-hearts.iso', name: 'kingdom-hearts.iso', size: 4_600_000_000 };

function rangeResponse(start: number, end: number, total: number, body?: ArrayBuffer) {
  return {
    status: 206,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-range' ? `bytes ${start}-${end - 1}/${total}` : null) },
    arrayBuffer: async () => body ?? new ArrayBuffer(end - start)
  };
}

async function withFetch<T>(stub: (...args: never[]) => unknown, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  (globalThis as Record<string, unknown>).fetch = stub;
  try {
    return await run();
  } finally {
    (globalThis as Record<string, unknown>).fetch = original;
  }
}

void test('a disc cache key covers the url, the name, and the size', () => {
  const key = rangeCache.discCacheKey(disc);
  assert.match(key, /^kingdom-hearts\.iso-4600000000-[0-9a-f]+$/);
  assert.notEqual(key, rangeCache.discCacheKey({ ...disc, size: disc.size - 1 }));
  assert.notEqual(key, rangeCache.discCacheKey({ ...disc, url: `${disc.url}?token=2` }));
  // A name that cannot be a directory entry still yields a usable key.
  assert.match(rangeCache.discCacheKey({ ...disc, name: '../../etc/passwd' }), /^[a-z0-9.-]+-\d+-[0-9a-f]+$/);
});

void test('a range request asks for the bytes it wants and checks it got them', async () => {
  const requests: Array<Record<string, string>> = [];
  const buffer = await withFetch(((_url: string, init: { headers: Record<string, string> }) => {
    requests.push(init.headers);
    return Promise.resolve(rangeResponse(0, 1024, disc.size));
  }) as never, () => rangeCache.fetchDiscRange(disc.url, 0, 1024) as Promise<ArrayBuffer>);
  assert.equal(buffer.byteLength, 1024);
  assert.deepEqual(requests, [{ Range: 'bytes=0-1023' }]);
});

void test('a server that answers with the wrong bytes is a failure, not a cache entry', async () => {
  // A proxy that ignores Range and returns the whole file answers 200, and a
  // proxy that returns a different window still answers 206. Both would put
  // the wrong sectors on disk under a chunk name the core later trusts.
  await withFetch(() => Promise.resolve({ status: 200, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(disc.size) }),
    async () => assert.rejects(() => rangeCache.fetchDiscRange(disc.url, 0, 1024, { attempts: 1 }), /range request failed/i));
  await withFetch(() => Promise.resolve(rangeResponse(4096, 5120, disc.size)),
    async () => assert.rejects(() => rangeCache.fetchDiscRange(disc.url, 0, 1024, { attempts: 1 }), /wrong byte range/i));
  await withFetch(() => Promise.resolve({ ...rangeResponse(0, 1024, disc.size), arrayBuffer: async () => new ArrayBuffer(512) }),
    async () => assert.rejects(() => rangeCache.fetchDiscRange(disc.url, 0, 1024, { attempts: 1 }), /incomplete byte range/i));
});

void test('a failed range is retried before it gives up', async () => {
  let attempts = 0;
  const buffer = await withFetch(() => {
    attempts += 1;
    if (attempts < 3) return Promise.reject(new Error('network reset'));
    return Promise.resolve(rangeResponse(0, 64, disc.size));
  }, () => rangeCache.fetchDiscRange(disc.url, 0, 64, { attempts: 3 }) as Promise<ArrayBuffer>);
  assert.equal(attempts, 3);
  assert.equal(buffer.byteLength, 64);
});

void test('warming refuses a disc it cannot address, and never throws at the caller', async () => {
  let called = false;
  await withFetch(() => { called = true; return Promise.resolve(rangeResponse(0, 1, 1)); }, async () => {
    for (const bad of [null, { ...disc, url: 'http://assets.example/x.iso' }, { ...disc, size: 0 }]) {
      assert.deepEqual(await rangeCache.prewarmDiscRanges(bad), { warmed: 0, skipped: true });
    }
  });
  assert.equal(called, false, 'a disc that cannot be addressed must not reach the network');
  // Nothing the player asked for has failed when a speculative warm cannot
  // run, so an environment without OPFS reports a skip rather than raising.
  assert.equal((await rangeCache.prewarmDiscRanges(disc)).skipped, true);
});

void test('the PS2 frame reads its ranges through the shared cache', async () => {
  const frame = await readFile(path.resolve(process.cwd(), 'emulators/play/index.html'), 'utf8');
  assert.match(frame, /import \{[^}]*openDiscRangeCache[^}]*\} from '\.\.\/disc-range-cache\.js/);
  assert.doesNotMatch(frame, /async function rangeCache\(/, 'the frame must not keep a second copy of the range cache');
  assert.doesNotMatch(frame, /async function fetchRange\(/, 'the frame must not keep a second copy of the range fetch');
});

void test('walking up to a streaming cabinet warms its boot region', async () => {
  const arcade = await readFile(path.resolve(process.cwd(), 'arcade.js'), 'utf8');
  // warmEmulatorCore runs on approach and returns early once a core is warm,
  // so the disc warm has to happen before that return or it never runs twice.
  const warmCore = arcade.slice(arcade.indexOf('function warmEmulatorCore('));
  assert.match(warmCore, /warmStreamingDisc\(cabinet\)/);
  assert.match(arcade, /prewarmDiscRanges/);
  assert.match(arcade, /warmedDiscCabinets\.has\(cabinet\.id\)/, 'a cabinet must only be warmed once');
});

void test('a measured boot order is warmed instead of the opening chunks', () => {
  // Absent measurement, warming the front of the disc is the best guess. A
  // title that has been observed booting can say exactly what it read, and the
  // order is kept: the first thing the core asks for is the first on disk.
  assert.deepEqual(rangeCache.bootChunkOrder(disc, { chunks: 3 }), [0, 1, 2]);
  assert.deepEqual(rangeCache.bootChunkOrder(disc, { chunks: 3, chunkList: [0, 41, 7] }), [0, 41, 7]);
  // The budget bounds a measured list too, taking the earliest reads first.
  // Mega Man X7 touches 46 chunks before its title screen, and fetching all
  // 184 MB because somebody walked past the cabinet is worse than the wait.
  assert.deepEqual(rangeCache.bootChunkOrder(disc, { chunks: 2, chunkList: [0, 41, 7, 9] }), [0, 41]);
  assert.deepEqual(rangeCache.bootChunkOrder(disc, { chunks: 3, chunkList: [4, 4, 4] }), [4]);
  // A list that cannot be trusted falls back rather than requesting bytes the
  // disc does not have.
  assert.deepEqual(rangeCache.bootChunkOrder(disc, { chunks: 2, chunkList: [-1, 1.5, 9e9] }), [0, 1]);
  assert.deepEqual(rangeCache.bootChunkOrder(disc, { chunks: 2, chunkList: [] }), [0, 1]);
  // Never past the end of a disc smaller than the warm depth.
  assert.deepEqual(rangeCache.bootChunkOrder({ ...disc, size: 1024 }, { chunks: 4 }), [0]);
});

void test('the boot recorder keeps first touches, in order, bounded', () => {
  const recorder = rangeCache.bootChunkRecorder({ limit: 3 });
  for (const index of [5, 5, 2, 5, 9, 11, 12]) recorder.record(index);
  assert.deepEqual(recorder.chunks, [5, 2, 9], 'duplicates are dropped and the limit holds');
  const bad = rangeCache.bootChunkRecorder();
  for (const index of [null, 'x', 1.5, -0.5]) bad.record(index as never);
  assert.deepEqual(bad.chunks, []);
});

void test('a full cache evicts its coldest chunk instead of refusing to cache', async () => {
  // The store used to stop accepting anything once full, so whatever a player
  // read first was all they ever kept and every later session re-fetched the
  // rest of a multi-gigabyte disc from scratch.
  const cache = await openStubCache({ maxChunks: 3, pinnedChunks: 0 });
  for (const index of [0, 1, 2]) await cache.put(index, new ArrayBuffer(8));
  await cache.get(0, 8); // 0 is now the most recently used, 1 the coldest.
  assert.equal(await cache.put(3, new ArrayBuffer(8)), true);
  assert.equal(cache.has(1), false, 'the least recently used chunk is the one that goes');
  assert.deepEqual([cache.has(0), cache.has(2), cache.has(3)], [true, true, true]);
  assert.equal(cache.size, 3);
});

void test('the pinned boot region survives eviction', async () => {
  // Evicting the chunks the next launch reads first would trade a fast boot
  // for one deep-level read that may never happen again.
  const cache = await openStubCache({ maxChunks: 3, pinnedChunks: 2 });
  for (const index of [0, 1, 5]) await cache.put(index, new ArrayBuffer(8));
  assert.equal(await cache.put(6, new ArrayBuffer(8)), true);
  assert.deepEqual([cache.has(0), cache.has(1)], [true, true], 'pinned chunks stay');
  assert.equal(cache.has(5), false, 'the unpinned chunk is the one that goes');
  // Later reads keep trading places among themselves, never with a pin.
  assert.equal(await cache.put(7, new ArrayBuffer(8)), true);
  assert.deepEqual([cache.has(0), cache.has(1), cache.has(6), cache.has(7)], [true, true, false, true]);
});

void test('a cache with nothing but pins declines rather than dropping one', async () => {
  const cache = await openStubCache({ maxChunks: 2, pinnedChunks: 2 });
  for (const index of [0, 1]) await cache.put(index, new ArrayBuffer(8));
  assert.equal(await cache.put(9, new ArrayBuffer(8)), false);
  assert.deepEqual([cache.has(0), cache.has(1), cache.has(9)], [true, true, false]);
});

/**
 * OPFS in miniature: enough of the directory handle surface for the cache to
 * run against, so eviction and pinning are tested for real rather than read.
 */
function stubDirectory() {
  const files = new Map<string, number>();
  return {
    files,
    keys: async function* () { yield* [...files.keys()]; },
    async getFileHandle(name: string, options?: { create?: boolean }) {
      if (!files.has(name) && !options?.create) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
      return {
        async getFile() {
          const size = files.get(name);
          if (size === undefined) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
          return { size, arrayBuffer: async () => new ArrayBuffer(size) };
        },
        async createWritable() {
          return {
            async write(buffer: ArrayBuffer) { files.set(name, buffer.byteLength); },
            async close() { /* written */ },
            async abort() { files.delete(name); }
          };
        }
      };
    },
    async removeEntry(name: string) {
      if (!files.delete(name)) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
    }
  };
}

async function openStubCache(options: { maxChunks: number; pinnedChunks: number }) {
  const directory = stubDirectory();
  const storage = { persist: async () => true, getDirectory: async () => ({ getDirectoryHandle: async () => ({ getDirectoryHandle: async () => directory }) }) };
  const original = (globalThis as Record<string, unknown>).navigator;
  Object.defineProperty(globalThis, 'navigator', { value: { storage }, configurable: true });
  try {
    return await rangeCache.openDiscRangeCache(disc, options.maxChunks, { pinnedChunks: options.pinnedChunks });
  } finally {
    Object.defineProperty(globalThis, 'navigator', { value: original, configurable: true });
  }
}

void test('a streaming disc fills itself in while the game is being played', async () => {
  const frame = await readFile(path.resolve(process.cwd(), 'emulators/play/index.html'), 'utf8');
  const install = frame.slice(frame.indexOf('async function installDisc()'), frame.indexOf('void installDisc()'));
  assert.ok(install.length > 0, 'the frame must fill in the rest of the disc it is streaming');

  // Storage first: never fill a browser's quota on a speculative copy, and
  // never do it on a metered connection.
  assert.match(install, /navigator\.connection\?\.saveData/);
  assert.match(install, /estimate\.quota - estimate\.usage < source\.size \+ INSTALL_HEADROOM_BYTES/);
  // What is already there is skipped, so this resumes across sessions.
  assert.match(install, /if \(persistent\.has\(index\)\) continue;/);
  // And it gives up rather than hammering a store that has started refusing.
  assert.match(install, /if \(persistentCacheFailed\) return;/);

  // It yields to the core. A background fetch that delays a read the player is
  // waiting on has made the game worse now to make it better later.
  assert.match(install, /performance\.now\(\) - lastDemandRead < INSTALL_QUIET_MS/);
  assert.match(install, /INSTALL_PAUSE_MS/);

  // Yielding is triggered by reads that reach the network, not by cache hits.
  // Counting hits stalled the install at eight chunks: during play almost every
  // read is a hit, so the quiet window never came.
  const cached = frame.slice(frame.indexOf('function cachedChunk(index)'), frame.indexOf('function cachedChunk(index)') + 400);
  assert.doesNotMatch(cached, /lastDemandRead = performance\.now\(\)/, 'a cache hit is not pressure to yield to');
  const load = frame.slice(frame.indexOf('async function loadChunk('), frame.indexOf('function cachedChunk(index)'));
  assert.match(load, /lastDemandRead = performance\.now\(\);/);
  // A demand read cancels the speculative fetch outright rather than waiting
  // behind it. Backing off only after one starts is too late: on a 4.5 MB/s
  // line a 4 MB install chunk is most of a second of the player waiting, and
  // measured cold, the install eating the link took the core to 14 f/s.
  assert.match(load, /installFetch\?\.abort\(\);/);
  assert.match(load, /fetchDiscRange\(source\.url, start, end, \{ priority: 'high' \}\)/);
  assert.match(install, /priority: 'low'/, 'the install must queue behind the reads a player is waiting on');
  assert.match(install, /if \(controller\.signal\.aborted\) \{ index -= 1; continue; \}/, 'a cancelled chunk waits, it does not end the install');

  // The store has to be able to hold the whole disc, or it evicts the start of
  // the game to make room for the end and never finishes.
  assert.match(frame, /Math\.max\(128, totalChunks\)/);
});
