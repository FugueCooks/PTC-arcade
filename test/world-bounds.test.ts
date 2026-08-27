import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * The world's edges exist in three places, and all three have to agree.
 *
 * The server enforces them, the Cloudflare Worker enforces them again for the
 * realtime path, and arcade.js applies them locally so movement feels immediate.
 * When they disagree the symptom is not a wall: the client lets the player walk
 * somewhere the server refuses, the server corrects them, and every step gets
 * snapped back — which reads as lag, and sends anyone debugging it to look at
 * the network.
 *
 * This session has already lost time to two copies of one value drifting. These
 * are three, and since the Mega Man room was lengthened westward there are two
 * rectangles in each copy rather than one.
 */
const root = process.cwd();

function readNumber(source: string, pattern: RegExp, label: string): number {
  const match = pattern.exec(source);
  assert.ok(match, `could not find ${label}`);
  return Number(match![1]);
}

const server = await readFile(path.join(root, 'server/src/players/player-manager.ts'), 'utf8');
const worker = await readFile(path.join(root, 'cloudflare/src/index.ts'), 'utf8');
const client = await readFile(path.join(root, 'arcade.js'), 'utf8');

function clientRegion(name: string) {
  const match = new RegExp(`const ${name}=\\{minX:(-?[\\d.]+),maxX:(-?[\\d.]+),minZ:(-?[\\d.]+),maxZ:(-?[\\d.]+)\\}`).exec(client);
  assert.ok(match, `arcade.js must declare ${name}`);
  return { minX: Number(match![1]), maxX: Number(match![2]), minZ: Number(match![3]), maxZ: Number(match![4]) };
}

const clientBounds = clientRegion('WORLD_BOUNDS');
const clientAlcove = clientRegion('MEGAMAN_ALCOVE');

void test('the server, the worker and the client agree on where the world ends', () => {
  for (const [name, pattern] of [
    ['minX', /const MIN_WORLD_X = (-?[\d.]+);/],
    ['maxX', /const MAX_WORLD_X = (-?[\d.]+);/],
    ['minZ', /const MIN_WORLD_Z = (-?[\d.]+);/],
    ['maxZ', /const MAX_WORLD_Z = (-?[\d.]+);/]
  ] as Array<[keyof typeof clientBounds, RegExp]>) {
    const onServer = readNumber(server, pattern, `${name} in player-manager`);
    const onWorker = readNumber(worker, pattern, `${name} in the worker`);
    assert.equal(onWorker, onServer, `${name}: the worker disagrees with the server`);
    assert.equal(clientBounds[name], onServer, `${name}: arcade.js disagrees with the server`);
  }
});

void test('all three agree on the Mega Man room’s western extension too', () => {
  // The second rectangle is the newer of the two and the easier to forget: the
  // room reaches past the building's west wall, and only there.
  for (const [name, pattern] of [
    ['minX', /const MEGAMAN_ALCOVE_MIN_X = (-?[\d.]+);/],
    ['maxX', /const MEGAMAN_ALCOVE_MAX_X = (-?[\d.]+);/],
    ['minZ', /const MEGAMAN_ALCOVE_MIN_Z = (-?[\d.]+);/],
    ['maxZ', /const MEGAMAN_ALCOVE_MAX_Z = (-?[\d.]+);/]
  ] as Array<[keyof typeof clientAlcove, RegExp]>) {
    const onServer = readNumber(server, pattern, `alcove ${name} in player-manager`);
    const onWorker = readNumber(worker, pattern, `alcove ${name} in the worker`);
    assert.equal(onWorker, onServer, `alcove ${name}: the worker disagrees with the server`);
    assert.equal(clientAlcove[name], onServer, `alcove ${name}: arcade.js disagrees with the server`);
  }

  // The two rectangles must touch along a shared edge, or the extension is an
  // island the player can see and never reach.
  assert.equal(clientAlcove.maxX, clientBounds.minX, 'the alcove must meet the main rectangle');
  assert.ok(clientAlcove.minZ > 0 && clientAlcove.maxZ <= clientBounds.maxZ, 'the alcove must sit inside the Mega Man room');
});

/** Rooms sealed behind a construction barrier, read from the scene itself. */
const blockedRooms = [...client.matchAll(/userData\.roomName='(\w+)'/g)].map((match) => match[1].toLowerCase());

void test('the world reaches every cabinet a player is meant to stand at', () => {
  // A cabinet outside the bounds is unreachable, and nothing says so — the
  // player simply stops walking. Cabinets inside a barriered room are exempt:
  // they are unreachable on purpose, and the barrier says so.
  assert.ok(blockedRooms.length > 0, 'the scene must still declare its barriered rooms');
  const registryPath = path.join(root, 'assets/cabinets/registry.json');
  return readFile(registryPath, 'utf8').then((raw) => {
    const parsed = JSON.parse(raw);
    const cabinets: Array<Record<string, any>> = Array.isArray(parsed) ? parsed : parsed.cabinets ?? [];
    assert.ok(cabinets.length > 0, 'the cabinet registry must not be empty');

    const reachable = (x: number, z: number) =>
      (x >= clientBounds.minX && x <= clientBounds.maxX && z >= clientBounds.minZ && z <= clientBounds.maxZ)
      || (x >= clientAlcove.minX && x <= clientAlcove.maxX && z >= clientAlcove.minZ && z <= clientAlcove.maxZ);

    const unreachable = cabinets.filter((cabinet) => {
      if (cabinet.enabled === false) return false;
      if (blockedRooms.some((room) => String(cabinet.zoneId ?? '').startsWith(room))) return false;
      const at = cabinet.interactionPosition;
      if (!at) return false;
      return !reachable(at.x, at.z);
    }).map((cabinet) => `${cabinet.id} at (${cabinet.interactionPosition.x}, ${cabinet.interactionPosition.z})`);

    assert.deepEqual(unreachable, [], 'these cabinets are outside the world bounds and cannot be walked to');
  });
});

void test('the GameCube room is closed, and closed in both places', () => {
  // The barrier and the world bound behind it have to move together. Either one
  // alone tells the player the opposite of what the other enforces.
  assert.ok(client.includes('gamecubeConstructionBarrier'), 'the tape barrier must be present');
  const prompt = /function nearbyConstructionRoom\(\)\{[\s\S]*?\n/.exec(client)?.[0] ?? '';
  assert.ok(prompt.includes("'GameCube'"), 'the doorway must report the room as under construction');
  assert.ok(clientBounds.maxZ < 23, 'the world must stop short of the GameCube room');
});
