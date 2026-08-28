#!/usr/bin/env node
/**
 * What the hosted disc images actually are, read from the CDN without
 * downloading them.
 *
 * Two things decide how long a player waits at a cabinet, and neither is
 * visible from the registry: whether the host serves byte ranges (a game that
 * cannot be ranged has to be downloaded whole before it starts) and how well
 * the image is packed (RVZ and CHD both have a header saying so). Both answers
 * come from the first kilobyte of each file.
 *
 *   node tools/inspect-disc-images.mjs [--base https://host/arcade/games] [--system gamecube]
 *
 * The base URL defaults to GAME_ASSET_BASE_URL, then to the deployed host.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Dolphin's WIA/RVZ compression identifiers, in order.
const RVZ_COMPRESSION = ['NONE', 'PURGE', 'BZIP2', 'LZMA', 'LZMA2', 'ZSTD'];

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

async function main() {
  const argument = (name, fallback) => {
    const at = process.argv.indexOf(name);
    return at === -1 ? fallback : process.argv[at + 1];
  };
  const base = (argument('--base', process.env.GAME_ASSET_BASE_URL || 'https://assets.ptcarcade.fun/arcade/games')).replace(/\/+$/, '');
  const systemFilter = argument('--system', null);
  const registryPath = path.resolve(process.cwd(), 'assets/games/registry.json');
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  const games = registry.games.filter(game => game.enabled && (!systemFilter || game.system === systemFilter));

  let rangeFailures = 0;
  let uncompressed = 0;

  for (const game of games) {
    const url = `${base}/${game.file}`;
    const report = { game: game.id, system: game.system, sizeMB: Math.round(game.sizeBytes / 1048576) };
    try {
      const response = await fetch(url, { headers: { Range: 'bytes=0-1023' } });
      report.status = response.status;
      report.ranges = response.status === 206 && Boolean(response.headers.get('content-range'));
      // Without this exposed, a browser on another origin cannot read the header
      // it needs to trust the range, and streaming silently falls back.
      report.corsExposesRange = (response.headers.get('access-control-expose-headers') ?? '').toLowerCase().includes('content-range');
      const head = Buffer.from(await response.arrayBuffer());
      Object.assign(report, describeImage(game.file, head, game.sizeBytes));
      if (!report.ranges) rangeFailures += 1;
      if (report.packing === 'NONE') uncompressed += 1;
    } catch (error) {
      report.error = String(error?.message ?? error);
      rangeFailures += 1;
    }
    console.log(JSON.stringify(report));
  }

  console.log(`\n${games.length} images · ${rangeFailures} without usable ranges · ${uncompressed} stored uncompressed`);
  if (rangeFailures) console.log('An image without ranges cannot stream: it is downloaded whole before the game starts.');
  if (uncompressed) console.log('An uncompressed image costs every player the full disc. Re-encode with DolphinTool (RVZ) or chdman (CHD).');
  process.exitCode = rangeFailures ? 1 : 0;
}

export function describeImage(file, head, hostedBytes) {
  if (head.length < 96) return { packing: 'unknown', note: 'short read' };
  const extension = file.toLowerCase().split('.').pop();
  if (extension === 'rvz' || extension === 'wia') {
    const magic = head.toString('latin1', 0, 3);
    if (magic !== 'RVZ' && magic !== 'WIA') return { packing: 'unknown', note: 'not an RVZ/WIA header' };
    // Header 1 is 72 bytes; header 2 opens with disc type, compression, level.
    const discBytes = Number(head.readBigUInt64BE(36));
    const compression = head.readUInt32BE(76);
    return {
      packing: RVZ_COMPRESSION[compression] ?? `type-${compression}`,
      level: head.readInt32BE(80),
      discMB: Math.round(discBytes / 1048576),
      ofDisc: `${(hostedBytes / discBytes * 100).toFixed(1)}%`
    };
  }
  if (extension === 'chd') {
    const magic = head.toString('latin1', 0, 8);
    if (magic !== 'MComprHD') return { packing: 'unknown', note: 'not a CHD header' };
    // v5 lists up to four compressors as FourCCs from offset 16.
    const compressors = [0, 1, 2, 3]
      .map(index => head.toString('latin1', 16 + index * 4, 20 + index * 4))
      .filter(tag => tag !== '\0\0\0\0');
    return { packing: compressors.length ? compressors.join('+') : 'NONE', version: head.readUInt32BE(12) };
  }
  return { packing: 'raw', note: `${extension} carries no packing header` };
}
