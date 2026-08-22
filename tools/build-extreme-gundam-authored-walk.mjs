import fs from 'node:fs';
import path from 'node:path';

const [sourcePath, outputPath] = process.argv.slice(2);
if (!sourcePath || !outputPath) throw new Error('Expected source and output GLB paths.');

const source = fs.readFileSync(sourcePath);
const jsonLength = source.readUInt32LE(12);
const json = JSON.parse(source.subarray(20, 20 + jsonLength).toString('utf8').trim());
const binaryStart = 20 + jsonLength + 8;
let binary = Buffer.from(source.subarray(binaryStart));

const componentCounts = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const legNodes = [80, 81, 82, 89, 90, 91];
const armNodes = [20, 42];
const animatedNodes = new Set([...legNodes, ...armNodes]);
const bodyMotionNodes = new Set([8, 79]);

const padBinary = (buffer) => buffer.length % 4
  ? Buffer.concat([buffer, Buffer.alloc(4 - buffer.length % 4)])
  : buffer;
const padJson = (buffer) => buffer.length % 4
  ? Buffer.concat([buffer, Buffer.alloc(4 - buffer.length % 4, 0x20)])
  : buffer;

function readAccessor(accessorIndex) {
  const accessor = json.accessors[accessorIndex];
  if (accessor.componentType !== 5126) throw new Error('Expected Float32 animation data.');
  const view = json.bufferViews[accessor.bufferView];
  const count = componentCounts[accessor.type];
  const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const stride = view.byteStride ?? count * 4;
  const values = [];
  for (let index = 0; index < accessor.count; index += 1) {
    for (let component = 0; component < count; component += 1) {
      values.push(binary.readFloatLE(offset + index * stride + component * 4));
    }
  }
  return { accessor, values, componentCount: count };
}

function appendFloats(values, type) {
  binary = padBinary(binary);
  const byteOffset = binary.length;
  const payload = Buffer.from(new Float32Array(values).buffer);
  binary = Buffer.concat([binary, payload]);
  const bufferView = json.bufferViews.length;
  json.bufferViews.push({ buffer: 0, byteOffset, byteLength: payload.length });
  const accessor = json.accessors.length;
  json.accessors.push({
    bufferView,
    componentType: 5126,
    count: values.length / componentCounts[type],
    type,
  });
  return accessor;
}

const normalize = ([x, y, z, w]) => {
  const length = Math.hypot(x, y, z, w);
  return [x / length, y / length, z / length, w / length];
};
const multiply = ([ax, ay, az, aw], [bx, by, bz, bw]) => normalize([
  aw * bx + ax * bw + ay * bz - az * by,
  aw * by - ax * bz + ay * bw + az * bx,
  aw * bz + ax * by - ay * bx + az * bw,
  aw * bw - ax * bx - ay * by - az * bz,
]);

function localXAxisTurn(angle) {
  const half = angle * 0.5;
  return [Math.sin(half), 0, 0, Math.cos(half)];
}

function findChannel(animation, node, property = 'rotation') {
  const channel = animation.channels.find((candidate) => (
    candidate.target.node === node && candidate.target.path === property
  ));
  if (!channel) throw new Error(`Missing ${property} channel for node ${node} in ${animation.name}.`);
  return channel;
}

const idle = json.animations.find((animation) => animation.name === 'Idle');
const sourceWalk = json.animations.find((animation) => animation.name === 'Walk');
if (!idle || !sourceWalk) throw new Error('The source model must contain Idle and Walk clips.');

function restValue(channel, fallbackAccessor) {
  const node = json.nodes[channel.target.node] ?? {};
  if (channel.target.path === 'rotation') return node.rotation ?? [0, 0, 0, 1];
  if (channel.target.path === 'translation') return node.translation ?? [0, 0, 0];
  if (channel.target.path === 'scale') return node.scale ?? [1, 1, 1];
  // The model has no animated morph weights in its standing clip. Keep this
  // fallback only to make the tool safe for a future compatible avatar.
  return readAccessor(idle.samplers[channel.sampler].output).values.slice(0, fallbackAccessor.componentCount);
}

const timingChannel = findChannel(sourceWalk, legNodes[0]);
const sourceTiming = readAccessor(sourceWalk.samplers[timingChannel.sampler].input).values;
const duration = sourceTiming.at(-1);
// The source clip has only nine linear keyframes. That produces obvious
// direction changes even though its foot path is sound. Resample the authored
// X-axis rotations into a denser, periodic cubic curve: it preserves the
// model's intended full heel-strike-to-toe-off stride while smoothing every
// hip, knee and ankle reversal.
const sampleCount = 49;
const timing = Array.from({ length: sampleCount }, (_, index) => duration * index / (sampleCount - 1));
const staticTimes = appendFloats([0, duration], 'SCALAR');
const dynamicTimes = appendFloats(timing, 'SCALAR');

const unwrapAngles = (quaternions) => {
  const angles = quaternions.map(([x, , , w]) => Math.atan2(x, w) * 2);
  for (let index = 1; index < angles.length; index += 1) {
    while (angles[index] - angles[index - 1] > Math.PI) angles[index] -= Math.PI * 2;
    while (angles[index] - angles[index - 1] < -Math.PI) angles[index] += Math.PI * 2;
  }
  return angles;
};

const catmullRom = (p0, p1, p2, p3, t) => {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
};

function smoothAuthoredRotation(sourceOutput, base, strength) {
  const keyframes = Array.from(
    { length: sourceOutput.values.length / 4 },
    (_, index) => sourceOutput.values.slice(index * 4, index * 4 + 4),
  );
  const sourceAngles = unwrapAngles(keyframes);
  // The exported Walk rotations are absolute joint values. Applying them
  // directly replaces the Gundam's carefully aligned rest ankle/leg pose.
  // Convert them into offsets from frame zero and apply those offsets over the
  // neutral rig transform instead. This preserves the planted standing shape
  // while retaining the authored front-to-back stride timing.
  const reference = sourceAngles[0];
  const offsets = sourceAngles.map((angle) => angle - reference);
  const uniqueCount = sourceAngles.length - 1;
  const values = [];
  for (let index = 0; index < timing.length; index += 1) {
    if (index === timing.length - 1) {
      values.push(0, 0, 0, 1);
      continue;
    }
    const phase = timing[index] / duration;
    const scaled = phase * uniqueCount;
    const segment = Math.floor(scaled);
    const fraction = scaled - segment;
    const at = (offset) => offsets[(segment + offset + uniqueCount) % uniqueCount];
    const angle = catmullRom(at(-1), at(0), at(1), at(2), fraction) * strength;
    values.push(...multiply(base, localXAxisTurn(angle)));
  }
  // The source walk is a true loop; force the last sample to be exact so a
  // repeated action never pops at the loop boundary.
  values.splice(values.length - 4, 4, ...values.slice(0, 4));
  return values;
}

const samplers = [];
const channels = [];

// The source clip called "Idle" is a wide combat/action stance. The model's
// unanimated rest transform is the genuine upright neutral standing pose. Put
// it into an explicit clip so state transitions always have a stable, human
// baseline instead of snapping to the dramatic action pose.
const neutralSamplers = [];
const neutralChannels = [];
for (const channel of idle.channels) {
  const output = readAccessor(idle.samplers[channel.sampler].output);
  const pose = restValue(channel, output);
  const sampler = neutralSamplers.length;
  neutralSamplers.push({
    input: staticTimes,
    output: appendFloats([...pose, ...pose], output.accessor.type),
    interpolation: 'LINEAR',
  });
  neutralChannels.push({ sampler, target: { ...channel.target } });
}
json.animations.push({ name: 'GundamNeutralIdle', samplers: neutralSamplers, channels: neutralChannels });

// Hold the upright neutral pose for torso, wings, and accessories. The
// authored walk only replaces the lower-body channels plus a restrained arm swing.
for (const channel of idle.channels) {
  if (channel.target.path === 'rotation' && animatedNodes.has(channel.target.node)) continue;
  if (channel.target.path === 'translation' && bodyMotionNodes.has(channel.target.node)) continue;
  const output = readAccessor(idle.samplers[channel.sampler].output);
  const pose = restValue(channel, output);
  const sampler = samplers.length;
  samplers.push({
    input: staticTimes,
    output: appendFloats([...pose, ...pose], output.accessor.type),
    interpolation: 'LINEAR',
  });
  channels.push({ sampler, target: { ...channel.target } });
}

// A human walk carries the pelvis between the supporting feet and rises
// fractionally through mid-stance. These are deliberately small offsets on
// top of the model's original idle placement; they provide weight transfer
// without moving the multiplayer collision position or breaking foot contact.
const rootBase = json.nodes[8].translation ?? [0, 0, 0];
const pelvisBase = json.nodes[79].translation ?? [0, 0, 0];
for (const node of bodyMotionNodes) {
  const values = timing.flatMap((time) => {
    const phase = time / duration;
    if (node === 8) {
      const rise = 0.009 * (1 - Math.cos(Math.PI * 4 * phase)) * 0.5;
      return [rootBase[0], rootBase[1] + rise, rootBase[2]];
    }
    const sway = 0.006 * Math.sin(Math.PI * 2 * phase);
    return [pelvisBase[0] + sway, pelvisBase[1], pelvisBase[2]];
  });
  const sampler = samplers.length;
  samplers.push({ input: dynamicTimes, output: appendFloats(values, 'VEC3'), interpolation: 'LINEAR' });
  channels.push({ sampler, target: { node, path: 'translation' } });
}

// Preserve the model author's complete hip, knee, and ankle timing as the
// grounded locomotion base. The idle pose is intentionally not used for these
// six joints: its airborne action stance splays the legs and makes a walk read
// like a strut. Crossfading still keeps transitions smooth at runtime.
for (const node of legNodes) {
  const sourceChannel = findChannel(sourceWalk, node);
  const sourceOutput = readAccessor(sourceWalk.samplers[sourceChannel.sampler].output);
  const base = json.nodes[node].rotation ?? [0, 0, 0, 1];
  // The source clip was authored as a dramatic mecha stride. Scale the hips
  // down most, retain extra knee flex during swing, and use the ankle only to
  // settle the planted foot. This gives each foot a complete cycle without a
  // split/lunge silhouette.
  const strength = [80, 89].includes(node) ? 0.38 : [81, 90].includes(node) ? 0.55 : 0.45;
  const values = smoothAuthoredRotation(sourceOutput, base, strength);
  const sampler = samplers.length;
  samplers.push({ input: dynamicTimes, output: appendFloats(values, 'VEC4'), interpolation: 'LINEAR' });
  channels.push({ sampler, target: { node, path: 'rotation' } });
}

// Arm swing is intentionally small and driven in the same local plane as the
// legs. Each arm moves opposite the leg on its side, without moving the torso.
for (const node of armNodes) {
  const base = json.nodes[node].rotation ?? [0, 0, 0, 1];
  const rightArm = node === 42;
  const values = timing.flatMap((time) => {
    const phase = time / duration;
    // A modest 2.4° shoulder arc reads as a humanoid counter-swing without
    // pulling the weaponless model's arms out into a wing-like flap.
    const angle = (rightArm ? -1 : 1) * 0.025 * Math.sin(Math.PI * 2 * phase);
    return multiply(base, localXAxisTurn(angle));
  });
  const sampler = samplers.length;
  samplers.push({ input: dynamicTimes, output: appendFloats(values, 'VEC4'), interpolation: 'LINEAR' });
  channels.push({ sampler, target: { node, path: 'rotation' } });
}

json.animations.push({ name: 'GundamBalancedWalk', samplers, channels });
json.buffers[0].byteLength = binary.length;

const encodedJson = padJson(Buffer.from(JSON.stringify(json), 'utf8'));
const encodedBinary = padBinary(binary);
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
console.log(`Built ${outputPath} from the model's authored lower-body walk cycle.`);
