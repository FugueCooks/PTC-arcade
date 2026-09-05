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

void test('every root client module directory needed at startup ships with Pages', async () => {
  // multiplayer-client.js imports the match panel directly. Omitting this
  // existing directory lets unit tests pass but makes a fresh static deploy
  // stop at its first dynamic import before the arcade can render.
  const pagesBuild = await readFile(path.resolve(process.cwd(), 'tools', 'build-pages.mjs'), 'utf8');
  assert.match(
    pagesBuild,
    /sourceDirectories\s*=\s*\[[^\]]*['"]matches['"][^\]]*\]/,
    'the Pages bundle must include the matches client module directory'
  );
});

// The avatar model directory is an allow-list in .dockerignore, because it also
// holds ~115 MB of iteration files no avatar references. An allow-list fails
// unsafe: add an avatar, forget the entry, and its model 404s in production
// while still loading from disk in development. Same failure the Mega Man
// murals shipped with, so check it the same way.
void test('every avatar model the registry serves is allowed into the image', async () => {
  const root = process.cwd();
  const dockerignore = await readFile(path.resolve(root, '.dockerignore'), 'utf8');
  const registry = JSON.parse(await readFile(path.resolve(root, 'assets/avatars/registry.json'), 'utf8'));

  const excluded = dockerignore.split(/\r?\n/).some((line) => line.trim() === 'assets/avatars/models/*');
  assert.ok(excluded, 'the avatar model exclusion moved; update this guard to match it');

  const allowed = new Set(
    dockerignore.split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('!assets/avatars/models/'))
      .map((line) => line.slice(1))
  );

  const required = new Set<string>();
  for (const avatar of registry.avatars ?? []) {
    for (const value of [avatar.modelUrl, avatar.motionModelUrl]) {
      if (typeof value === 'string') required.add(value.split('?')[0]);
    }
  }

  const missing = [...required].filter((file) => !allowed.has(file));
  assert.deepEqual(
    missing,
    [],
    `these avatar models are excluded from the image and will 404 in production: ${missing.join(', ')}`
  );
});

// .dockerignore decides what reaches the image; .gitignore decides what reaches
// the repository, and the same directory is an allow-list in both for the same
// reason. Passing the check above while failing this one is the worse failure:
// the model sits on the author's disk, loads all through local testing, and is
// simply absent from the clone the image is built from. Vled shipped that way
// and 404'd in production as the default avatar every visitor is handed.
void test('every avatar model the registry serves is committed, not just present locally', async () => {
  const root = process.cwd();
  const gitignore = await readFile(path.resolve(root, '.gitignore'), 'utf8');
  const registry = JSON.parse(await readFile(path.resolve(root, 'assets/avatars/registry.json'), 'utf8'));

  const excluded = gitignore.split(/\r?\n/).some((line) => line.trim() === 'assets/avatars/models/*.glb');
  assert.ok(excluded, 'the avatar model ignore moved; update this guard to match it');

  const kept = new Set(
    gitignore.split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('!assets/avatars/models/'))
      .map((line) => line.slice(1))
  );

  const required = new Set<string>();
  for (const avatar of registry.avatars ?? []) {
    for (const value of [avatar.modelUrl, avatar.motionModelUrl]) {
      if (typeof value === 'string') required.add(value.split('?')[0]);
    }
  }

  const ignored = [...required].filter((file) => !kept.has(file));
  assert.deepEqual(
    ignored,
    [],
    `these avatar models are gitignored and will never reach the image: ${ignored.join(', ')}`
  );
});
