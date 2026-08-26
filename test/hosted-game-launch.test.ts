import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { importBrowserModule } from './helpers/browser-module.js';

/**
 * Every other adapter test builds its own game object, and every one of them
 * spelled the platform `platformId` — the server's name for it. The browser
 * never sees that shape: it parses `assets/games/registry.json`, where the
 * field is called `system`. So the adapters read `undefined`, the EmulatorJS
 * core fell back to `psx`, and every SNES and N64 cabinet launched on the
 * PlayStation core and dropped the player into the core's own menu.
 *
 * These tests drive the real loader over the real registry file, so the shape
 * a player actually launches is the shape under test.
 */
const { loadGameRegistry } = await importBrowserModule<any>('games/game-registry.js');
const { createDefaultAdapterRegistry } = await importBrowserModule<any>('emulators/emulator-adapter-registry.js');
const { createEmulatorJsAdapter } = await importBrowserModule<any>('emulators/adapters/emulatorjs-adapter.js');

/** Serves the shipped registry file to the loader's relative fetch. */
async function loadShippedRegistry() {
  const source = await readFile(path.resolve(process.cwd(), 'assets/games/registry.json'), 'utf8');
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => JSON.parse(source) })) as never;
  try {
    return await loadGameRegistry();
  } finally {
    globalThis.fetch = original;
  }
}

const EXPECTED_CORE: Record<string, string> = { psx: 'psx', n64: 'n64', snes: 'snes9x' };

void test('every shipped game exposes the platform field the adapters read', async () => {
  const registry = await loadShippedRegistry();
  assert.ok(registry.byId.size > 0, 'the shipped registry must not be empty');
  for (const game of registry.byId.values()) {
    assert.equal(game.platformId, game.system, `${game.id} must carry both platform names`);
    assert.ok(game.platformId, `${game.id} has no platform`);
  }
});

void test('a shipped game resolves to an adapter that covers its platform', async () => {
  const registry = await loadShippedRegistry();
  const adapters = createDefaultAdapterRegistry();
  for (const game of registry.byId.values()) {
    const resolution = adapters.resolveForGame(game);
    assert.equal(resolution.ok, true, `${game.id} resolved no adapter (${resolution.reason})`);
    assert.ok(
      resolution.adapter.supportedPlatforms.includes(game.system),
      `${game.id} resolved ${resolution.adapter.id}, which does not cover ${game.system}`
    );
  }
});

void test('a shipped EmulatorJS game launches on its own core, never the fallback', async () => {
  const registry = await loadShippedRegistry();
  const adapter = createEmulatorJsAdapter();
  const seen = new Set<string>();

  for (const game of registry.byId.values()) {
    const expected = EXPECTED_CORE[game.system];
    if (!expected) continue; // ps2 and gamecube run on their own adapters.
    seen.add(game.system);
    const frame = adapter.describeFrame({ game, gameUrl: `https://cdn.example/${game.file}`, displayName: game.name });
    const parameters = new URLSearchParams(frame.src.split('?')[1]);
    assert.equal(parameters.get('core'), expected, `${game.id} (${game.system}) must launch on ${expected}`);
    assert.ok(parameters.get('game'), `${game.id} must carry a game URL, or the core boots into its own menu`);
  }

  // Guards the guard: if the registry ever stops shipping a non-PlayStation
  // game, this test would pass while proving nothing about the fallback.
  assert.ok(seen.has('snes'), 'the registry must still ship a SNES game for this to mean anything');
});

void test('an unassigned cabinet still launches a local file on its own platform', async () => {
  // No registry game, so the platform comes from the cabinet. This is the path
  // behind "LOAD GAME FILE" on a cabinet with no game assigned.
  const adapter = createEmulatorJsAdapter();
  const frame = adapter.describeFrame({ game: null, platformId: 'snes', gameUrl: 'blob:local', displayName: 'Local ROM' });
  assert.equal(new URLSearchParams(frame.src.split('?')[1]).get('core'), 'snes9x');
});

void test('an uncoverable platform refuses instead of falling back to PlayStation', async () => {
  const adapter = createEmulatorJsAdapter();
  assert.throws(
    () => adapter.describeFrame({ game: { id: 'x', system: 'ps2' }, gameUrl: 'g' }),
    /No EmulatorJS core covers platform ps2/
  );
  assert.throws(() => adapter.describeFrame({ game: null, gameUrl: 'g' }), /unknown/);
});
