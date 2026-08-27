import assert from 'node:assert/strict';
import test from 'node:test';
import { importBrowserModule } from './helpers/browser-module.js';

/**
 * Turning a game id into bytes a native emulator may open.
 *
 * The download is untrusted until its digest matches the catalogue, and the
 * catalogue is the only thing that decides what gets written where. These are
 * the checks that keep a compromised page or a substituted response from
 * reaching Dolphin.
 */
const library = await importBrowserModule<any>('ptc-runtime/src/library.js');

const ENTRY = Object.freeze({
  gameId: 'wind-waker',
  platformId: 'gamecube',
  downloadUrl: 'https://cdn.example/arcade/games/wind-waker.rvz',
  fileName: 'wind-waker.rvz',
  sizeBytes: 1_084_862_396,
  sha256: 'a'.repeat(64)
});

void test('a catalogue entry without a digest is dropped, not repaired', () => {
  // An entry with no digest is an unverifiable download. Offering it would mean
  // handing Dolphin bytes nothing vouched for.
  const { entries, rejected } = library.parseCatalog({
    games: [ENTRY, { ...ENTRY, gameId: 'pikmin', sha256: undefined }]
  });
  assert.equal(entries.size, 1);
  assert.equal(entries.has('pikmin'), false);
  assert.deepEqual(rejected, [{ gameId: 'pikmin', reason: 'invalid-entry' }]);
});

void test('a catalogue may not point the runtime at plain http or a credentialed URL', () => {
  for (const downloadUrl of [
    'http://cdn.example/game.rvz',
    'https://user:pass@cdn.example/game.rvz',
    'file:///etc/passwd',
    'ftp://cdn.example/game.rvz'
  ]) {
    const { entries } = library.parseCatalog({ games: [{ ...ENTRY, downloadUrl }] });
    assert.equal(entries.size, 0, downloadUrl);
  }
});

void test('duplicate ids do not silently shadow each other', () => {
  const { entries, rejected } = library.parseCatalog({
    games: [ENTRY, { ...ENTRY, sha256: 'b'.repeat(64) }]
  });
  assert.equal(entries.size, 1);
  assert.equal(entries.get('wind-waker').sha256, 'a'.repeat(64), 'the first entry wins');
  assert.deepEqual(rejected, [{ gameId: 'wind-waker', reason: 'duplicate' }]);
});

void test('a malformed catalogue yields nothing rather than a partial library', () => {
  for (const payload of [null, undefined, {}, { games: 'lots' }, []]) {
    const result = library.parseCatalog(payload);
    assert.equal(result.ok, false, JSON.stringify(payload));
    assert.equal(result.entries.length ?? result.entries.size ?? 0, 0);
  }
});

void test('a file name cannot escape the library directory', () => {
  const join = (a: string, b: string) => `${a}/${b}`;
  const resolve = (p: string) => p.split('/').reduce((stack: string[], part) => {
    if (part === '..') stack.pop();
    else if (part !== '.' && part !== '') stack.push(part);
    return stack;
  }, []).join('/').replace(/^/, '/');

  const ok = library.resolveLibraryPath('/library', ENTRY, join, resolve);
  assert.equal(ok.ok, true);
  assert.equal(ok.path, '/library/wind-waker.rvz');

  for (const fileName of ['../escape.rvz', '../../etc/passwd', '/absolute.rvz', 'sub/dir.rvz', '..']) {
    const escaped = library.resolveLibraryPath('/library', { ...ENTRY, fileName }, join, resolve);
    assert.equal(escaped.ok, false, fileName);
  }
});

void test('a cached, verified image launches without downloading again', () => {
  // The whole point of the runtime: the second launch is instant.
  const plan = library.planLaunch({
    entry: ENTRY,
    cached: { present: true, sizeBytes: ENTRY.sizeBytes, verifiedSha256: ENTRY.sha256 }
  });
  assert.deepEqual(plan, { action: 'launch', reason: 'cached' });
});

void test('a cached image of the wrong size is re-downloaded, not trusted', () => {
  const plan = library.planLaunch({
    entry: ENTRY,
    cached: { present: true, sizeBytes: 12, verifiedSha256: ENTRY.sha256 }
  });
  assert.equal(plan.action, 'download', 'a truncated file must never be launched on the strength of a stale digest');
});

void test('a cached image with no recorded digest is verified before launch', () => {
  const plan = library.planLaunch({
    entry: ENTRY,
    cached: { present: true, sizeBytes: ENTRY.sizeBytes, verifiedSha256: null }
  });
  assert.equal(plan.action, 'verify');
});

void test('an unknown game is refused rather than downloaded', () => {
  assert.deepEqual(library.planLaunch({ entry: undefined, cached: null }), { action: 'refuse', reason: 'unknown-game' });
});

void test('the digest is computed while downloading, and progress is whole percents', async () => {
  const written: Buffer[] = [];
  const progress: number[] = [];
  const total = 400;
  const chunk = Buffer.alloc(4, 7);

  async function* source() {
    for (let sent = 0; sent < total; sent += chunk.length) yield chunk;
  }

  const result = await library.downloadAndDigest({
    source: source(),
    sink: { write: async (b: Buffer) => { written.push(b); } },
    expectedBytes: total,
    onProgress: ({ percent }: { percent: number }) => progress.push(percent)
  });

  assert.equal(result.receivedBytes, total);
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(progress, [...new Set(progress)], 'a percent must not be reported twice');
  assert.equal(progress.at(-1), 100);
  assert.ok(progress.length <= 100, 'progress must not be one event per chunk');
});

void test('a response longer than the catalogue declared is aborted mid-stream', async () => {
  // Not just rejected at the end: a lying length would otherwise fill the disk
  // before anyone checked.
  async function* source() {
    for (let index = 0; index < 100; index += 1) yield Buffer.alloc(16, 1);
  }
  await assert.rejects(
    () => library.downloadAndDigest({
      source: source(),
      sink: { write: async () => {} },
      expectedBytes: 32
    }),
    /exceeded the size/
  );
});

void test('a truncated download fails rather than launching short', async () => {
  async function* source() { yield Buffer.alloc(8, 1); }
  await assert.rejects(
    () => library.downloadAndDigest({ source: source(), sink: { write: async () => {} }, expectedBytes: 64 }),
    /ended before the size/
  );
});

void test('a digest mismatch is a refusal, in constant time', () => {
  assert.equal(library.verifyDigest('a'.repeat(64), 'a'.repeat(64)).ok, true);
  assert.equal(library.verifyDigest('a'.repeat(64), 'b'.repeat(64)).ok, false);
  assert.equal(library.verifyDigest('a'.repeat(63), 'a'.repeat(64)).ok, false);
  assert.equal(library.verifyDigest(undefined, 'a'.repeat(64)).ok, false);
});

void test('the catalogue is fetched from the arcade origin, not from a supplied URL', () => {
  const resolved = library.catalogUrlFor('https://ptcarcade.fun');
  assert.equal(resolved.ok, true);
  assert.equal(resolved.url, 'https://ptcarcade.fun/api/v1/runtime/catalog');

  assert.equal(library.catalogUrlFor('http://evil.example').ok, false, 'plaintext origins are refused');
});
