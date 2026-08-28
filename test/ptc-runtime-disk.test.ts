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

/** Files a launch could pick up: the games, not the library's own state. */
async function gameFiles(root: string) {
  return (await readdir(root)).filter((name) => name !== '.ptc-runtime').sort();
}

/** What the library is holding for a later attempt at the same download. */
async function stateFiles(root: string) {
  return (await readdir(path.join(root, '.ptc-runtime')).catch(() => [])).sort();
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

      assert.deepEqual(await gameFiles(root), [], 'no game file may survive a digest failure');
      // A prefix whose digest is already known to be wrong must never be
      // resumed: every later attempt would inherit the same bad bytes.
      assert.deepEqual(await stateFiles(root), [], 'nor may the partial it was built from');
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
      assert.deepEqual(await gameFiles(root), [], 'a short transfer is never a game file');
      // It is, however, exactly the case resuming exists for, so the bytes that
      // did arrive are kept for the next attempt.
      assert.deepEqual(await stateFiles(root), [
        '957c63101cb7a057c72f414657a775f6c0f04d3760aeff95acc920b801a47904.partial',
        '957c63101cb7a057c72f414657a775f6c0f04d3760aeff95acc920b801a47904.partial.json'
      ], 'the prefix that did arrive is kept to resume from');
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
    assert.deepEqual(await gameFiles(root), []);
    assert.deepEqual(await stateFiles(root), [], 'a transfer that never started leaves nothing to resume');
  });
});

void test('an interrupted download resumes from the bytes already on disk', async () => {
  // The reason any of the state above exists. A GameCube image is about a
  // gigabyte and a PS2 disc several, so a transfer that drops at 90% must not
  // start again from zero.
  await withLibrary(async (root) => {
    const cut = 96;
    let served = 0;
    const ranges: Array<string | undefined> = [];
    const server = createServer((request, response) => {
      ranges.push(request.headers.range);
      const match = /^bytes=(\d+)-$/.exec(request.headers.range ?? '');
      const start = match ? Number(match[1]) : 0;
      served += 1;
      if (served === 1) {
        // The first attempt dies partway through, as a dropped connection does.
        response.writeHead(200, { 'content-length': String(PAYLOAD.length) });
        response.write(PAYLOAD.subarray(0, cut));
        // Destroyed after the bytes have flushed, which is what a connection
        // dropped mid-transfer looks like. Destroying in the same tick sends
        // nothing at all, and then there is no prefix to resume from.
        setTimeout(() => response.destroy(), 40);
        return;
      }
      const body = PAYLOAD.subarray(start);
      response.writeHead(start > 0 ? 206 : 200, {
        'content-length': String(body.length),
        ...(start > 0 ? { 'content-range': `bytes ${start}-${PAYLOAD.length - 1}/${PAYLOAD.length}` } : {})
      });
      response.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/image.rvz`;
    try {
      const library = new DiskLibrary({ root });
      const entry = entryFor(url);

      const first = await library.download(entry);
      assert.equal(first.ok, false, 'the dropped connection is not a success');
      assert.equal((await stateFiles(root)).length, 2, 'the prefix is kept');

      const resumedFrom: number[] = [];
      const second = await library.download(entry, {
        onProgress: ({ resumed, receivedBytes }: any) => { if (resumed) resumedFrom.push(receivedBytes); }
      });
      assert.equal(second.ok, true);
      assert.equal(second.sha256, DIGEST);
      assert.deepEqual(await readFile(path.join(root, 'wind-waker.rvz')), PAYLOAD);

      // It asked for the rest, rather than the whole object a second time.
      assert.equal(ranges[1], `bytes=${cut}-`, 'the second attempt requests only the remainder');
      assert.deepEqual(resumedFrom, [cut], 'and reports where it picked up');
      assert.deepEqual(await stateFiles(root), ['957c63101cb7a057c72f414657a775f6c0f04d3760aeff95acc920b801a47904.verified.json'],
        'the partial is consumed, leaving only the record that the image is proven');
    } finally { await new Promise<void>((r) => server.close(() => r())); }
  });
});
