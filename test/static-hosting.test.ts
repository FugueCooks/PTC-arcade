import assert from 'node:assert/strict';
import test from 'node:test';
import { publicRuntimeConfig, runtimeConfigScript } from '../server/src/http/static-hosting.js';

void test('runtime config preserves local game URLs when no CDN is configured', () => {
  assert.deepEqual(publicRuntimeConfig({}), { gameAssetBaseUrl: '', biosAssetUrl: '', realtimeUrl: '' });
});

void test('runtime config normalizes a CDN base URL', () => {
  assert.deepEqual(publicRuntimeConfig({ GAME_ASSET_BASE_URL: ' https://cdn.example.com/roms/// ' }), {
    gameAssetBaseUrl: 'https://cdn.example.com/roms',
    biosAssetUrl: '',
    realtimeUrl: ''
  });
});

void test('runtime config supports an independently hosted BIOS', () => {
  assert.deepEqual(publicRuntimeConfig({ BIOS_ASSET_URL: ' https://cdn.example.com/system/SCPH1001.BIN ' }), {
    gameAssetBaseUrl: '',
    biosAssetUrl: 'https://cdn.example.com/system/SCPH1001.BIN',
    realtimeUrl: ''
  });
});

void test('runtime config exposes an optional Cloudflare realtime endpoint', () => {
  assert.equal(publicRuntimeConfig({ REALTIME_URL: ' https://arcade.example.workers.dev/realtime ' }).realtimeUrl,
    'https://arcade.example.workers.dev/realtime');
});

void test('runtime config serialization cannot inject a script tag', () => {
  const script = runtimeConfigScript({ gameAssetBaseUrl: 'https://cdn.example.com/<script>', biosAssetUrl: '', realtimeUrl: '' });
  assert.doesNotMatch(script, /<script>/);
  assert.match(script, /\\u003cscript>/);
});
