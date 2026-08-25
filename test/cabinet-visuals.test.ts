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

  // Cache keys are meant to change whenever assets change, so pinning literal
  // values here fails on every legitimate bump. Assert the invariant that
  // actually matters instead: the import chain moves together. Bumping only a
  // nested key leaves the browser running a cached parent that still imports
  // the previous URL, which silently ships stale code.
  const versionOf = (source: string, asset: string): string => {
    const marker = `${asset}?v=`;
    const at = source.indexOf(marker);
    assert.ok(at !== -1, `${asset} is not version pinned`);
    const key = /^[A-Za-z0-9-]+/.exec(source.slice(at + marker.length));
    assert.ok(key, `${asset} has an empty version key`);
    return key ? key[0] : "";
  };
  assert.equal(versionOf(index, "app-bootstrap.js"), versionOf(bootstrap, "arcade.js"),
    "index.html and app-bootstrap.js must agree on one cache key");
  assert.equal(versionOf(bootstrap, "multiplayer-client.js"), versionOf(multiplayer, "world-manager.js"),
    "the multiplayer import chain must agree on one cache key");
  assert.equal(versionOf(multiplayer, "world-manager.js"), versionOf(world, "environment-manager.js"),
    "the world import chain must agree on one cache key");
  assert.doesNotMatch(environment, /createWindows/);
});

void test('floor materials stay visible from every camera direction', async () => {
  const arcade = await readFile(path.resolve(process.cwd(), 'arcade.js'), 'utf8');

  assert.match(arcade, /emissive:0x10091c,emissiveIntensity:\.42,roughness:\.66,metalness:\.14/);
  assert.match(arcade, /emissive:0x0b1324,emissiveIntensity:\.38,roughness:\.7,metalness:\.12/);
});

void test('the main room is a collision-safe social lounge beside square console rooms', async () => {
  const arcade = await readFile(path.resolve(process.cwd(), 'arcade.js'), 'utf8');
  const edge = await readFile(path.resolve(process.cwd(), 'cloudflare/src/index.ts'), 'utf8');

  assert.match(arcade, /addRoomSign\('PLAYSTATION ROOM'/);
  assert.match(arcade, /addRoomSign\('NINTENDO 64 ROOM'/);
  assert.match(arcade, /playstationWall\.position\.set\(-22\.5,2\.5,-\.16\)/);
  assert.match(arcade, /n64WallGraphic\.position\.set\(22\.5,2\.5,-\.16\)/);
  assert.match(arcade, /new THREE\.PlaneGeometry\(17,16\.8\)/);
  assert.match(arcade, /PS2_ROOM_CENTER_Z=-25\.2/);
  assert.match(arcade, /PS2_ROOM_BACK_Z=-33\.6/);
  assert.match(arcade, /const socialCouch=new THREE\.Group/);
  assert.match(arcade, /function couchSectionShape/);
  assert.match(arcade, /new THREE\.ExtrudeGeometry\(couchSectionShape/);
  assert.match(arcade, /SOCIAL_COUCH_OUTER_RADIUS=4\.65/);
  assert.match(arcade, /SOCIAL_COUCH_GAP_HALF_ANGLE=\.34/);
  assert.match(arcade, /SOCIAL_DISPLAY_RADIUS=2\.07/);
  assert.match(arcade, /new THREE\.PlaneGeometry\(17,34\)/);
  assert.match(arcade, /new THREE\.PlaneGeometry\(24,24\)/);
  assert.match(arcade, /const n64CabinetLayout=/);
  assert.match(arcade, /const gamecubeCabinetLayout=/);
  assert.match(arcade, /resolveSocialLayoutCollisions\(previousX,previousZ\)/);
  assert.match(edge, /violatesSocialLayout\(player\.p\[0\], player\.p\[2\]/);
  assert.match(edge, /SOCIAL_COUCH_GAP_HALF_ANGLE = 0\.34/);
});
