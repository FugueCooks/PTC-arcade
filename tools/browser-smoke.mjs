#!/usr/bin/env node
/**
 * Browser smoke test for the client bundle.
 *
 * `arcade.js` has no unit coverage — it is one large module that only runs
 * against a real WebGL context — so the Phase 11 refactor of its emulator launch
 * path needed something that actually boots it. This drives a headless Chromium
 * against a running server, enters the arcade as a guest, and fails on any
 * console error, page exception, or missing runtime wiring.
 *
 *   node tools/browser-smoke.mjs [--url http://127.0.0.1:8099] [--keep-screenshot path]
 *
 * playwright-core and three are not project dependencies; install them on demand:
 *   npm install --no-save playwright-core three@0.160.1
 */
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const argument = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : process.argv[at + 1];
};

const url = argument('--url', process.env.SMOKE_URL ?? 'http://127.0.0.1:8099');
const screenshotPath = argument('--keep-screenshot', null);

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  console.error('playwright-core is not installed. Run: npm install --no-save playwright-core three@0.160.1');
  process.exit(2);
}

/**
 * The page pins Three.js to a CDN through an import map. Sandboxed and offline
 * environments cannot reach it, so the same pinned build is served from
 * node_modules instead. The version must match index.html's import map.
 */
const THREE_VERSION = '0.160.1';
// three's package exports do not expose the build directory as a subpath, so the
// file is located from the package root rather than resolved as a module.
function threePackageRoot() {
  const candidates = [];
  try {
    candidates.push(path.dirname(require.resolve('three/package.json')));
  } catch { /* fall through to a direct lookup */ }
  candidates.push(path.resolve(process.cwd(), 'node_modules/three'));
  return candidates.find((candidate) => existsSync(path.join(candidate, 'build', 'three.module.js'))) ?? null;
}

const threeRoot = threePackageRoot();
const threeSource = threeRoot === null ? null : readFileSync(path.join(threeRoot, 'build', 'three.module.js'), 'utf8');
if (threeSource === null) {
  console.error(`three@${THREE_VERSION} is not installed. Run: npm install --no-save playwright-core three@${THREE_VERSION}`);
  process.exit(2);
}

const executablePath = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome']
  .find((candidate) => existsSync(candidate));

const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : {}),
  args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader']
});

const failures = [];
try {
  const page = await browser.newPage();
  // Routes this harness deliberately blocks surface as generic resource errors.
  // Reporting them as product failures would drown the real ones.
  const isBlockedResourceNoise = (text) => /Failed to load resource/.test(text)
    && /net::ERR_FAILED|net::ERR_ABORTED|net::ERR_BLOCKED|status of 5\d\d/.test(text);
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (!isBlockedResourceNoise(text)) failures.push(`console: ${text}`);
  });
  page.on('pageerror', (error) => failures.push(`pageerror: ${error.message}`));

  // The import map pins both the three core build and its addons subpath. Serve
  // each from the same local package so addon exports (GLTFLoader and friends)
  // resolve against the matching core version.
  await page.route('**/cdn.jsdelivr.net/**', (route) => {
    const requested = new URL(route.request().url()).pathname;
    const addon = requested.match(/\/examples\/jsm\/(.+)$/);
    if (addon) {
      const local = path.join(threeRoot, 'examples', 'jsm', addon[1]);
      if (!existsSync(local)) return route.abort();
      return route.fulfill({ contentType: 'application/javascript', body: readFileSync(local, 'utf8') });
    }
    return route.fulfill({ contentType: 'application/javascript', body: threeSource });
  });
  // Cosmetic or multi-hundred-megabyte resources: never fetched by a smoke test.
  for (const pattern of ['**/fonts.googleapis.com/**', '**/fonts.gstatic.com/**', '**/*.r2.dev/**', '**/cdn.emulatorjs.org/**']) {
    await page.route(pattern, (route) => route.abort());
  }

  await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForFunction(() => Boolean(window.arcadeMultiplayer), { timeout: 45_000 });

  const wiring = await page.evaluate(() => {
    const adapters = window.ARCADE_EMULATOR_ADAPTERS;
    return {
      adapterIds: adapters?.all().map((adapter) => adapter.id) ?? [],
      capabilitiesHonest: adapters?.all().every((adapter) => Object.values(adapter.capabilities).every((value) => value === false)) ?? false,
      resolvesDeclaredAdapter: adapters?.resolveForGame({ id: 'probe', platformId: 'ps2', emulatorAdapterId: 'play-ps2' })?.adapter?.id ?? null,
      refusesUnknownAdapter: adapters?.resolveForGame({ id: 'probe', platformId: 'psx', emulatorAdapterId: 'nope' })?.reason ?? null,
      gameCount: window.ARCADE_GAME_REGISTRY?.byId?.size ?? 0,
      threeShared: Boolean(window.THREE)
    };
  });

  const expect = (condition, message) => { if (!condition) failures.push(message); };
  expect(wiring.threeShared, 'window.THREE was not shared with legacy scene code');
  expect(wiring.gameCount > 0, 'the game registry loaded no games');
  expect(wiring.adapterIds.length === 3, `expected 3 emulator adapters, saw ${wiring.adapterIds.join(', ') || 'none'}`);
  expect(wiring.capabilitiesHonest, 'an adapter claims a capability it cannot provide across its iframe boundary');
  expect(wiring.resolvesDeclaredAdapter === 'play-ps2', 'a game did not resolve the adapter it declares');
  expect(wiring.refusesUnknownAdapter === 'unknown-adapter', 'an unknown adapter was silently substituted instead of refused');

  // Entering the arcade is what actually exercises scene construction, cabinet
  // creation, and the render loop — the code paths with no unit coverage.
  await page.waitForSelector('#avatar-confirm:not([disabled])', { timeout: 30_000 });
  await page.click('#avatar-confirm');
  await page.waitForFunction(() => document.body.classList.contains('arcade-started'), { timeout: 45_000 })
    .catch(() => failures.push('the arcade never reported that it started'));
  await page.waitForTimeout(3_000);

  const running = await page.evaluate(() => ({
    emulatorActive: window.arcadeMultiplayer?.isEmulatorActive?.() ?? null,
    hasCamera: Boolean(window.arcadeMultiplayer?.getCamera?.()),
    renderScale: window.arcadeMultiplayer?.performanceProfile?.getRenderScale?.() ?? null
  }));
  expect(running.hasCamera, 'the renderer never produced a camera');
  expect(running.emulatorActive === false, 'an emulator was active without a cabinet being opened');

  if (screenshotPath) await page.screenshot({ path: screenshotPath });
  console.log(JSON.stringify({ url, wiring, running }, null, 2));
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.error(`\nbrowser smoke FAILED (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('\nbrowser smoke PASSED');
