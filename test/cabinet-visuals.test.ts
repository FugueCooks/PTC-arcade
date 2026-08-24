import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

void test('console controllers fit within and rest on the cabinet control deck', async () => {
  const arcade = await readFile(path.resolve(process.cwd(), 'arcade.js'), 'utf8');

  assert.match(arcade, /const CONTROLLER_DECK=\{width:\.58,depth:\.34\}/);
  assert.match(arcade, /controllerDisplayShelfGeometry=roundedSlab\(1,\.07,\.72/);
  assert.match(arcade, /controllerDisplaySupportGeometry=roundedSlab\(\.34,\.22,\.45/);
  assert.match(arcade, /mount\.position\.set\(0,1\.32,1\.02\);mount\.rotation\.x=\.04/);
  assert.match(arcade, /-scaled\.min\.y\+config\.offset\[1\]\+CONTROLLER_DISPLAY_SURFACE_Y/);
});

void test('the custom Crash and Gex cabinets use PlayStation controllers', async () => {
  const arcade = await readFile(path.resolve(process.cwd(), 'arcade.js'), 'utf8');

  assert.match(arcade, /makeCabinet\('gex-enter-the-gecko',[^\n]+false,true,'psx'\)/);
  assert.match(arcade, /makeCabinet\('crash-bandicoot',[^\n]+true,false,'psx'\)/);
});

void test('the N64 wall loads the window-free environment module without a stale cache', async () => {
  const index = await readFile(path.resolve(process.cwd(), 'index.html'), 'utf8');
  const bootstrap = await readFile(path.resolve(process.cwd(), 'app-bootstrap.js'), 'utf8');
  const multiplayer = await readFile(path.resolve(process.cwd(), 'multiplayer-client.js'), 'utf8');
  const world = await readFile(path.resolve(process.cwd(), 'world/world-manager.js'), 'utf8');
  const environment = await readFile(path.resolve(process.cwd(), 'world/environment-manager.js'), 'utf8');

  assert.match(index, /app-bootstrap\.js\?v=controller-display-forward-2/);
  assert.match(bootstrap, /arcade\.js\?v=controller-display-forward-2/);
  assert.match(bootstrap, /multiplayer-client\.js\?v=n64-wall-panels-removed-3/);
  assert.match(multiplayer, /world-manager\.js\?v=n64-wall-panels-removed-3/);
  assert.match(world, /environment-manager\.js\?v=n64-wall-panels-removed-3/);
  assert.doesNotMatch(environment, /createWindows/);
});
