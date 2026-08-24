import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const manifest = [
  ...JSON.parse(await readFile(path.join(root, 'deploy', 'public-assets.manifest.json'), 'utf8')),
  ...JSON.parse(await readFile(path.join(root, 'deploy', 'remote-ps2-assets.json'), 'utf8')),
  ...JSON.parse(await readFile(path.join(root, 'deploy', 'remote-gamecube-assets.json'), 'utf8'))
];
const publicBase = (process.env.STORAGE_PUBLIC_BASE_URL || process.env.REMOTE_ASSET_BASE_URL || '').trim().replace(/\/+$/, '');
if (!publicBase) throw new Error('Set STORAGE_PUBLIC_BASE_URL or REMOTE_ASSET_BASE_URL.');
const prefix = (process.env.STORAGE_PREFIX || 'arcade').trim().replace(/^\/+|\/+$/g, '');
const corsOrigin = (process.env.ASSET_CORS_ORIGIN || 'https://retro-arcade-om7.pages.dev').trim();
let failed = false;

async function fetchWithRetry(url, options, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetch(url, options);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, attempt * 250));
    }
  }
  throw lastError;
}

for (const asset of manifest) {
  const directory = asset.kind === 'bios' ? 'bios' : 'games';
  const url = [publicBase, prefix, directory, encodeURIComponent(asset.file)].filter(Boolean).join('/');
  try {
    const head = await fetchWithRetry(url, { method: 'HEAD', headers: { Origin: corsOrigin } });
    const size = Number(head.headers.get('content-length'));
    const range = await fetchWithRetry(url, { headers: { Origin: corsOrigin, Range: 'bytes=0-0' } });
    const allowOrigin = range.headers.get('access-control-allow-origin');
    const corsValid = allowOrigin === '*' || allowOrigin === corsOrigin;
    const valid = head.ok && size === asset.bytes && range.status === 206
      && range.headers.get('content-range') === `bytes 0-0/${asset.bytes}` && corsValid;
    console.log(`${valid ? 'OK' : 'FAIL'} ${asset.file} HEAD=${head.status} bytes=${size} RANGE=${range.status} CORS=${allowOrigin || 'missing'}`);
    failed ||= !valid;
  } catch (error) {
    failed = true;
    console.error(`FAIL ${asset.file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failed) process.exitCode = 1;
