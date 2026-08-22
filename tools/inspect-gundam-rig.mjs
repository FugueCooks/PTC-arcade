import fs from 'node:fs';

const [sourcePath, requestedAnimation] = process.argv.slice(2);
const source = fs.readFileSync(sourcePath);
const jsonLength = source.readUInt32LE(12);
const document = JSON.parse(source.subarray(20, 20 + jsonLength).toString('utf8').trim());
const binaryStart = 20 + jsonLength + 8;
const binary = source.subarray(binaryStart);

if (requestedAnimation === 'list') {
  console.log(JSON.stringify((document.animations ?? []).map((animation) => ({
    name: animation.name,
    channels: animation.channels.length,
  })), null, 2));
  process.exit(0);
}

function accessorValues(accessorIndex) {
  const accessor = document.accessors[accessorIndex];
  const view = document.bufferViews[accessor.bufferView];
  const componentCount = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[accessor.type];
  const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const stride = view.byteStride ?? componentCount * 4;
  return Array.from({ length: accessor.count }, (_, index) => Array.from(
    { length: componentCount },
    (_, component) => Number(binary.readFloatLE(offset + index * stride + component * 4).toFixed(4)),
  ));
}

for (const animation of document.animations ?? []) {
  if (requestedAnimation && animation.name !== requestedAnimation) continue;
  console.log(`ANIMATION ${animation.name}`);
  for (const channel of animation.channels) {
    const node = document.nodes[channel.target.node];
    const motionNodes = [8, 9, 10, 79, 80, 81, 82, 89, 90, 91];
    if (['Walk', 'Idle'].includes(requestedAnimation) && !motionNodes.includes(channel.target.node)) continue;
    const sampler = animation.samplers[channel.sampler];
    console.log(JSON.stringify({
      node: channel.target.node,
      name: node.name ?? '',
      path: channel.target.path,
      translation: node.translation ?? [0, 0, 0],
      rotation: node.rotation ?? [0, 0, 0, 1],
      children: node.children ?? [],
      samples: ['Walk', 'Idle'].includes(requestedAnimation) ? accessorValues(sampler.output) : undefined,
    }));
  }
}
