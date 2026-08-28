import { assertValidAdapter, platformOf } from './emulator-adapter.js';
import { createEmulatorJsAdapter } from './adapters/emulatorjs-adapter.js';
import { createPlayPs2Adapter } from './adapters/play-ps2-adapter.js?v=rooms-2';
import { createGeckoGameCubeAdapter } from './adapters/gecko-gamecube-adapter.js';

/**
 * Milestone 11.4 — adapter lookup by ID, with platform coverage as a secondary
 * index. Registration validates the adapter's declaration, so a malformed or
 * duplicate adapter is refused at startup rather than at a cabinet.
 */
export class EmulatorAdapterRegistry {
  #byId = new Map();
  #byPlatform = new Map();

  register(adapter) {
    assertValidAdapter(adapter);
    if (this.#byId.has(adapter.id)) throw new Error(`Duplicate emulator adapter: ${adapter.id}`);
    this.#byId.set(adapter.id, adapter);
    for (const platform of adapter.supportedPlatforms) {
      const bucket = this.#byPlatform.get(platform);
      if (bucket) bucket.push(adapter);
      else this.#byPlatform.set(platform, [adapter]);
    }
    return adapter;
  }

  get size() { return this.#byId.size; }

  get(adapterId) { return this.#byId.get(adapterId); }

  has(adapterId) { return this.#byId.has(adapterId); }

  all() { return [...this.#byId.values()]; }

  forPlatform(platformId) { return this.#byPlatform.get(platformId) ?? []; }

  /**
   * Resolves the adapter a game declares. Falls back to platform coverage only
   * when a game names no adapter; an adapter that is named but missing is an
   * error, never a silent substitution — a player would otherwise get the wrong
   * core with no indication anything went wrong.
   */
  resolveForGame(game) {
    if (!game) return { ok: false, reason: 'unknown-game' };
    if (game.emulatorAdapterId) {
      const adapter = this.#byId.get(game.emulatorAdapterId);
      if (!adapter) return { ok: false, reason: 'unknown-adapter', adapterId: game.emulatorAdapterId };
      if (!adapter.supportedPlatforms.includes(platformOf(game))) {
        return { ok: false, reason: 'platform-unsupported', adapterId: adapter.id };
      }
      return { ok: true, adapter };
    }
    const [fallback] = this.forPlatform(platformOf(game));
    return fallback ? { ok: true, adapter: fallback } : { ok: false, reason: 'unknown-adapter' };
  }
}

/** The three backends the arcade ships today. No new core is introduced. */
export function createDefaultAdapterRegistry(options = {}) {
  const registry = new EmulatorAdapterRegistry();
  registry.register(createEmulatorJsAdapter(options));
  registry.register(createPlayPs2Adapter(options));
  registry.register(createGeckoGameCubeAdapter(options));
  return registry;
}
