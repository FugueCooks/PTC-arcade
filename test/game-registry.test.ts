import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

interface GameDefinition {
  id: string;
  cabinetId: string;
  name: string;
  system: 'psx' | 'n64' | 'ps2';
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
  assert.equal(registry.games.length, 16);
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

void test('the rear console rooms expose hosted N64 games and tested experimental PS2 cabinets', async () => {
  const cabinets = await loadJson<Array<{ id: string; name: string; enabled: boolean; defaultGameId?: string }>>('assets/cabinets/registry.json');
  const byId = new Map(cabinets.map((cabinet) => [cabinet.id, cabinet]));
  assert.equal(byId.get('n64-back-cabinet-01')?.defaultGameId, 'star-fox-64');
  assert.equal(byId.get('n64-back-cabinet-02')?.defaultGameId, 'mega-man-64');
  assert.equal(byId.get('n64-back-cabinet-03')?.defaultGameId, 'super-mario-64-expansion');
  assert.equal(byId.get('psx-back-cabinet-01')?.enabled, false);
  assert.equal(byId.get('psx-back-cabinet-02')?.enabled, true);
  assert.equal(byId.get('psx-back-cabinet-03')?.enabled, true);
  assert.equal(byId.get('psx-back-cabinet-04')?.enabled, true);
  assert.equal(byId.get('psx-back-cabinet-05')?.enabled, false);
  assert.equal(byId.get('psx-back-cabinet-01')?.name, 'God of War (PS2)');
  assert.equal(byId.get('psx-back-cabinet-02')?.name, 'Kingdom Hearts (PS2)');
  assert.equal(byId.get('psx-back-cabinet-03')?.name, 'Grand Theft Auto: San Andreas (PS2)');
  assert.equal(byId.get('psx-back-cabinet-04')?.name, 'Dragon Ball Z: Budokai Tenkaichi 3 (PS2)');
  assert.equal(byId.get('psx-back-cabinet-02')?.defaultGameId, 'kingdom-hearts');
  assert.equal(byId.get('psx-back-cabinet-03')?.defaultGameId, 'gta-san-andreas');
  assert.equal(byId.get('psx-back-cabinet-04')?.defaultGameId, 'dbz-tenkaichi-3');
});
