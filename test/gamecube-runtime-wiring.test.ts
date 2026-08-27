import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * How the arcade decides to run a GameCube cabinet.
 *
 * The decision is per-player rather than per-game, so it cannot live in the
 * registry, and the probe that informs it has a cost the rest of the arcade
 * must not pay. Both of those are easy to undo without noticing, so both are
 * pinned here.
 */
const root = process.cwd();
const bootstrap = await readFile(path.join(root, 'app-bootstrap.js'), 'utf8');
const arcade = await readFile(path.join(root, 'arcade.js'), 'utf8');

void test('the runtime probe does not run at startup', async () => {
  // A browser cannot fetch a closed port quietly: every refused connection
  // prints a network error the page cannot suppress. Probing on load would put
  // four red lines in the console of every player without the runtime — which
  // is most of them — and this session has already shown how expensive it is to
  // tell a real console error from permanent noise.
  const detectCalls = bootstrap.match(/ARCADE_RUNTIME_CLIENT\.detect\(\)/g) ?? [];
  assert.equal(detectCalls.length, 1, 'exactly one call site, inside the lazy helper');
  assert.match(bootstrap, /ARCADE_ENSURE_RUNTIME_DETECTION = \(\) =>/, 'the probe must be behind a function');

  // Anything at module scope runs on load. The call must be inside the helper.
  const beforeHelper = bootstrap.slice(0, bootstrap.indexOf('ARCADE_ENSURE_RUNTIME_DETECTION'));
  assert.ok(!beforeHelper.includes('.detect()'), 'nothing may probe before the helper is defined');
});

void test('the probe starts when a player reaches a GameCube cabinet', () => {
  // Early enough that the answer is ready before they press play, and late
  // enough that a player who never touches GameCube never pays for it.
  assert.match(arcade, /system==='gamecube'\)\s*window\.ARCADE_ENSURE_RUNTIME_DETECTION\?\.\(\)/);
});

void test('GameCube asks who should run it; other platforms are untouched', () => {
  assert.match(arcade, /cabinet\?\.system==='gamecube'&&window\.ARCADE_CHOOSE_GAMECUBE_ADAPTER/);
  // The declared-adapter path still decides everything else, so this change
  // cannot alter how a PlayStation or SNES cabinet resolves.
  assert.match(arcade, /adapters\.resolveForGame\(game\)/);
});

void test('the runtime adapter is registered, so it can be chosen', () => {
  assert.match(bootstrap, /register\(createPtcRuntimeGameCubeAdapter\(\)\)/);
});

void test('the import chain moved together', async () => {
  // app-bootstrap gained imports, so a browser holding the old one would run
  // new arcade.js against an old graph. cabinet-visuals guards the invariant;
  // this states why it matters for this change.
  const index = await readFile(path.join(root, 'index.html'), 'utf8');
  const bootstrapKey = /app-bootstrap\.js\?v=([A-Za-z0-9-]+)/.exec(index)?.[1];
  const arcadeKey = /arcade\.js\?v=([A-Za-z0-9-]+)/.exec(bootstrap)?.[1];
  assert.equal(bootstrapKey, arcadeKey);
  assert.equal(bootstrapKey, 'arcade-rows-5', 'the key must move when this chain changes');
});

void test('the catalogue route serves what the runtime parser reads', async () => {
  // The runtime's parseCatalog reads `games`, and drops any entry missing a
  // field. A route that renamed one would produce an empty library and no error.
  const route = await readFile(path.join(root, 'server/src/http/api/v1/runtime-routes.ts'), 'utf8');
  for (const field of ['gameId', 'platformId', 'downloadUrl', 'fileName', 'sizeBytes', 'sha256']) {
    assert.match(route, new RegExp(`\\b${field}:`), `the catalogue must carry ${field}`);
  }
  assert.match(route, /games: entries\.map/, 'the runtime parser reads `games`');
});
