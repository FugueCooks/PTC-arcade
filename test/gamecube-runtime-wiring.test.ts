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

void test('the probe starts when a player reaches a natively-runnable cabinet', () => {
  // Early enough that the answer is ready before they press play, and late
  // enough that a player who touches neither native platform never pays for it.
  // PS2 joined GameCube here: without the probe a PS2 cabinet would never learn
  // the runtime exists and would always fall back to the browser core.
  assert.match(arcade, /c\.system==='gamecube'\|\|c\.system==='ps2'\)\{/);
  assert.match(arcade, /window\.ARCADE_ENSURE_RUNTIME_DETECTION\?\.\(\)\?\.then\?\.\(describe\)/, 'the cabinet waits for the answer and then says what it was');
  // The verdict must sit above the screen. It was written into
  // #emulator-controls first, which sits below the screen and below the fold
  // of a scrolling panel, so a player at a PS2 cabinet never saw a word of it.
  assert.match(arcade, /querySelector\('#native-runtime-state'\)/);
  assert.doesNotMatch(arcade, /nativeLine=document\.querySelector\('#emulator-controls'\)/);
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
  assert.ok(bootstrapKey, 'index.html must version the bootstrap it loads');
  // The invariant is that the chain moves together. Pinning the literal token
  // as well meant every unrelated release edited this file to re-state the
  // same thing, which is how the tokens drifted apart in the first place.
  assert.equal(bootstrapKey, arcadeKey, 'the key must move through the whole chain when it changes');
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

void test('PlayStation 2 takes the native path the same way GameCube does', async () => {
  // The browser core holds about 40 f/s on the demanding PS2 titles, which is
  // the core's speed rather than anything caching reaches, so a player with the
  // runtime installed gets PCSX2 instead.
  const adapter = await readFile(path.join(root, 'emulators/adapters/ptc-runtime-ps2-adapter.js'), 'utf8');
  assert.match(adapter, /platform: 'ps2'/);
  assert.match(adapter, /emulatorKey: 'pcsx2Present'/);
  assert.match(adapter, /fallbackId: 'play-ps2'/);
  // Gecko needs a desktop; Play! does not, and gating PS2 the same way would
  // leave a phone with nothing where it previously had a working core.
  assert.doesNotMatch(adapter, /fallbackNeedsDesktop/);

  // Registered in the browser, chosen by the cabinet, and the probe that
  // decides it now runs when a player walks up to a PS2 cabinet as well.
  const bootstrap = await readFile(path.join(root, 'app-bootstrap.js'), 'utf8');
  assert.match(bootstrap, /register\(createPtcRuntimePs2Adapter\(\)\)/);
  assert.match(bootstrap, /window\.ARCADE_CHOOSE_PS2_ADAPTER = choosePs2Adapter/);
  const arcadeSource = await readFile(path.join(root, 'arcade.js'), 'utf8');
  assert.match(arcadeSource, /c\.system==='gamecube'\|\|c\.system==='ps2'\)\{/);
  assert.match(arcadeSource, /cabinet\?\.system==='ps2'&&window\.ARCADE_CHOOSE_PS2_ADAPTER/);

  // And the two emulators are reported separately, because having the runtime
  // is not having the emulator it drives.
  const client = await readFile(path.join(root, 'emulators/ptc-runtime/runtime-client.js'), 'utf8');
  assert.match(client, /pcsx2Present: found\.status\.pcsx2\?\.present === true/);
});

void test('the runtime protocol itself is written once, not per platform', async () => {
  // GameCube and PS2 differ in the platform they claim, the emulator they need
  // and what they fall back to. The frame, the handshake, the message contract
  // and the timeout are the protocol, and drift between two copies of it is
  // exactly the failure this repository keeps paying for.
  const shared = await readFile(path.join(root, 'emulators/adapters/ptc-runtime-adapter.js'), 'utf8');
  assert.match(shared, /export function createRuntimeAdapter/);
  assert.match(shared, /export function chooseRuntimeAdapter/);
  for (const perPlatform of ['ptc-runtime-gamecube-adapter.js', 'ptc-runtime-ps2-adapter.js']) {
    const source = await readFile(path.join(root, 'emulators/adapters', perPlatform), 'utf8');
    assert.doesNotMatch(source, /FRAME_MESSAGES\./, `${perPlatform} must not carry its own copy of the message contract`);
    assert.match(source, /createRuntimeAdapter\(\{/);
  }
});
