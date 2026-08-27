import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInstallSecret } from './security.js';
import { createRuntimeServer } from './server.js';
import { DiskLibrary } from './disk-library.js';
import { DolphinLauncher } from './dolphin-launcher.js';
import { LaunchGuard } from './dolphin.js';
import { SessionManager } from './session-manager.js';
import { catalogUrlFor, parseCatalog } from './library.js';

const VERSION = '0.1.0';
const ARCADE_ORIGIN = process.env.PTC_ARCADE_ORIGIN ?? 'https://ptcarcade.fun';

/**
 * The runtime, assembled.
 *
 * Configuration and the install secret live under the user's own data
 * directory; games live beside them. Nothing here is installed system-wide, and
 * nothing runs as a service — the runtime is a program the player starts, which
 * keeps its lifetime and its permissions the player's to reason about.
 */
function runtimeHome() {
  const base = process.platform === 'win32'
    ? (process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'))
    : path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'PTCArcadeRuntime');
}

function loadConfig(home) {
  mkdirSync(home, { recursive: true });
  const configPath = path.join(home, 'config.json');
  let config = {};
  if (existsSync(configPath)) {
    try { config = JSON.parse(readFileSync(configPath, 'utf8')); } catch { config = {}; }
  }
  if (typeof config.installSecret !== 'string' || config.installSecret.length < 32) {
    config.installSecret = createInstallSecret();
    // Written with a restrictive mode: this secret is what makes a paired token
    // verifiable, so another user on the machine must not be able to read it.
    writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  }
  return { config, configPath };
}

/** Fetches the catalogue from the arcade. Refreshed on start and on a miss. */
async function loadCatalog(origin, log) {
  const resolved = catalogUrlFor(origin);
  if (!resolved.ok) { log('catalog_refused', { reason: resolved.reason }); return new Map(); }
  try {
    const response = await fetch(resolved.url, { headers: { accept: 'application/json' } });
    if (!response.ok) { log('catalog_unavailable', { status: response.status }); return new Map(); }
    const parsed = parseCatalog(await response.json());
    if (parsed.rejected.length > 0) log('catalog_entries_rejected', { rejected: parsed.rejected });
    log('catalog_loaded', { count: parsed.entries.size });
    return parsed.entries;
  } catch (error) {
    log('catalog_failed', { message: error?.message ?? 'unknown' });
    return new Map();
  }
}

export async function startRuntime({ origin = ARCADE_ORIGIN, log = consoleLog } = {}) {
  const home = runtimeHome();
  const { config } = loadConfig(home);
  const libraryRoot = config.libraryRoot ?? path.join(home, 'games');

  const discovered = DolphinLauncher.discover({ configuredPath: config.dolphinPath ?? null, exists: existsSync });
  if (!discovered.ok) log('dolphin_not_found', { reason: discovered.reason });
  else log('dolphin_found', { path: discovered.path, source: discovered.source });

  let catalog = await loadCatalog(origin, log);

  const sessions = new SessionManager({
    catalog: { get: (gameId) => catalog.get(gameId) },
    library: new DiskLibrary({ root: libraryRoot }),
    launcher: new DolphinLauncher({
      dolphinPath: discovered.ok ? discovered.path : null,
      userDirectory: path.join(home, 'dolphin-user')
    }),
    guard: new LaunchGuard(),
    log
  });

  const sweeper = setInterval(() => sessions.sweep(), 60_000);
  if (typeof sweeper.unref === 'function') sweeper.unref();

  const runtime = createRuntimeServer({
    sessions,
    installSecret: config.installSecret,
    version: VERSION,
    dolphinAvailable: () => discovered.ok,
    // Printed where only somebody at this machine can read it. That is the
    // entire reason a background page cannot pair itself.
    onPairingCode: (code) => {
      log('pairing_code', {});
      process.stdout.write(`\n  ┌────────────────────────────────┐\n`
        + `  │  PAIRING CODE:  ${code}       │\n`
        + `  │  Type this into the arcade.    │\n`
        + `  └────────────────────────────────┘\n\n`);
    },
    log
  });

  const bound = await runtime.listen();
  if (!bound.ok) { log('listen_failed', { reason: bound.reason }); return { ok: false, reason: bound.reason }; }
  log('runtime_started', { port: bound.port, version: VERSION, libraryRoot, origin });

  // A catalogue fetched once at start goes stale as the arcade adds cabinets.
  const refresh = setInterval(async () => { catalog = await loadCatalog(origin, log); }, 30 * 60_000);
  if (typeof refresh.unref === 'function') refresh.unref();

  return { ok: true, port: bound.port, close: () => runtime.close() };
}

function consoleLog(event, details = {}) {
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), event, ...details })}\n`);
}

// Started directly rather than imported: this is the program the player runs.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const started = await startRuntime();
  if (!started.ok) process.exitCode = 1;
}
