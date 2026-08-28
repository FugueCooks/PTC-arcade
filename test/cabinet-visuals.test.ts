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
  assert.match(arcade, /makeCabinet\(id,label,slot\.x,slot\.z,hue,isCrash,isGex,'psx'\)/);
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
  // The console logos are off the divider walls. Rooms are themed by title now,
  // so a PlayStation mark on a room that holds no PlayStation games named the
  // wrong thing — and the rooms it named are empty besides.
  assert.doesNotMatch(arcade, /playstationWall|n64WallGraphic/);
  assert.doesNotMatch(arcade, /playstation-wall\.webp|nintendo64-wall\.webp/);
  // Every room in the building is one size, and the plan is stated once.
  assert.match(arcade, /const ROOM_SPAN=21\.6,ROOM_DEPTH=16\.8;/);
  assert.match(arcade, /SHELL_HALF_WIDTH=43\.2,HALL_HALF_WIDTH=21\.6,ANNEX_ROOM_CENTER_X=32\.4/);
  // Four rooms down each side, four across the top, the tournament hall across
  // the bottom: the ring the floorplan draws.
  assert.match(arcade, /const SIDE_ROOM_Z=\[-25\.2,-8\.4,8\.4,25\.2\];/);
  assert.match(arcade, /const NORTH_ROOM_X=\[-32\.4,-10\.8,10\.8,32\.4\];/);
  assert.match(arcade, /MEGAMAN_ROOM_WIDTH=ROOM_SPAN,MEGAMAN_ROOM_DEPTH=ROOM_DEPTH/);
  assert.doesNotMatch(arcade, /MEGAMAN_EXTENSION_WIDTH/);
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
  assert.match(arcade, /new THREE\.PlaneGeometry\(ROOM_SPAN,SIDE_COLUMN_DEPTH\)/);
  // The room beyond the hub is the Multiplayer / Tournament room now, and it
  // runs the full width of the building rather than the old 24 m square.
  assert.match(arcade, /TOURNAMENT_ROOM_WIDTH=SHELL_HALF_WIDTH\*2/);
  assert.match(arcade, /new THREE\.PlaneGeometry\(TOURNAMENT_ROOM_WIDTH,TOURNAMENT_ROOM_DEPTH\)/);
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

  // A themed room is three images against its three solid walls: one across
  // the far end, one across the near end, one down the outer side. The fourth
  // wall is the partition its doorway is cut into.
  assert.match(arcade, /function themeRoom\(\{centerX,centerZ,far,near,side\}\)/);
  assert.match(arcade, /far:'megaman-room-mural\.webp/);
  assert.match(arcade, /near:'megaman-room-mural-3\.webp/);
  assert.match(arcade, /side:'megaman-room-mural-2\.webp/);
  // The far wall faces back into the room, the near wall needs no rotation, and
  // the side wall turns to face inward from whichever column it is in.
  assert.match(arcade, /rotation:Math\.PI,/);
  assert.match(arcade, /rotation:0,/);
  assert.match(arcade, /rotation:outward\*-Math\.PI\/2/);

  // The hall mural is split by the doorway: Mega Man on the near side of the
  // door, the blue stretched across the span beyond it.
  assert.match(arcade, /megaman-hall-figure\.webp/);
  assert.match(arcade, /megaman-hall-glow\.webp/);
  assert.match(arcade, /MEGAMAN_HALL_FIGURE_CENTER_Z=4\.1/);
  assert.match(arcade, /MEGAMAN_HALL_GLOW_CENTER_Z=13\.25/);
  assert.match(arcade, /mural\.rotation\.y=Math\.PI\/2/);
  // One geometry, sized per wall from the span the builder was handed.
  assert.match(arcade, /new THREE\.PlaneGeometry\(wall\.span,MEGAMAN_MURAL_HEIGHT\)/);
  assert.equal((arcade.match(/side:THREE\.DoubleSide/g) ?? []).length >= 2, true);
  // A second room is themed the same way, from art supplied for it — the point
  // of pulling the room's numbers out of the code in the first place.
  assert.match(arcade, /metal-gear-room-mural\.webp/);
  // Anchored to the line start, so the builder's own declaration — which opens
  // the same way — is not counted as one of the rooms.
  assert.equal((arcade.match(/^themeRoom\(\{/gm) ?? []).length, 2, 'two themed rooms, one builder');
});
