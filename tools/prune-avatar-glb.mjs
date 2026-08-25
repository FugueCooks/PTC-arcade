import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const [sourcePath, outputPath, ...clipNames] = process.argv.slice(2);
if (!sourcePath || !outputPath || clipNames.length === 0) {
  throw new Error('Usage: node tools/prune-avatar-glb.mjs <source.glb> <output.glb> <clip> [clip...]');
}

const source = fs.readFileSync(sourcePath);
if (source.readUInt32LE(0) !== 0x46546c67 || source.readUInt32LE(4) !== 2) {
  throw new Error('Only binary glTF 2.0 files are supported.');
}

let cursor = 12;
let json;
let binary;
while (cursor < source.length) {
  const length = source.readUInt32LE(cursor);
  const type = source.readUInt32LE(cursor + 4);
  const chunk = source.subarray(cursor + 8, cursor + 8 + length);
  if (type === 0x4e4f534a) json = JSON.parse(chunk.toString('utf8').trim());
  if (type === 0x004e4942) binary = Buffer.from(chunk);
  cursor += 8 + length;
}
if (!json || !binary || !Array.isArray(json.animations)) throw new Error('The GLB is missing JSON, binary, or animation data.');
if ((json.bufferViews ?? []).some((view) => view.extensions?.EXT_meshopt_compression)) {
  throw new Error('Run this lossless pruning step before applying Meshopt compression.');
}

const requested = new Set(clipNames);
const available = new Set(json.animations.map((animation) => animation.name));
for (const name of requested) if (!available.has(name)) throw new Error(`Animation clip not found: ${name}`);
json.animations = json.animations.filter((animation) => requested.has(animation.name));

// Exporters often write one identical time accessor per animated channel. This
// model has hundreds of channels, so those duplicated time arrays account for
// most of its file size. Redirect byte-identical animation accessors to one
// canonical accessor without resampling or changing a single authored value.
const componentBytes = new Map([[5120, 1], [5121, 1], [5122, 2], [5123, 2], [5125, 4], [5126, 4]]);
const typeComponents = new Map([['SCALAR', 1], ['VEC2', 2], ['VEC3', 3], ['VEC4', 4], ['MAT2', 4], ['MAT3', 9], ['MAT4', 16]]);
const accessorPayload = (accessorIndex) => {
  const accessor = json.accessors?.[accessorIndex];
  const view = json.bufferViews?.[accessor?.bufferView];
  const elementBytes = componentBytes.get(accessor?.componentType) * typeComponents.get(accessor?.type);
  if (!accessor || !view || !elementBytes || accessor.sparse || (view.byteStride && view.byteStride !== elementBytes)) return undefined;
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  return binary.subarray(start, start + accessor.count * elementBytes);
};
const canonicalAccessor = new Map();
for (const animation of json.animations) {
  for (const sampler of animation.samplers ?? []) {
    for (const field of ['input', 'output']) {
      const accessorIndex = sampler[field];
      const accessor = json.accessors?.[accessorIndex];
      const payload = accessorPayload(accessorIndex);
      if (!accessor || !payload) continue;
      const metadata = JSON.stringify({
        componentType: accessor.componentType,
        type: accessor.type,
        count: accessor.count,
        normalized: accessor.normalized ?? false,
        min: accessor.min,
        max: accessor.max,
      });
      const key = `${metadata}:${createHash('sha256').update(payload).digest('hex')}`;
      const existing = canonicalAccessor.get(key);
      if (existing === undefined) canonicalAccessor.set(key, accessorIndex);
      else sampler[field] = existing;
    }
  }
}

// Re-home retained animation accessors into tightly packed views. The source
// groups many unrelated accessors into very large shared views; simply dropping
// duplicate accessor references would otherwise leave all unused bytes behind.
const animationAccessorIndices = new Set();
for (const animation of json.animations) {
  for (const sampler of animation.samplers ?? []) {
    animationAccessorIndices.add(sampler.input);
    animationAccessorIndices.add(sampler.output);
  }
}
const packedAnimationAccessors = [...animationAccessorIndices].map((accessorIndex) => {
  const payload = accessorPayload(accessorIndex);
  if (!payload) throw new Error(`Cannot tightly pack animation accessor ${accessorIndex}.`);
  return { accessorIndex, payload: Buffer.from(payload) };
});
const animationChunks = [binary];
let animationByteLength = binary.length;
for (const { accessorIndex, payload } of packedAnimationAccessors) {
  const padding = (4 - (animationByteLength % 4)) % 4;
  if (padding) {
    animationChunks.push(Buffer.alloc(padding));
    animationByteLength += padding;
  }
  const bufferView = json.bufferViews.length;
  json.bufferViews.push({ buffer: 0, byteOffset: animationByteLength, byteLength: payload.length });
  json.accessors[accessorIndex].bufferView = bufferView;
  delete json.accessors[accessorIndex].byteOffset;
  animationChunks.push(payload);
  animationByteLength += payload.length;
}
binary = Buffer.concat(animationChunks, animationByteLength);

const usedAccessors = new Set();
for (const mesh of json.meshes ?? []) {
  for (const primitive of mesh.primitives ?? []) {
    if (Number.isInteger(primitive.indices)) usedAccessors.add(primitive.indices);
    for (const accessor of Object.values(primitive.attributes ?? {})) usedAccessors.add(accessor);
    for (const target of primitive.targets ?? []) {
      for (const accessor of Object.values(target)) usedAccessors.add(accessor);
    }
  }
}
for (const skin of json.skins ?? []) {
  if (Number.isInteger(skin.inverseBindMatrices)) usedAccessors.add(skin.inverseBindMatrices);
}
for (const animation of json.animations) {
  for (const sampler of animation.samplers ?? []) {
    usedAccessors.add(sampler.input);
    usedAccessors.add(sampler.output);
  }
}

const accessorMap = new Map();
json.accessors = (json.accessors ?? []).flatMap((accessor, oldIndex) => {
  if (!usedAccessors.has(oldIndex)) return [];
  accessorMap.set(oldIndex, accessorMap.size);
  return [accessor];
});
const remapAccessor = (index) => {
  const mapped = accessorMap.get(index);
  if (mapped === undefined) throw new Error(`Referenced accessor ${index} was not retained.`);
  return mapped;
};
for (const mesh of json.meshes ?? []) {
  for (const primitive of mesh.primitives ?? []) {
    if (Number.isInteger(primitive.indices)) primitive.indices = remapAccessor(primitive.indices);
    for (const name of Object.keys(primitive.attributes ?? {})) primitive.attributes[name] = remapAccessor(primitive.attributes[name]);
    for (const target of primitive.targets ?? []) {
      for (const name of Object.keys(target)) target[name] = remapAccessor(target[name]);
    }
  }
}
for (const skin of json.skins ?? []) {
  if (Number.isInteger(skin.inverseBindMatrices)) skin.inverseBindMatrices = remapAccessor(skin.inverseBindMatrices);
}
for (const animation of json.animations) {
  for (const sampler of animation.samplers ?? []) {
    sampler.input = remapAccessor(sampler.input);
    sampler.output = remapAccessor(sampler.output);
  }
}

const usedViews = new Set();
const findBufferViews = (value) => {
  if (!value || typeof value !== 'object') return;
  if (Number.isInteger(value.bufferView)) usedViews.add(value.bufferView);
  for (const child of Object.values(value)) findBufferViews(child);
};
findBufferViews(json);

const viewMap = new Map();
const chunks = [];
let byteLength = 0;
const align = () => {
  const padding = (4 - (byteLength % 4)) % 4;
  if (padding) {
    chunks.push(Buffer.alloc(padding));
    byteLength += padding;
  }
};
json.bufferViews = (json.bufferViews ?? []).flatMap((view, oldIndex) => {
  if (!usedViews.has(oldIndex)) return [];
  align();
  const start = view.byteOffset ?? 0;
  const payload = binary.subarray(start, start + view.byteLength);
  const next = { ...view, byteOffset: byteLength };
  chunks.push(payload);
  byteLength += payload.length;
  viewMap.set(oldIndex, viewMap.size);
  return [next];
});
const remapViews = (value) => {
  if (!value || typeof value !== 'object') return;
  if (Number.isInteger(value.bufferView)) {
    const mapped = viewMap.get(value.bufferView);
    if (mapped === undefined) throw new Error(`Referenced bufferView ${value.bufferView} was not retained.`);
    value.bufferView = mapped;
  }
  for (const child of Object.values(value)) remapViews(child);
};
remapViews(json);

align();
const compactBinary = Buffer.concat(chunks, byteLength);
json.buffers = [{ ...(json.buffers?.[0] ?? {}), byteLength: compactBinary.length }];

const pad = (buffer, byte = 0) => buffer.length % 4
  ? Buffer.concat([buffer, Buffer.alloc(4 - (buffer.length % 4), byte)])
  : buffer;
const encodedJson = pad(Buffer.from(JSON.stringify(json), 'utf8'), 0x20);
const encodedBinary = pad(compactBinary);
const totalLength = 12 + 8 + encodedJson.length + 8 + encodedBinary.length;
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(totalLength, 8);
const jsonHeader = Buffer.alloc(8);
jsonHeader.writeUInt32LE(encodedJson.length, 0);
jsonHeader.writeUInt32LE(0x4e4f534a, 4);
const binaryHeader = Buffer.alloc(8);
binaryHeader.writeUInt32LE(encodedBinary.length, 0);
binaryHeader.writeUInt32LE(0x004e4942, 4);

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, Buffer.concat([header, jsonHeader, encodedJson, binaryHeader, encodedBinary]));
console.log(JSON.stringify({
  output: outputPath,
  clips: json.animations.map((animation) => animation.name),
  sourceBytes: source.length,
  outputBytes: totalLength,
  savedPercent: Number(((1 - totalLength / source.length) * 100).toFixed(1)),
}));
