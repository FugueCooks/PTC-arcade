import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const inspector = await import(pathToFileURL(path.resolve(process.cwd(), 'tools/inspect-disc-images.mjs')).href);

const GAMECUBE_DISC_BYTES = 1_459_978_240;

/** The first 96 bytes of an RVZ: header 1 is 72 bytes, header 2 follows. */
function rvzHeader({ magic = 'RVZ', discBytes = GAMECUBE_DISC_BYTES, compression = 5, level = 5 } = {}) {
  const head = Buffer.alloc(96);
  head.write(magic, 0, 'latin1');
  head.writeUInt32BE(0x01000000, 4);
  head.writeBigUInt64BE(BigInt(discBytes), 36);
  head.writeUInt32BE(1, 72);
  head.writeUInt32BE(compression, 76);
  head.writeInt32BE(level, 80);
  return head;
}

function chdHeader(compressors: string[]) {
  const head = Buffer.alloc(96);
  head.write('MComprHD', 0, 'latin1');
  head.writeUInt32BE(5, 12);
  compressors.forEach((tag, index) => head.write(tag, 16 + index * 4, 'latin1'));
  return head;
}

void test('an uncompressed RVZ is reported as such, with what it costs', () => {
  // Every hosted GameCube image was stored with compression NONE: RVZ removes
  // the disc's junk data either way, which is why the sizes looked plausible
  // while a player still downloaded most of a raw disc.
  const report = inspector.describeImage('melee.rvz', rvzHeader({ compression: 0, level: 0 }), 1_426_853_848);
  assert.equal(report.packing, 'NONE');
  assert.equal(report.ofDisc, '97.7%');
  assert.equal(report.discMB, 1392);
});

void test('a compressed RVZ names its codec', () => {
  assert.equal(inspector.describeImage('a.rvz', rvzHeader({ compression: 5 }), 500_000_000).packing, 'ZSTD');
  assert.equal(inspector.describeImage('a.rvz', rvzHeader({ compression: 4 }), 500_000_000).packing, 'LZMA2');
  assert.equal(inspector.describeImage('a.rvz', rvzHeader({ compression: 99 }), 500).packing, 'type-99');
});

void test('a CHD lists the compressors it was written with', () => {
  assert.equal(inspector.describeImage('x.chd', chdHeader(['cdlz', 'cdzl', 'cdfl']), 400).packing, 'cdlz+cdzl+cdfl');
  assert.equal(inspector.describeImage('x.chd', chdHeader([]), 400).packing, 'NONE');
});

void test('anything that is not what its extension claims is reported, not guessed', () => {
  assert.equal(inspector.describeImage('a.rvz', Buffer.alloc(96), 1).packing, 'unknown');
  assert.equal(inspector.describeImage('a.chd', Buffer.alloc(96), 1).packing, 'unknown');
  assert.equal(inspector.describeImage('a.rvz', Buffer.alloc(8), 1).note, 'short read');
  // A raw image has no header to read: its size is its size.
  assert.equal(inspector.describeImage('a.iso', Buffer.alloc(96), 1).packing, 'raw');
});
