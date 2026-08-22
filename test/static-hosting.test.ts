import assert from 'node:assert/strict';
import test from 'node:test';
import { publicRuntimeConfig, runtimeConfigScript } from '../server/src/http/static-hosting.js';

void test('runtime config preserves local game URLs when no CDN is configured', () => {
  assert.deepEqual(publicRuntimeConfig({}), { gameAssetBaseUrl: '' });
});

void test('runtime config normalizes a CDN base URL', () => {
  assert.deepEqual(publicRuntimeConfig({ GAME_ASSET_BASE_URL: ' https://cdn.example.com/roms/// ' }), {
    gameAssetBaseUrl: 'https://cdn.example.com/roms'
  });
});

void test('runtime config serialization cannot inject a script tag', () => {
  const script = runtimeConfigScript({ gameAssetBaseUrl: 'https://cdn.example.com/<script>' });
  assert.doesNotMatch(script, /<script>/);
  assert.match(script, /\\u003cscript>/);
});
