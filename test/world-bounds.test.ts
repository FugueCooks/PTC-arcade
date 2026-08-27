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
 * are three.
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

const clientBounds = (() => {
  const match = /const WORLD_BOUNDS=\{minX:(-?[\d.]+),maxX:(-?[\d.]+),minZ:(-?[\d.]+),maxZ:(-?[\d.]+)\}/.exec(client);
  assert.ok(match, 'arcade.js must declare WORLD_BOUNDS');
  return { minX: Number(match![1]), maxX: Number(match![2]), minZ: Number(match![3]), maxZ: Number(match![4]) };
})();

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

void test('the world reaches every cabinet a player is meant to stand at', () => {
  // A cabinet outside the bounds is unreachable, and nothing says so — the
  // player simply stops walking. The GameCube room sat outside them entirely,
  // which is why four-player Melee could not be played at all.
  const registryPath = path.join(root, 'assets/cabinets/registry.json');
  return readFile(registryPath, 'utf8').then((raw) => {
    const parsed = JSON.parse(raw);
    const cabinets: Array<Record<string, any>> = Array.isArray(parsed) ? parsed : parsed.cabinets ?? [];
    assert.ok(cabinets.length > 0, 'the cabinet registry must not be empty');

    const unreachable = cabinets.filter((cabinet) => {
      if (cabinet.enabled === false) return false;
      const at = cabinet.interactionPosition;
      if (!at) return false;
      return at.x < clientBounds.minX || at.x > clientBounds.maxX
        || at.z < clientBounds.minZ || at.z > clientBounds.maxZ;
    }).map((cabinet) => `${cabinet.id} at (${cabinet.interactionPosition.x}, ${cabinet.interactionPosition.z})`);

    assert.deepEqual(unreachable, [], 'these cabinets are outside the world bounds and cannot be walked to');
  });
});

void test('the GameCube room is open', () => {
  // The barrier and the "closed" prompt came down together. Leaving either
  // would tell players the room is shut while letting them walk into it.
  assert.ok(!client.includes('gamecubeConstructionBarrier'), 'the tape barrier must be gone');
  const prompt = /function nearbyConstructionRoom\(\)\{[\s\S]*?\n/.exec(client)?.[0] ?? '';
  assert.ok(!prompt.includes("'GameCube'"), 'the doorway must no longer report the room as under construction');
});
