import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { importBrowserModule } from './helpers/browser-module.js';

const { DiskLibrary } = await importBrowserModule<any>('ptc-runtime/src/disk-library.js');

const PAYLOAD = Buffer.from('a gamecube disc image, for the purposes of this test'.repeat(64));
const DIGEST = createHash('sha256').update(PAYLOAD).digest('hex');

/** Serves the payload, or a corrupted version of it, over real HTTP. */
async function serve(body: Buffer) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(body.length) });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/image.rvz`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function withLibrary(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'ptc-library-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

const entryFor = (url: string, sha256 = DIGEST) => ({
  gameId: 'wind-waker', platformId: 'gamecube',
  downloadUrl: url, fileName: 'wind-waker.rvz', sizeBytes: PAYLOAD.length, sha256
});

void test('a good download lands in the library and is reported verified', async () => {
  await withLibrary(async (root) => {
    const origin = await serve(PAYLOAD);
    try {
      const library = new DiskLibrary({ root });
      const entry = entryFor(origin.url);

      assert.deepEqual(await library.inspect(entry), { present: false });

      const percents: number[] = [];
      const result = await library.download(entry, { onProgress: ({ percent }: any) => percents.push(percent) });
      assert.equal(result.ok, true);
      assert.equal(result.sha256, DIGEST);
      assert.ok(percents.length > 0 && percents.at(-1) === 100);

      const contents = await readFile(path.join(root, 'wind-waker.rvz'));
      assert.deepEqual(contents, PAYLOAD);

      const inspected = await library.inspect(entry);
      assert.equal(inspected.present, true);
      assert.equal(inspected.verifiedSha256, DIGEST, 'this run proved the file, so it need not read it again');
    } finally { await origin.close(); }
  });
});

void test('a corrupted download leaves nothing a later launch could pick up', async () => {
  // The reason downloads land on a temporary name: a partial or wrong file
  // under the real name would pass the next size check and reach Dolphin.
  await withLibrary(async (root) => {
    const origin = await serve(Buffer.concat([PAYLOAD.subarray(0, PAYLOAD.length - 1), Buffer.from('!')]));
    try {
      const library = new DiskLibrary({ root });
      const result = await library.download(entryFor(origin.url));

      assert.equal(result.ok, false);
      assert.equal(result.reason, 'integrity-failed');

      const files = await readdir(root);
      assert.deepEqual(files, [], 'neither the game nor a partial file may survive a digest failure');
    } finally { await origin.close(); }
  });
});

void test('a truncated response never becomes a library file', async () => {
  await withLibrary(async (root) => {
    const origin = await serve(PAYLOAD.subarray(0, 32));
    try {
      const library = new DiskLibrary({ root });
      const result = await library.download(entryFor(origin.url));
      assert.equal(result.ok, false);
      assert.deepEqual(await readdir(root), []);
    } finally { await origin.close(); }
  });
});

void test('a cached file is re-read on demand and proven against the catalogue', async () => {
  await withLibrary(async (root) => {
    const library = new DiskLibrary({ root });
    const entry = entryFor('https://unused.example/image.rvz');
    await writeFile(path.join(root, 'wind-waker.rvz'), PAYLOAD);

    // Written outside the library, so nothing has proven it yet.
    assert.equal((await library.inspect(entry)).verifiedSha256, null);

    const verified = await library.verify(entry);
    assert.equal(verified.ok, true);
    assert.equal(verified.sha256, DIGEST);
    assert.equal((await library.inspect(entry)).verifiedSha256, DIGEST);
  });
});

void test('a tampered cached file fails verification and is discarded', async () => {
  await withLibrary(async (root) => {
    const library = new DiskLibrary({ root });
    const entry = entryFor('https://unused.example/image.rvz');
    await writeFile(path.join(root, 'wind-waker.rvz'), Buffer.alloc(PAYLOAD.length, 9));

    const verified = await library.verify(entry);
    assert.notEqual(verified.sha256, DIGEST);

    await library.discard(entry);
    assert.deepEqual(await readdir(root), [], 'a file that failed its digest is removed, never repaired');
  });
});

void test('a file name that would escape the library is refused on disk too', async () => {
  await withLibrary(async (root) => {
    const library = new DiskLibrary({ root });
    const escaping = { ...entryFor('https://unused.example/x.rvz'), fileName: '../escape.rvz' };
    assert.equal((await library.resolve(escaping)).ok, false);
    assert.equal((await library.download(escaping)).ok, false);
    assert.deepEqual(await readdir(root), []);
  });
});

void test('an unreachable download fails cleanly rather than throwing', async () => {
  await withLibrary(async (root) => {
    const library = new DiskLibrary({
      root, fetchImpl: async () => { throw new Error('connection refused'); }
    });
    const result = await library.download(entryFor('https://unreachable.invalid/x.rvz'));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'download-failed');
    assert.deepEqual(await readdir(root), []);
  });
});
