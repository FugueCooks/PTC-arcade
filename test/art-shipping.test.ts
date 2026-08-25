import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

// The Docker context and the Pages bundle both drop assets/art/*.png, because
// every art file there has a WebP replacement. That rule is invisible at
// runtime: a PNG added later still loads from the dev server off disk, then
// 404s in production and renders as a black panel. The Mega Man murals shipped
// broken exactly this way. Fail the build instead of the wall.
void test('no art the scene loads is excluded from the deployed build', async () => {
  const root = process.cwd();
  const arcade = await readFile(path.resolve(root, 'arcade.js'), 'utf8');
  const dockerignore = await readFile(path.resolve(root, '.dockerignore'), 'utf8');
  const pagesBuild = await readFile(path.resolve(root, 'tools', 'build-pages.mjs'), 'utf8');

  const excludesPng = dockerignore.split(/\r?\n/).some((line) => line.trim() === 'assets/art/*.png')
    && pagesBuild.includes("normalized.startsWith('assets/art/') && normalized.endsWith('.png')");
  assert.ok(excludesPng, 'the PNG exclusion moved; update this guard to match it');

  const referenced = [...arcade.matchAll(/assets\/art\/[A-Za-z0-9._/-]+\.png/g)].map((m) => m[0]);
  assert.deepEqual(
    referenced,
    [],
    `arcade.js loads PNG art that the build excludes, so it will 404 in production: ${referenced.join(', ')}`
  );
});
