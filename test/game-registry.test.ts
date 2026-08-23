import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

interface GameDefinition {
  id: string;
  cabinetId: string;
  name: string;
  system: 'psx' | 'n64';
  file: string;
  emulatorId: number;
  sizeBytes: number;
  enabled: boolean;
}

async function loadJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(path.resolve(process.cwd(), file), 'utf8')) as T;
}

void test('hosted games have unique IDs, files, emulator IDs, and cabinet assignments', async () => {
  const registry = await loadJson<{ version: number; games: GameDefinition[] }>('assets/games/registry.json');
  assert.equal(registry.version, 1);
  assert.equal(registry.games.length, 10);
  for (const key of ['id', 'cabinetId', 'file', 'emulatorId'] as const) {
    const values = registry.games.map((game) => game[key]);
    assert.equal(new Set(values).size, values.length, `${key} values must be unique`);
  }
  assert.ok(registry.games.every((game) => game.enabled && game.sizeBytes > 0));
});

void test('every hosted game points at an approved, enabled cabinet', async () => {
  const games = (await loadJson<{ games: GameDefinition[] }>('assets/games/registry.json')).games;
  const cabinets = await loadJson<Array<{ id: string; enabled: boolean; defaultGameId?: string }>>('assets/cabinets/registry.json');
  const enabledCabinets = new Set(cabinets.filter((cabinet) => cabinet.enabled).map((cabinet) => cabinet.id));
  const cabinetById = new Map(cabinets.map((cabinet) => [cabinet.id, cabinet]));
  for (const game of games) {
    assert.ok(enabledCabinets.has(game.cabinetId), `${game.id} uses an unknown cabinet`);
    assert.equal(cabinetById.get(game.cabinetId)?.defaultGameId, game.id, `${game.id} is not the cabinet default`);
  }
});
