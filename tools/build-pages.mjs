import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const output = path.join(root, '.pages-dist');
const maxPagesFileBytes = 24 * 1024 * 1024;
const rootFiles = [
  'index.html', 'player.html', 'style.css', 'app-bootstrap.js', 'arcade.js',
  'avatar-selection.js', 'multiplayer-client.js'
];
const sourceDirectories = ['avatars', 'cabinets', 'emulators', 'games', 'rooms', 'social', 'world', 'realtime', 'wallet'];
const requiredPrizeModels = new Set([
  'enterprise.optimized.glb',
  'furthermore.optimized.glb',
  'kurack.optimized.glb',
  'pepe-gangster-animated.optimized.glb',
  'pepe-the-frog.optimized.glb',
  'pudgy-penguin.optimized.glb'
]);

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

for (const file of rootFiles) await copyFile(file);
for (const directory of sourceDirectories) await copyTree(directory);
await copyTree('assets', (relative, info) => {
  const normalized = relative.replaceAll('\\', '/');
  // Import/source drops may contain full disc images and unoptimized model
  // iterations. Runtime code never references this directory; playable images
  // are delivered through the configured asset CDN instead.
  if (normalized.startsWith('assets/incoming/')) return false;
  if (normalized.startsWith('assets/games/') && normalized !== 'assets/games/registry.json') return false;
  if (normalized.startsWith('assets/bios/')) return false;
  // The arcade loads WebP art. The PNG originals are kept in the repo as the
  // re-encode source and would otherwise add about 6 MB to the bundle.
  if (normalized.startsWith('assets/art/') && normalized.endsWith('.png')) return false;
  if (normalized.startsWith('assets/models/') && info.isFile()) {
    // Cabinet controller models are needed too; the allow-list below only
    // covers the prize display.
    if (normalized.startsWith('assets/models/controllers/')) return true;
    return requiredPrizeModels.has(path.basename(normalized));
  }
  if (normalized.startsWith('assets/avatars/models/') && info.isFile()) {
    return isApprovedAvatarModel(normalized);
  }
  return true;
});

const runtimeConfig = {
  gameAssetBaseUrl: process.env.GAME_ASSET_BASE_URL || 'https://assets.ptcarcade.fun/arcade/games',
  biosAssetUrl: process.env.BIOS_ASSET_URL || 'https://assets.ptcarcade.fun/arcade/bios/SCPH1001.BIN',
  gameCubeDspAssetUrl: process.env.GAMECUBE_DSP_ASSET_URL || 'https://assets.ptcarcade.fun/arcade/bios/dsp_rom.bin',
  realtimeUrl: process.env.REALTIME_URL || 'https://retro-arcade-realtime.roms-retro-arcade.workers.dev',
  matchmakingUrl: process.env.MATCHMAKING_URL || '',
  solanaNetwork: process.env.SOLANA_NETWORK || 'mainnet-beta'
};
await writeFile(path.join(output, 'runtime-config.js'), `window.ARCADE_RUNTIME = Object.freeze(${JSON.stringify(runtimeConfig)});\n`);
await writeFile(path.join(output, '_headers'), headersFile());
// Authentication cookies are intentionally same-origin and HttpOnly. Keep the
// former Pages URL as a fast redirect to the canonical custom domain instead of
// creating a split-origin auth path.
await writeFile(path.join(output, '_redirects'), '/* https://ptcarcade.fun/:splat 302\n');

const summary = await summarize(output);
console.log(`Cloudflare Pages bundle: ${summary.files} files, ${(summary.bytes / 1024 / 1024).toFixed(1)} MB`);

async function isApprovedAvatarModel(relative) {
  const registry = JSON.parse(await readFile(path.join(root, 'assets/avatars/registry.json'), 'utf8'));
  const approved = new Set();
  for (const avatar of registry.avatars ?? []) {
    for (const value of [avatar.modelUrl, avatar.motionModelUrl]) {
      if (typeof value === 'string') approved.add(value.split('?')[0]);
    }
  }
  return approved.has(relative.replaceAll('\\', '/'));
}

async function copyFile(relative) {
  const source = path.join(root, relative);
  const destination = path.join(output, relative);
  const info = await stat(source);
  if (info.size > maxPagesFileBytes) throw new Error(`${relative} exceeds Cloudflare Pages' safe file limit.`);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination);
}

async function copyTree(relative, include = () => true) {
  const source = path.join(root, relative);
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (!await include(child, entry)) continue;
    if (entry.isDirectory()) await copyTree(child, include);
    else if (entry.isFile()) await copyFile(child);
  }
}

async function summarize(directory) {
  let files = 0;
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await summarize(target);
      files += nested.files;
      bytes += nested.bytes;
    } else {
      files += 1;
      bytes += (await stat(target)).size;
    }
  }
  return { files, bytes };
}

function headersFile() {
  return `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: credentialless

/index.html
  Cache-Control: no-store

/
  Cache-Control: no-store

/runtime-config.js
  Cache-Control: no-store

/*.js
  Cache-Control: public, max-age=300, must-revalidate

/assets/*
  Cache-Control: public, max-age=86400, stale-while-revalidate=604800

/emulators/*
  Cache-Control: public, max-age=86400, stale-while-revalidate=604800

# The wasm cores above are content and keep the long cache. The frames and
# adapters beside them are application code: a day of cache plus a week of
# stale-while-revalidate is how a shipped fix sits unreachable while the page
# looks current. These match the same short revalidation the root modules get,
# which is what the ?v= tokens in the import graph were compensating for.
/emulators/*.js
  Cache-Control: public, max-age=300, must-revalidate

/emulators/*.html
  Cache-Control: public, max-age=300, must-revalidate

/emulators/*.css
  Cache-Control: public, max-age=300, must-revalidate
`;
}
