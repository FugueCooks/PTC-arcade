import { readFile, writeFile } from 'node:fs/promises';

const [, , sourcePath, textureDonorPath, outputPath] = process.argv;
if (!sourcePath || !textureDonorPath || !outputPath) {
  throw new Error('Usage: node tools/transplant-glb-textures.mjs source.glb texture-donor.glb output.glb');
}

const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

function parseGlb(buffer) {
  if (buffer.readUInt32LE(0) !== 0x46546c67 || buffer.readUInt32LE(4) !== 2) {
    throw new Error('Expected a glTF 2.0 binary file');
  }
  let offset = 12;
  let json;
  let binary;
  while (offset < buffer.length) {
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === JSON_CHUNK) json = JSON.parse(data.toString('utf8').trim());
    if (type === BIN_CHUNK) binary = data;
    offset += 8 + length;
  }
  if (!json || !binary) throw new Error('GLB must contain JSON and BIN chunks');
  return { json, binary };
}

function viewBytes(glb, index) {
  const view = glb.json.bufferViews[index];
  if (!view || view.buffer !== 0) throw new Error(`Unsupported buffer view ${index}`);
  const start = view.byteOffset ?? 0;
  return glb.binary.subarray(start, start + view.byteLength);
}

function align4(length) {
  return (length + 3) & ~3;
}

const source = parseGlb(await readFile(sourcePath));
const donor = parseGlb(await readFile(textureDonorPath));
if (source.json.images?.length !== donor.json.images?.length) {
  throw new Error('Source and texture donor must contain the same number of images');
}

const replacementByView = new Map();
for (let index = 0; index < source.json.images.length; index += 1) {
  const sourceImage = source.json.images[index];
  const donorImage = donor.json.images[index];
  if (sourceImage.bufferView === undefined || donorImage.bufferView === undefined) {
    throw new Error('Only embedded GLB images are supported');
  }
  replacementByView.set(sourceImage.bufferView, viewBytes(donor, donorImage.bufferView));
  sourceImage.mimeType = 'image/webp';
}

const chunks = [];
let binaryLength = 0;
source.json.bufferViews.forEach((view, index) => {
  const bytes = replacementByView.get(index) ?? viewBytes(source, index);
  const alignedOffset = align4(binaryLength);
  if (alignedOffset > binaryLength) chunks.push(Buffer.alloc(alignedOffset - binaryLength));
  view.byteOffset = alignedOffset;
  view.byteLength = bytes.length;
  chunks.push(bytes);
  binaryLength = alignedOffset + bytes.length;
});
const paddedBinaryLength = align4(binaryLength);
if (paddedBinaryLength > binaryLength) chunks.push(Buffer.alloc(paddedBinaryLength - binaryLength));
const binary = Buffer.concat(chunks, paddedBinaryLength);
source.json.buffers[0].byteLength = paddedBinaryLength;

for (const texture of source.json.textures ?? []) {
  if (texture.source === undefined) continue;
  texture.extensions = { ...texture.extensions, EXT_texture_webp: { source: texture.source } };
  delete texture.source;
}
source.json.extensionsUsed = [...new Set([...(source.json.extensionsUsed ?? []), 'EXT_texture_webp'])];
source.json.extensionsRequired = [...new Set([...(source.json.extensionsRequired ?? []), 'EXT_texture_webp'])];

const jsonBytes = Buffer.from(JSON.stringify(source.json));
const paddedJsonLength = align4(jsonBytes.length);
const jsonChunk = Buffer.alloc(paddedJsonLength, 0x20);
jsonBytes.copy(jsonChunk);
const output = Buffer.alloc(12 + 8 + jsonChunk.length + 8 + binary.length);
output.writeUInt32LE(0x46546c67, 0);
output.writeUInt32LE(2, 4);
output.writeUInt32LE(output.length, 8);
output.writeUInt32LE(jsonChunk.length, 12);
output.writeUInt32LE(JSON_CHUNK, 16);
jsonChunk.copy(output, 20);
const binaryHeader = 20 + jsonChunk.length;
output.writeUInt32LE(binary.length, binaryHeader);
output.writeUInt32LE(BIN_CHUNK, binaryHeader + 4);
binary.copy(output, binaryHeader + 8);

await writeFile(outputPath, output);
console.log(`${sourcePath} -> ${outputPath} (${output.length} bytes)`);
