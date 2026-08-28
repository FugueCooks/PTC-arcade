#!/usr/bin/env node
/**
 * Re-encode the hosted GameCube images with zstd.
 *
 * Every one of them is stored with compression NONE — RVZ strips a disc's junk
 * data whether or not it compresses, which is why the sizes looked plausible
 * while Melee sat at 97.7% of a raw disc. Gecko loads the whole image into
 * WebAssembly memory before it renders a frame, so those bytes are the load
 * time, and halving them halves the wait with no code change at all.
 *
 *   node tools/recompress-gamecube.mjs --dolphin-tool "C:/Program Files/Dolphin/DolphinTool.exe" \
 *     --source C:/Users/you/Downloads [--game pikmin] [--no-verify] [--apply]
 *
 * Sources are matched to hosted images by exact byte size, so a re-release or a
 * romhack of the same title cannot be silently substituted for what is live.
 * Without --apply nothing is written outside the output directory: the registry
 * and the manifest are only updated once the conversions are verified.
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const argument = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : process.argv[at + 1];
};
const flag = (name) => process.argv.includes(name);

const root = process.cwd();
const dolphinTool = argument('--dolphin-tool', process.env.DOLPHIN_TOOL);
const sourceDirectory = argument('--source', path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', 'Downloads'));
const outputDirectory = argument('--out', path.join(root, 'assets', 'games'));
const only = argument('--game', null);
const verify = !flag('--no-verify');
const apply = flag('--apply');

if (!dolphinTool) {
  console.error('Point --dolphin-tool at DolphinTool.exe (it ships with Dolphin), or set DOLPHIN_TOOL.');
  process.exit(2);
}

const registryPath = path.join(root, 'assets', 'games', 'registry.json');
const registry = JSON.parse(await readFile(registryPath, 'utf8'));
const targets = registry.games.filter((game) => game.system === 'gamecube' && game.enabled && (!only || game.id === only));
if (!targets.length) {
  console.error(only ? `No enabled GameCube game called ${only}.` : 'No enabled GameCube games in the registry.');
  process.exit(2);
}

const sources = await findImages(sourceDirectory);
await mkdir(outputDirectory, { recursive: true });

const results = [];
for (const game of targets) {
  // Byte size is the identity here. Titles arrive under a dozen different
  // names — regional suffixes, revisions, "(60 FPS)" hacks — and converting the
  // wrong one would replace a live game with a different build of it.
  const source = sources.find((candidate) => candidate.bytes === game.sizeBytes);
  if (!source) {
    console.log(`SKIP ${game.id}: no image of exactly ${game.sizeBytes} bytes under ${sourceDirectory}`);
    continue;
  }
  const output = path.join(outputDirectory, game.file);
  console.log(`\n${game.id}: ${path.basename(source.path)} (${megabytes(source.bytes)})`);
  await run(dolphinTool, ['convert', '-f', 'rvz', '-c', 'zstd', '-l', '5', '-b', '131072', '-i', source.path, '-o', output]);

  const converted = (await stat(output)).size;
  if (converted >= source.bytes) {
    console.log(`  no smaller than the original (${megabytes(converted)}); leaving the hosted image alone`);
    continue;
  }
  // A game image that decodes wrong is worse than a large one, and this is the
  // one check that reads every byte back out.
  if (verify) {
    console.log('  verifying…');
    await run(dolphinTool, ['verify', '-i', output]);
  }
  const sha256 = await hashFile(output);
  results.push({ game, output, bytes: converted, was: source.bytes, sha256 });
  console.log(`  ${megabytes(source.bytes)} -> ${megabytes(converted)} (${(converted / source.bytes * 100).toFixed(1)}%), saves ${megabytes(source.bytes - converted)} per player`);
}

if (!results.length) {
  console.log('\nNothing converted.');
  process.exit(0);
}

const savedBytes = results.reduce((total, result) => total + (result.was - result.bytes), 0);
console.log(`\n${results.length} image(s) re-encoded, ${megabytes(savedBytes)} off a full sweep of the room.`);

if (!apply) {
  console.log('Re-run with --apply to update the registry and the manifest, then `npm run storage:upload`.');
  process.exit(0);
}

for (const { game, bytes, sha256 } of results) {
  const entry = registry.games.find((candidate) => candidate.id === game.id);
  entry.sizeBytes = bytes;
  for (const asset of entry.assetRequirements ?? []) {
    if (asset.assetId === entry.file) asset.sizeBytes = bytes;
  }
  // A measured boot order is in 4 MB chunk indexes of the old image. The new
  // one packs differently, so the measurement no longer describes it.
  if (entry.bootChunks) {
    delete entry.bootChunks;
    console.log(`${game.id}: cleared bootChunks, the disc has been repacked and needs measuring again`);
  }
  await updateManifest(game.file, bytes, sha256);
}
await writeJson(registryPath, registry);
console.log('Registry and manifest updated. Upload with `npm run storage:upload`, then confirm with `npm run verify:images`.');

async function findImages(directory) {
  const found = [];
  const walk = async (current, depth) => {
    if (depth > 3) return;
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (/\.(rvz|iso|gcm)$/i.test(entry.name)) {
        try { found.push({ path: full, bytes: (await stat(full)).size }); } catch { /* unreadable */ }
      }
    }
  };
  await walk(directory, 0);
  return found;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(command)} ${args[0]} exited ${code}`))));
  });
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function updateManifest(file, bytes, sha256) {
  const manifestPath = path.join(root, 'deploy', 'public-assets.manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const entry = manifest.find((candidate) => candidate.file === file);
  if (!entry) {
    manifest.push({ kind: 'game', file, bytes, sha256 });
  } else {
    entry.bytes = bytes;
    entry.sha256 = sha256;
  }
  await writeJson(manifestPath, manifest);
}

async function writeJson(file, value) {
  const original = await readFile(file, 'utf8');
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  await writeFile(file, JSON.stringify(value, null, 2).split('\n').join(eol) + eol);
}

function megabytes(bytes) {
  return `${Math.round(bytes / 1048576)} MB`;
}
