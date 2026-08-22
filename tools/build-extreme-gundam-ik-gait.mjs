import fs from 'node:fs';
import path from 'node:path';

const [sourcePath, outputPath] = process.argv.slice(2);
if (!sourcePath || !outputPath) throw new Error('Expected source and output GLB paths.');

const source = fs.readFileSync(sourcePath);
const jsonLength = source.readUInt32LE(12);
const json = JSON.parse(source.subarray(20, 20 + jsonLength).toString('utf8').trim());
const binaryStart = 20 + jsonLength + 8;
let binary = Buffer.from(source.subarray(binaryStart));

const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const padBinary = (buffer) => buffer.length % 4 ? Buffer.concat([buffer, Buffer.alloc(4 - buffer.length % 4)]) : buffer;
const padJson = (buffer) => buffer.length % 4 ? Buffer.concat([buffer, Buffer.alloc(4 - buffer.length % 4, 0x20)]) : buffer;

function readAccessor(accessorIndex) {
  const accessor = json.accessors[accessorIndex];
  if (accessor.componentType !== 5126) throw new Error('Unsupported non-Float32 animation accessor.');
  const view = json.bufferViews[accessor.bufferView];
  const count = components[accessor.type];
  const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const stride = view.byteStride ?? count * 4;
  const values = [];
  for (let index = 0; index < accessor.count; index += 1) {
    for (let component = 0; component < count; component += 1) {
      values.push(binary.readFloatLE(offset + index * stride + component * 4));
    }
  }
  return { accessor, values, components: count };
}

function appendFloats(values, type) {
  binary = padBinary(binary);
  const offset = binary.length;
  const payload = Buffer.from(new Float32Array(values).buffer);
  binary = Buffer.concat([binary, payload]);
  const view = json.bufferViews.length;
  json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: payload.length });
  const accessor = json.accessors.length;
  json.accessors.push({ bufferView: view, componentType: 5126, count: values.length / components[type], type });
  return accessor;
}

const normalize = ([x, y, z, w]) => {
  const magnitude = Math.hypot(x, y, z, w);
  return [x / magnitude, y / magnitude, z / magnitude, w / magnitude];
};
const multiply = ([ax, ay, az, aw], [bx, by, bz, bw]) => normalize([
  aw * bx + ax * bw + ay * bz - az * by,
  aw * by - ax * bz + ay * bw + az * bx,
  aw * bz + ax * by - ay * bx + az * bw,
  aw * bw - ax * bx - ay * by - az * bz,
]);
const turnSideways = (base, angle) => {
  const half = angle * 0.5;
  // The leg points down local Y. Rotating around local X moves it through
  // local Z: the model's actual forward/backward plane.
  return multiply(base, [Math.sin(half), 0, 0, Math.cos(half)]);
};
const smoothstep = (value) => value * value * value * (value * (value * 6 - 15) + 10);

const idle = json.animations.find((animation) => animation.name === 'Idle');
if (!idle) throw new Error('The model must include its original Idle animation.');

const cycleDuration = 1.0;
const staticTimes = appendFloats([0, cycleDuration], 'SCALAR');
const sampleCount = 41;
const times = Array.from({ length: sampleCount }, (_, index) => index / (sampleCount - 1) * cycleDuration);
const dynamicTimes = appendFloats(times, 'SCALAR');

// Distances are measured from the rig's own rest chain: hip->knee and
// knee->ankle. The target foot path is expressed in that same hip plane.
const upperLeg = 0.3883723;
const lowerLeg = 0.5035716;
// A compact stride keeps the Gundam's feet underneath its hips rather than
// pushing it into the original model's wide, airborne action silhouette.
// The slightly shorter effective leg length adds a visible but controlled
// knee bend on both the weight-bearing and swinging sides.
const halfStride = 0.105;
const plantedHeight = 0.85;
const swingLift = 0.038;

function footTarget(phase) {
  // The planted foot moves from front heel strike to rear toe-off. During the
  // second half it clears the floor by a small amount and returns to the next
  // heel strike, giving a complete stride instead of a forward kick.
  if (phase < 0.5) {
    const stance = smoothstep(phase / 0.5);
    return { y: plantedHeight, z: halfStride * (1 - 2 * stance), swing: 0 };
  }
  const swing = (phase - 0.5) / 0.5;
  return {
    y: plantedHeight - swingLift * Math.sin(Math.PI * swing),
    z: halfStride * (-1 + 2 * smoothstep(swing)),
    swing,
  };
}

function solveLeg(phase) {
  const target = footTarget(phase % 1);
  const distance = Math.min(upperLeg + lowerLeg - 0.0001, Math.max(Math.abs(upperLeg - lowerLeg) + 0.0001, Math.hypot(target.y, target.z)));
  const kneeMagnitude = Math.acos(Math.max(-1, Math.min(1, (distance * distance - upperLeg * upperLeg - lowerLeg * lowerLeg) / (2 * upperLeg * lowerLeg))));
  // The negative branch puts the knee ahead of the body during the swing.
  const knee = -kneeMagnitude;
  const hip = Math.atan2(target.z, target.y) - Math.atan2(lowerLeg * Math.sin(knee), upperLeg + lowerLeg * Math.cos(knee));
  const toe = target.swing ? -0.035 * Math.sin(Math.PI * target.swing) : 0;
  return { hip, knee, ankle: -(hip + knee) + toe };
}

const phases = Array.from({ length: sampleCount }, (_, index) => index / (sampleCount - 1));
const rightLeg = phases.map((phase) => solveLeg(phase));
const leftLeg = phases.map((phase) => solveLeg((phase + 0.5) % 1));
const dynamic = new Map([
  [80, rightLeg.map((pose) => pose.hip)], [81, rightLeg.map((pose) => pose.knee)], [82, rightLeg.map((pose) => pose.ankle)],
  [89, leftLeg.map((pose) => pose.hip)], [90, leftLeg.map((pose) => pose.knee)], [91, leftLeg.map((pose) => pose.ankle)],
  [42, phases.map((phase) => -0.022 * Math.sin(Math.PI * 2 * phase))],
  [20, phases.map((phase) => 0.022 * Math.sin(Math.PI * 2 * phase))],
]);

const samplers = [];
const channels = [];
for (const channel of idle.channels) {
  if (channel.target.path === 'rotation' && dynamic.has(channel.target.node)) continue;
  const output = readAccessor(idle.samplers[channel.sampler].output);
  const pose = output.values.slice(0, output.components);
  const sampler = samplers.length;
  samplers.push({ input: staticTimes, output: appendFloats([...pose, ...pose], output.accessor.type), interpolation: 'LINEAR' });
  channels.push({ sampler, target: { ...channel.target } });
}

for (const [node, angles] of dynamic) {
  // The locomotion chain uses neutral rig rotations. The idle clip's leg
  // rotations belong to an aerial action stance and caused the wide strut.
  const base = json.nodes[node].rotation ?? [0, 0, 0, 1];
  const samples = angles.flatMap((angle) => turnSideways(base, angle));
  const sampler = samplers.length;
  samplers.push({ input: dynamicTimes, output: appendFloats(samples, 'VEC4'), interpolation: 'LINEAR' });
  channels.push({ sampler, target: { node, path: 'rotation' } });
}

json.animations.push({ name: 'GundamHumanWalk', samplers, channels });
json.buffers[0].byteLength = binary.length;

const encodedJson = padJson(Buffer.from(JSON.stringify(json), 'utf8'));
const encodedBinary = padBinary(binary);
const totalLength = 12 + 8 + encodedJson.length + 8 + encodedBinary.length;
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(totalLength, 8);
const jsonHeader = Buffer.alloc(8);
jsonHeader.writeUInt32LE(encodedJson.length, 0); jsonHeader.writeUInt32LE(0x4e4f534a, 4);
const binaryHeader = Buffer.alloc(8);
binaryHeader.writeUInt32LE(encodedBinary.length, 0); binaryHeader.writeUInt32LE(0x004e4942, 4);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, Buffer.concat([header, jsonHeader, encodedJson, binaryHeader, encodedBinary]));
console.log(`Built ${outputPath} with a foot-targeted two-bone gait.`);
