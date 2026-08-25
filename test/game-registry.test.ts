import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

interface GameDefinition {
  id: string;
  cabinetId: string;
  name: string;
  system: 'psx' | 'n64' | 'ps2' | 'gamecube';
  file: string;
  emulatorId: number;
  sizeBytes: number;
  discs?: Array<{ label: string; file: string; sizeBytes: number }>;
  enabled: boolean;
}

async function loadJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(path.resolve(process.cwd(), file), 'utf8')) as T;
}

void test('hosted games have unique IDs, files, emulator IDs, and cabinet assignments', async () => {
  const registry = await loadJson<{ version: number; games: GameDefinition[] }>('assets/games/registry.json');
  assert.equal(registry.version, 1);
  assert.equal(registry.games.length, 22);
  for (const key of ['id', 'cabinetId', 'file', 'emulatorId'] as const) {
    const values = registry.games.map((game) => game[key]);
    assert.equal(new Set(values).size, values.length, `${key} values must be unique`);
  }
  assert.ok(registry.games.every((game) => game.sizeBytes > 0));
  const assetFiles = registry.games.flatMap((game) => game.discs?.map((disc) => disc.file) ?? [game.file]);
  assert.equal(new Set(assetFiles).size, assetFiles.length, 'every hosted disc file must be unique');
});

void test('every hosted game points at an approved, enabled cabinet', async () => {
  const games = (await loadJson<{ games: GameDefinition[] }>('assets/games/registry.json')).games;
  const cabinets = await loadJson<Array<{ id: string; enabled: boolean; defaultGameId?: string }>>('assets/cabinets/registry.json');
  const enabledCabinets = new Set(cabinets.filter((cabinet) => cabinet.enabled).map((cabinet) => cabinet.id));
  const cabinetById = new Map(cabinets.map((cabinet) => [cabinet.id, cabinet]));
  for (const game of games.filter((entry) => entry.enabled)) {
    assert.ok(enabledCabinets.has(game.cabinetId), `${game.id} uses an unknown cabinet`);
    assert.equal(cabinetById.get(game.cabinetId)?.defaultGameId, game.id, `${game.id} is not the cabinet default`);
  }
});

void test('unique N64 games are consolidated in the main room and the rear room is Xbox-ready', async () => {
  const cabinets = await loadJson<Array<{ id: string; name: string; enabled: boolean; defaultGameId?: string; system?: string; emulatorId?: string; interactionPosition?: { x: number; y: number; z: number }; playerPosition?: { x: number; y: number; z: number } }>>('assets/cabinets/registry.json');
  const byId = new Map(cabinets.map((cabinet) => [cabinet.id, cabinet]));
  assert.equal(byId.get('n64-cabinet-06')?.defaultGameId, 'star-fox-64');
  assert.equal(byId.get('n64-cabinet-07')?.defaultGameId, 'mega-man-64');
  assert.equal(byId.get('silent-hill')?.defaultGameId, 'silent-hill');
  assert.equal(byId.get('metal-gear-solid')?.defaultGameId, 'metal-gear-solid');
  assert.equal([...byId].filter(([id]) => id.startsWith('n64-back-cabinet-')).length, 0);
  assert.equal([...byId].filter(([id, cabinet]) => id.startsWith('xbox-cabinet-') && !cabinet.enabled).length, 5);
  const gamecubeCabinets = [...byId].filter(([id]) => id.startsWith('gamecube-cabinet-')).map(([, cabinet]) => cabinet);
  assert.equal(gamecubeCabinets.length, 5);
  assert.ok(gamecubeCabinets.every((cabinet) => cabinet.enabled));
  assert.ok(gamecubeCabinets.every((cabinet) => cabinet.system === 'gamecube' && cabinet.emulatorId === 'gecko'));
  assert.deepEqual(gamecubeCabinets.map((cabinet) => cabinet.interactionPosition), [
    { x: -8.2, y: 1.65, z: 23 }, { x: -8.2, y: 1.65, z: 31 },
    { x: 8.2, y: 1.65, z: 23 }, { x: 8.2, y: 1.65, z: 31 },
    { x: 0, y: 1.65, z: 37.2 }
  ]);
  assert.deepEqual(gamecubeCabinets.map((cabinet) => cabinet.defaultGameId), [
    'wind-waker',
    'zelda-twilight-princess',
    'pikmin',
    'super-smash-bros-melee',
    'super-mario-sunshine'
  ]);
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

void test('GameCube RVZ images are registered for the validated Gecko runtime', async () => {
  const games = (await loadJson<{ games: GameDefinition[] }>('assets/games/registry.json')).games;
  const gamecubeGames = games.filter((game) => game.system === 'gamecube');
  const remoteAssets = await loadJson<Array<{ file: string; bytes: number; sha256: string; system: string }>>('deploy/remote-gamecube-assets.json');
  assert.equal(gamecubeGames.length, 5);
  assert.ok(gamecubeGames.every((game) => game.enabled && game.file.endsWith('.rvz')));
  assert.equal(remoteAssets.length, gamecubeGames.length);
  assert.ok(remoteAssets.every((asset) => asset.system === 'gamecube' && /^[a-f0-9]{64}$/.test(asset.sha256)));
  assert.deepEqual(
    remoteAssets.map(({ file, bytes }) => ({ file, bytes })),
    gamecubeGames.map((game) => ({ file: game.file, bytes: game.sizeBytes }))
  );
  assert.deepEqual(gamecubeGames.map((game) => game.name), [
    'The Legend of Zelda: The Wind Waker',
    'The Legend of Zelda: Twilight Princess',
    'Pikmin',
    'Super Smash Bros. Melee',
    'Super Mario Sunshine'
  ]);
  const dockerfile = await readFile(path.resolve(process.cwd(), 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /COPY --from=build \/app\/emulators \.\/emulators/);
});

void test('Metal Gear Solid keeps both discs in one cabinet and one save identity', async () => {
  const games = (await loadJson<{ games: GameDefinition[] }>('assets/games/registry.json')).games;
  const metalGear = games.find((game) => game.id === 'metal-gear-solid');
  assert.equal(metalGear?.cabinetId, 'metal-gear-solid');
  assert.equal(metalGear?.emulatorId, 95003);
  assert.deepEqual(metalGear?.discs?.map((disc) => disc.label), ['Disc 1', 'Disc 2']);
  assert.deepEqual(metalGear?.discs?.map((disc) => disc.file), [
    'metal-gear-solid-disc-1.chd',
    'metal-gear-solid-disc-2.chd'
  ]);
  const arcade = await readFile(path.resolve(process.cwd(), 'arcade.js'), 'utf8');
  const markup = await readFile(path.resolve(process.cwd(), 'index.html'), 'utf8');
  assert.match(arcade, /hostedDiscs/);
  assert.match(arcade, /DISC SET READY/);
  assert.match(markup, /id="hosted-disc-selector"/);
  const worker = await readFile(path.resolve(process.cwd(), 'cloudflare', 'src', 'index.ts'), 'utf8');
  assert.match(worker, /if \(!this\.cabinetStates\.has\(id\)\) this\.cabinetStates\.set\(id, availableCabinet\(id\)\)/);
});
