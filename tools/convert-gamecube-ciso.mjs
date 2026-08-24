import { open } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const CISO_HEADER_SIZE = 0x8000;
const GAMECUBE_DISC_SIZE = 1_459_978_240;

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  console.error('Usage: node tools/convert-gamecube-ciso.mjs <input.ciso> <output.iso>');
  process.exit(1);
}

const input = await open(path.resolve(inputPath), 'r');
const output = await open(path.resolve(outputPath), 'w');

try {
  const header = Buffer.alloc(CISO_HEADER_SIZE);
  const headerRead = await input.read(header, 0, header.length, 0);
  if (headerRead.bytesRead !== header.length || header.toString('ascii', 0, 4) !== 'CISO') {
    throw new Error('Input is not a supported CISO image.');
  }

  const blockSize = header.readUInt32LE(4);
  if (blockSize < 0x8000 || blockSize > 0x800000 || (blockSize & (blockSize - 1)) !== 0) {
    throw new Error(`Invalid CISO block size: ${blockSize}`);
  }

  const blockCount = Math.ceil(GAMECUBE_DISC_SIZE / blockSize);
  if (blockCount > CISO_HEADER_SIZE - 8) throw new Error('CISO block map is too small for this image.');

  await output.truncate(GAMECUBE_DISC_SIZE);
  const block = Buffer.allocUnsafe(blockSize);
  let packedOffset = CISO_HEADER_SIZE;
  let packedBlocks = 0;

  for (let index = 0; index < blockCount; index += 1) {
    if (header[8 + index] === 0) continue;
    const outputOffset = index * blockSize;
    const bytesToCopy = Math.min(blockSize, GAMECUBE_DISC_SIZE - outputOffset);
    const read = await input.read(block, 0, blockSize, packedOffset);
    if (read.bytesRead < bytesToCopy) throw new Error(`CISO ended unexpectedly at packed block ${packedBlocks}.`);
    await output.write(block, 0, bytesToCopy, outputOffset);
    packedOffset += blockSize;
    packedBlocks += 1;
  }

  const inputStats = await input.stat();
  if (packedOffset > inputStats.size) throw new Error('CISO block map references data beyond the end of the file.');
  console.log(`Converted ${packedBlocks} packed blocks into ${GAMECUBE_DISC_SIZE} bytes: ${path.resolve(outputPath)}`);
} finally {
  await Promise.allSettled([input.close(), output.close()]);
}
