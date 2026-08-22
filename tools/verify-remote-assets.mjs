import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const manifest = JSON.parse(await readFile(path.join(root, 'deploy', 'public-assets.manifest.json'), 'utf8'));
const publicBase = (process.env.STORAGE_PUBLIC_BASE_URL || process.env.REMOTE_ASSET_BASE_URL || '').trim().replace(/\/+$/, '');
if (!publicBase) throw new Error('Set STORAGE_PUBLIC_BASE_URL or REMOTE_ASSET_BASE_URL.');
const prefix = (process.env.STORAGE_PREFIX || 'arcade').trim().replace(/^\/+|\/+$/g, '');
let failed = false;

for (const asset of manifest) {
  const directory = asset.kind === 'bios' ? 'bios' : 'games';
  const url = [publicBase, prefix, directory, encodeURIComponent(asset.file)].filter(Boolean).join('/');
  try {
    const head = await fetch(url, { method: 'HEAD' });
    const size = Number(head.headers.get('content-length'));
    const range = await fetch(url, { headers: { Range: 'bytes=0-0' } });
    const valid = head.ok && size === asset.bytes && range.status === 206
      && range.headers.get('content-range') === `bytes 0-0/${asset.bytes}`;
    console.log(`${valid ? 'OK' : 'FAIL'} ${asset.file} HEAD=${head.status} bytes=${size} RANGE=${range.status}`);
    failed ||= !valid;
  } catch (error) {
    failed = true;
    console.error(`FAIL ${asset.file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failed) process.exitCode = 1;
