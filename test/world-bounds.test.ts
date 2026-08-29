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
 * are three. They were two rectangles each while the Mega Man room reached past
 * the building's west wall; every side room is that width now, so the outer wall
 * is a straight run and one rectangle describes the whole floor again.
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

void test('the floor is the main rectangle plus the Silent Hill expanse, in all three copies', () => {
  // Silent Hill sits in the top row's west corner and is doubled sideways:
  // its annex is bolted onto the OUTSIDE of the building's west wall. A
  // region that survives in one copy and not another is the exact drift this
  // file exists to catch: the symptom is not a wall but a player who simply
  // stops walking, or walks somewhere the server then refuses.
  for (const source of [server, worker, client]) {
    assert.ok(!/MEGAMAN_ALCOVE/.test(source), 'the retired alcove must not come back by that name');
    assert.ok(!/SILENT_HILL_ANNEX/.test(source), 'the retired tournament-hall annex must not come back by that name');
    assert.ok(!source.includes('z <= 49.9'), 'no copy may still walk into the tournament hall west end');
  }
  assert.equal(clientBounds.minX, -42.7);
  assert.equal(clientBounds.maxX, 42.7);
  assert.equal(clientBounds.minX, -clientBounds.maxX, 'the main rectangle stays symmetric');

  const expanse = clientRegion('SILENT_HILL_EXPANSE');
  assert.deepEqual(expanse, { minX: -64.3, maxX: -42.7, minZ: -66.7, maxZ: -42.5 });
  assert.equal(expanse.maxX, clientBounds.minX, 'the expanse must meet the main rectangle');
  // The arena hangs in the void north of the building, its own region.
  const arena = clientRegion('POKEMON_EXPANSE');
  assert.deepEqual(arena, { minX: -12, maxX: 66, minZ: -138.6, maxZ: -42.5 });
  // The garden meadow hangs off the east wall, its own region.
  const garden = clientRegion('CHAO_EXPANSE');
  assert.deepEqual(garden, { minX: 42.7, maxX: 88, minZ: -1.2, maxZ: 31.5 });
  assert.equal(garden.minX, clientBounds.maxX, 'the garden must meet the main rectangle');
  // Both authorities carry the same numbers, so no region drifts at a seam.
  for (const [name, source] of [['server', server], ['worker', worker]] as const) {
    assert.ok(source.includes('if (x >= -64.3 && x <= MIN_WORLD_X && z >= -66.7 && z <= -42.5) return true;'),
      `${name} must enforce the Silent Hill expanse`);
    assert.ok(source.includes('return x >= -12 && x <= 66 && z >= -138.6 && z <= -42.5;'),
      `${name} must enforce the arena expanse`);
    assert.ok(source.includes('if (x >= 42.7 && x <= 88 && z >= -1.2 && z <= 31.5) return true;'),
      `${name} must enforce the garden expanse`);
  }
});

/** Rooms sealed behind a construction barrier, read from the scene itself. */
const blockedRooms = [...client.matchAll(/sealDoorway\('([^']+)'/g)]
  .map((match) => match[1].toLowerCase().split(' ')[0]);

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

    // The floor is a union now: the main rectangle, the Silent Hill annex,
    // and the arena in the void — a cabinet in any of them can be walked to.
    const regions = [clientBounds, clientRegion('SILENT_HILL_EXPANSE'), clientRegion('POKEMON_EXPANSE'), clientRegion('CHAO_EXPANSE')];
    const reachable = (x: number, z: number) =>
      regions.some((region) => x >= region.minX && x <= region.maxX && z >= region.minZ && z <= region.maxZ);

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

void test('the sealed rooms are closed in the scene and in what it enforces', () => {
  // A barrier and the rule behind it have to move together. Either one alone
  // tells the player the opposite of what the other enforces.
  const prompt = /function nearbyConstructionRoom\(\)\{[\s\S]*?\n\}/.exec(client)?.[0] ?? '';

  // The Multiplayer / Tournament room is beyond the hub, and the world stops
  // short of the doorway into it.
  assert.ok(client.includes("sealDoorway('Multiplayer / Tournament'"), 'the tournament barrier must be present');
  assert.ok(/for\(const barrier of constructionBarriers\)/.test(client), 'the prompt must read the room off the barrier');
  assert.ok(clientBounds.maxZ < 33.6, 'the world must stop short of the tournament room');

  // Nothing else is sealed. Every doorway in both partition walls is open, and
  // the top row is reached through its own front wall rather than being held
  // out by the world bound, so that wall has to be enforced now.
  assert.equal((client.match(/sealDoorway\('/g) ?? []).length, 1, 'the tournament hall is the only sealed room');
  assert.ok(/const OPEN_DOOR_Z_WEST=\[-25\.2,-8,8,25\.2\]/.test(client),
    'the doorways that are open must be stated once');
  assert.ok(client.includes('resolveTopRowCollisions'), 'the top row needs real walls now that it is open');
  assert.ok(clientBounds.minZ < -50.4, 'the world must reach into the top row');
});
