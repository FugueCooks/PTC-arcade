import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

interface GameDefinition {
  id: string;
  cabinetId: string;
  name: string;
  system: 'psx' | 'n64' | 'snes' | 'ps2' | 'gamecube';
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
  assert.equal(registry.version, 2);
  assert.equal(registry.games.length, 80);
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
  assert.equal(byId.get('n64-cabinet-07')?.defaultGameId, undefined);
  assert.equal(byId.get('megaman-cabinet-09')?.defaultGameId, 'mega-man-64');
  assert.equal(byId.get('silent-hill')?.defaultGameId, 'silent-hill');
  assert.equal(byId.get('metal-gear-solid')?.defaultGameId, 'metal-gear-solid');
  assert.equal([...byId].filter(([id]) => id.startsWith('n64-back-cabinet-')).length, 0);
  assert.equal([...byId].filter(([id, cabinet]) => id.startsWith('sonic-cabinet-') && !cabinet.enabled).length, 2);
  const gamecubeCabinets = [...byId].filter(([id]) => id.startsWith('gamecube-cabinet-')).map(([, cabinet]) => cabinet);
  assert.equal(gamecubeCabinets.length, 5);
  assert.ok(gamecubeCabinets.every((cabinet) => cabinet.enabled));
  assert.ok(gamecubeCabinets.every((cabinet) => cabinet.system === 'gamecube' && cabinet.emulatorId === 'gecko'));
  // GameCube moved into the rear gallery behind Nintendo 64, mirroring the PS2
  // room behind PlayStation. The room it used to occupy is the Multiplayer /
  // Tournament room, which runs the full width of the building.
  // Out in the foyer with the other console games: the back five of the east
  // hall row, all facing the centre aisle.
  // Cabinets 01 and 02 — Wind Waker and Twilight Princess — stand in the Temple
  // of Time's back room with the rest of the Zelda library, on its floor at
  // y 0.993 rather than the hall's 1.65. Melee came back off the tournament
  // hall into its own foyer slot when that hall was cleared. The remaining
  // three hold the shelf.
  assert.deepEqual(gamecubeCabinets.map((cabinet) => cabinet.interactionPosition), [
    { x: -103.268871, y: 0.993, z: 36.433684 }, { x: -96.037024, y: 0.993, z: 33.538489 },
    { x: 9.5, y: 1.65, z: 8.05 }, { x: 9.5, y: 1.65, z: 10.35 },
    // Sunshine stands in Peach's Castle hall, back-right corner, on its floor.
    { x: -100.5, y: 1.669, z: 0.3 }
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
  const megaManCabinets = [...byId]
    .filter(([id]) => id.startsWith('megaman-cabinet-'))
    .map(([, cabinet]) => cabinet);
  // Nine cabinets, nine games: the tenth was an empty shell holding a seat for
  // a game that never came, and it is gone.
  assert.equal(megaManCabinets.length, 9);
  assert.ok(megaManCabinets.every((cabinet) => cabinet.enabled));
  // Cabinet 08 is held for a PS2 title and stands between X6 and Mega Man 8 in
  // the row; the ids stay in their original order, which is why the odd one out
  // is eighth here and seventh on the wall.
  assert.deepEqual(megaManCabinets.map((cabinet) => cabinet.system), [
    'snes', 'snes', 'snes', 'psx', 'psx', 'psx', 'psx', 'ps2', 'n64'
  ]);
  assert.deepEqual(megaManCabinets.map((cabinet) => cabinet.defaultGameId), [
    'mega-man-x',
    'mega-man-x2',
    'mega-man-x3',
    'mega-man-x4',
    'mega-man-x5',
    'mega-man-x6',
    'mega-man-8',
    'mega-man-x7',
    'mega-man-64'
  ]);
});

void test('every supplied Mega Man game has its own cabinet and supported image', async () => {
  const games = (await loadJson<{ games: GameDefinition[] }>('assets/games/registry.json')).games;
  const megaManGames = games
    .filter((game) => game.cabinetId.startsWith('megaman-cabinet-'))
    .sort((left, right) => left.cabinetId.localeCompare(right.cabinetId));
  assert.deepEqual(megaManGames.map((game) => game.name), [
    'Mega Man X',
    'Mega Man X2',
    'Mega Man X3',
    'Mega Man X4',
    'Mega Man X5',
    'Mega Man X6',
    'Mega Man 8',
    'Mega Man X7',
    'Mega Man 64'
  ]);
  assert.equal(new Set(megaManGames.map((game) => game.cabinetId)).size, megaManGames.length);
  assert.ok(megaManGames.filter((game) => game.system === 'snes').every((game) => game.file.endsWith('.sfc')));
  assert.ok(megaManGames.filter((game) => game.system === 'psx').every((game) => game.file.endsWith('.chd')));
  assert.ok(megaManGames.filter((game) => game.system === 'n64').every((game) => game.file.endsWith('.z64')));
  // The PS2 disc is CHD rather than the ISO it was supplied as: the same image
  // at 62% of the size, over a path that streams either way.
  assert.ok(megaManGames.filter((game) => game.system === 'ps2').every((game) => game.file.endsWith('.chd')));
  const arcade = await readFile(path.resolve(process.cwd(), 'arcade.js'), 'utf8');
  const player = await readFile(path.resolve(process.cwd(), 'player.html'), 'utf8');
  // The core rename moved into the EmulatorJS adapter, which is now the only
  // place any platform-to-core mapping exists.
  const adapter = await readFile(path.resolve(process.cwd(), 'emulators/adapters/emulatorjs-adapter.js'), 'utf8');
  assert.match(adapter, /snes: 'snes9x'/);
  assert.doesNotMatch(arcade, /snes9x/, 'arcade.js must no longer name a core');
  assert.match(player, /'snes9x'/);
});

void test('GameCube RVZ images are registered for the validated Gecko runtime', async () => {
  const games = (await loadJson<{ games: GameDefinition[] }>('assets/games/registry.json')).games;
  const gamecubeGames = games.filter((game) => game.system === 'gamecube');
  const remoteAssets = await loadJson<Array<{ file: string; bytes: number; sha256: string; system: string }>>('assets/runtime/gamecube-digests.json');
  assert.equal(gamecubeGames.length, 7);
  // .iso joined .rvz when the Metroid Primes arrived as CISO sources: Gecko's
  // own accept list is .rvz,.iso,.gcm, and CISO converts losslessly to iso with
  // tools/convert-gamecube-ciso.mjs, while RVZ would need Dolphin to author.
  assert.ok(gamecubeGames.every((game) => game.enabled && (game.file.endsWith('.rvz') || game.file.endsWith('.iso'))));
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
    'Super Mario Sunshine',
    'Metroid Prime',
    'Metroid Prime 2: Echoes'
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
