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

  // The gallery is built from a row table now, so the two custom cabinets carry
  // their flags there. The flags are what matters: they pick the controller.
  assert.match(arcade, /\['gex-enter-the-gecko',[^\n]+,false,true\]/);
  assert.match(arcade, /\['crash-bandicoot',[^\n]+,true,false\]/);
  assert.match(arcade, /makeCabinet\(id,label,playstationRowX\[index\],[^\n]+,'psx'\)/);
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

void test('the main room is an open hall beside square console rooms', async () => {
  const arcade = await readFile(path.resolve(process.cwd(), 'arcade.js'), 'utf8');
  const edge = await readFile(path.resolve(process.cwd(), 'cloudflare/src/index.ts'), 'utf8');

  // Room signage was removed on purpose: the wall logos identify each room,
  // so asserting the old text plates would pin behaviour that is now gone.
  assert.match(arcade, /playstationWall\.position\.set\(-22\.5,2\.5,-\.16\)/);
  assert.match(arcade, /n64WallGraphic\.position\.set\(22\.5,2\.5,-\.16\)/);
  assert.match(arcade, /new THREE\.PlaneGeometry\(17,16\.8\)/);
  assert.match(arcade, /PS2_ROOM_CENTER_Z=-25\.2/);
  assert.match(arcade, /PS2_ROOM_BACK_Z=-33\.6/);
  // The middle of the hall is open floor. The couch ring and the round glass
  // case that stood at the origin are gone, and nothing may quietly restore an
  // obstacle there: the floorplan puts the chandelier over walkable ground.
  assert.doesNotMatch(arcade, /const socialCouch=/);
  assert.doesNotMatch(arcade, /couchSectionShape/);
  assert.doesNotMatch(arcade, /SOCIAL_COUCH_/);
  assert.doesNotMatch(arcade, /SOCIAL_DISPLAY_RADIUS/);
  assert.doesNotMatch(edge, /SOCIAL_COUCH_/);
  // Trench Pepe moved out of that case and onto the prize counter.
  assert.match(arcade, /gangsterPepeMount\.position\.set\(0,1\.265,0\);prizeDisplay\.add\(gangsterPepeMount\)/);
  assert.match(arcade, /new THREE\.PlaneGeometry\(17,34\)/);
  assert.match(arcade, /new THREE\.PlaneGeometry\(24,24\)/);
  assert.match(arcade, /const n64CabinetLayout=/);
  assert.match(arcade, /const gamecubeCabinetLayout=/);
  assert.match(arcade, /resolveSocialLayoutCollisions\(previousX,previousZ\)/);
  assert.match(edge, /violatesSocialLayout\(player\.p\[0\], player\.p\[2\]/);
});

void test('the MegaMan Room gives each mural its own full-length solid wall', async () => {
  const arcade = await readFile(path.resolve(process.cwd(), 'arcade.js'), 'utf8');

  // Stretched to the walls, not centred on them: the long walls are 21.3 m and
  // the side wall 16.5 m, and a mural at the artwork's own aspect left bare wall
  // at both ends of every one.
  assert.match(arcade, /const MEGAMAN_MURAL_SPAN=21\.3,MEGAMAN_SIDE_MURAL_SPAN=16\.5,MEGAMAN_MURAL_HEIGHT=4\.8/);

  // First mural: full front wall, facing back into the room.
  assert.match(arcade, /megaman-room-mural\.webp/);
  assert.match(arcade, /megaManMural\.position\.set\(MEGAMAN_ROOM_CENTER_X,2\.5,16\.54\)/);
  assert.match(arcade, /megaManMural\.rotation\.y=Math\.PI/);

  // Second mural: full left wall, facing into the room.
  assert.match(arcade, /megaman-room-mural-2\.webp/);
  assert.match(arcade, /megaManMuralTwo\.position\.set\(-35\.28,2\.5,MEGAMAN_ROOM_CENTER_Z\)/);
  assert.match(arcade, /megaManMuralTwo\.rotation\.y=Math\.PI\/2/);

  // Third mural: full rear wall, which needs no rotation to face inward.
  assert.match(arcade, /megaman-room-mural-3\.webp/);

  // The hall mural is split by the doorway: Mega Man on the near side of the
  // door, the blue stretched across the span beyond it.
  assert.match(arcade, /megaman-hall-figure\.webp/);
  assert.match(arcade, /megaman-hall-glow\.webp/);
  assert.match(arcade, /MEGAMAN_HALL_FIGURE_CENTER_Z=4\.1/);
  assert.match(arcade, /MEGAMAN_HALL_GLOW_CENTER_Z=13\.25/);
  assert.match(arcade, /mural\.rotation\.y=Math\.PI\/2/);
  assert.match(arcade, /megaManMuralThree\.position\.set\(MEGAMAN_ROOM_CENTER_X,2\.5,\.32\)/);
  assert.equal((arcade.match(/new THREE\.PlaneGeometry\(MEGAMAN_MURAL_SPAN,MEGAMAN_MURAL_HEIGHT\)/g) ?? []).length, 2);
  assert.equal((arcade.match(/new THREE\.PlaneGeometry\(MEGAMAN_SIDE_MURAL_SPAN,MEGAMAN_MURAL_HEIGHT\)/g) ?? []).length, 1);
  assert.equal((arcade.match(/side:THREE\.DoubleSide/g) ?? []).length >= 3, true);
});
