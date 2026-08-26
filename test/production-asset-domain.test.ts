import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

void test('production deployment defaults use the cache-capable R2 custom domain', async () => {
  const pages = await readFile(path.resolve(process.cwd(), 'tools/build-pages.mjs'), 'utf8');
  const render = await readFile(path.resolve(process.cwd(), 'render.yaml'), 'utf8');
  const fly = await readFile(path.resolve(process.cwd(), 'fly.toml'), 'utf8');

  assert.match(pages, /https:\/\/assets\.ptcarcade\.fun\/arcade\/games/);
  assert.doesNotMatch(pages, /r2\.dev/);
  assert.match(render, /value: https:\/\/assets\.ptcarcade\.fun\/arcade\/games/);
  assert.doesNotMatch(render, /r2\.dev/);
  assert.match(fly, /GAME_ASSET_BASE_URL = "https:\/\/assets\.ptcarcade\.fun\/arcade\/games"/);
  assert.doesNotMatch(fly, /r2\.dev/);
});
