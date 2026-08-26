import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { publicRuntimeConfig, runtimeConfigScript } from '../server/src/http/static-hosting.js';

void test('runtime config preserves local game URLs when no CDN is configured', () => {
  assert.deepEqual(publicRuntimeConfig({}), { gameAssetBaseUrl: '', biosAssetUrl: '', gameCubeDspAssetUrl: '', realtimeUrl: '', matchmakingUrl: '', solanaNetwork: 'mainnet-beta' });
});

void test('runtime config normalizes a CDN base URL', () => {
  assert.deepEqual(publicRuntimeConfig({ GAME_ASSET_BASE_URL: ' https://cdn.example.com/roms/// ' }), {
    gameAssetBaseUrl: 'https://cdn.example.com/roms',
    biosAssetUrl: '',
    gameCubeDspAssetUrl: '',
    realtimeUrl: '', matchmakingUrl: '', solanaNetwork: 'mainnet-beta'
  });
});

void test('runtime config supports an independently hosted BIOS', () => {
  assert.deepEqual(publicRuntimeConfig({ BIOS_ASSET_URL: ' https://cdn.example.com/system/SCPH1001.BIN ' }), {
    gameAssetBaseUrl: '',
    biosAssetUrl: 'https://cdn.example.com/system/SCPH1001.BIN',
    gameCubeDspAssetUrl: '',
    realtimeUrl: '', matchmakingUrl: '', solanaNetwork: 'mainnet-beta'
  });
});

void test('runtime config exposes an optional Cloudflare realtime endpoint', () => {
  assert.equal(publicRuntimeConfig({ REALTIME_URL: ' https://arcade.example.workers.dev/realtime ' }).realtimeUrl,
    'https://arcade.example.workers.dev/realtime');
});

void test('runtime config supports a hosted GameCube DSP ROM', () => {
  assert.equal(publicRuntimeConfig({ GAMECUBE_DSP_ASSET_URL: ' https://cdn.example.com/system/dsp_rom.bin ' }).gameCubeDspAssetUrl,
    'https://cdn.example.com/system/dsp_rom.bin');
});

void test('runtime config serialization cannot inject a script tag', () => {
  const script = runtimeConfigScript({ gameAssetBaseUrl: 'https://cdn.example.com/<script>', biosAssetUrl: '', gameCubeDspAssetUrl: '', realtimeUrl: '', matchmakingUrl: '', solanaNetwork: 'mainnet-beta' });
  assert.doesNotMatch(script, /<script>/);
  assert.match(script, /\\u003cscript>/);
});

void test('application code revalidates, so a deployed fix is never cached out of reach', async () => {
  // The `?v=` tokens version only what app-bootstrap.js imports directly.
  // emulators/adapters/emulatorjs-adapter.js — the file that decides which core
  // a cabinet launches — is reached through a plain URL, so an hour of max-age
  // meant a shipped fix could sit unreachable behind a browser cache.
  const express = (await import('express')).default;
  const { createServer } = await import('node:http');
  const { installStaticHosting } = await import('../server/src/http/static-hosting.js');

  const app = express();
  installStaticHosting(app, process.cwd());
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    for (const path of [
      '/emulators/adapters/emulatorjs-adapter.js',
      '/emulators/emulator-adapter-registry.js',
      '/games/game-registry.js',
      '/arcade.js',
      '/app-bootstrap.js'
    ]) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get('cache-control'), 'no-cache', `${path} must revalidate`);
      assert.ok(response.headers.get('etag'), `${path} must carry an ETag, or revalidation costs a full download`);
    }

    // index.html is never stored at all, so a new import graph is always seen.
    assert.equal((await fetch(`${base}/`)).headers.get('cache-control'), 'no-store');

    // Content, by contrast, stays cacheable: these are large and rarely change,
    // and re-downloading them on every visit is the cost this avoids.
    const asset = await fetch(`${base}/assets/games/registry.json`);
    assert.match(asset.headers.get('cache-control') ?? '', /max-age=\d+/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
