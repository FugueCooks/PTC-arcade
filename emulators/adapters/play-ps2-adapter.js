import { FRAME_SIGNALS, createCapabilities, estimateLoadTimeoutMs, preflightAssets } from '../emulator-adapter.js';

export const PLAY_FRAME_SRC = 'emulators/play/index.html?v=garden-15x-1';

/**
 * Milestone 11.5 — thin wrapper around the existing experimental Play! PS2 core.
 *
 * Unlike EmulatorJS this backend takes no ROM in its URL: the frame boots empty,
 * announces itself, and only then receives the source over postMessage. That
 * two-step handshake is the reason `pendingSource` exists on the session.
 */
export function createPlayPs2Adapter({ runtime } = {}) {
  return {
    id: 'play-ps2',
    supportedPlatforms: Object.freeze(['ps2']),

    // Experimental core behind an opaque iframe: nothing is exposed to us.
    capabilities: createCapabilities(),

    /** The frame boots empty and receives its source over postMessage. */
    usesSourceHandshake: true,

    /** The wasm core is the long pole; prefetch it before the disc is chosen. */
    warmupAssets() {
      return [
        ['emulators/play/Play.wasm', 'fetch'],
        ['emulators/play/Play.js', 'script'],
        ['emulators/play/main.js', 'script']
      ];
    },

    async preflight(context) {
      return preflightAssets(context);
    },

    describeFrame(context) {
      return {
        src: PLAY_FRAME_SRC,
        title: `${context.displayName ?? 'Arcade Game'} player`,
        allow: 'autoplay; fullscreen',
        objectUrls: []
      };
    },

    /**
     * A local file is handed over directly; a hosted image is fetched by the
     * frame from its URL. The name is recovered from the URL path so the core
     * can pick a disc reader by extension.
     */
    initialHandshake(context) {
      const source = context.localFile
        ? { type: 'arcade:ps2-load-file', file: context.localFile }
        : {
          type: 'arcade:ps2-load-remote',
          url: context.gameUrl,
          name: fileNameFromUrl(context.gameUrl, context.displayName, 'iso', context.baseUrl),
          size: context.downloadBytes
        };
      return source;
    },

    interpretMessage(message) {
      if (message?.type === 'arcade:emulator-ready' && message?.core === 'ps2-play') return { kind: FRAME_SIGNALS.READY, needsSource: true };
      if (message?.type === 'arcade:ps2-source-accepted') return { kind: FRAME_SIGNALS.SOURCE_ACCEPTED };
      if (message?.type === 'arcade:ps2-disc-error') return { kind: FRAME_SIGNALS.ERROR, message: 'GAME STREAM INTERRUPTED. RETRY OR CACHE IT LOCALLY.' };
      if (message?.type === 'arcade:emulator-error') return { kind: FRAME_SIGNALS.ERROR, message: 'EMULATOR COULD NOT LOAD.', detail: message.detail ?? null };
      if (message?.type === 'arcade:emulator-closed') return { kind: FRAME_SIGNALS.CLOSED, message: 'EMULATOR SESSION CLOSED.' };
      return { kind: FRAME_SIGNALS.IGNORE };
    },

    async createSession(context) {
      return {
        adapterId: this.id,
        gameId: context.game?.id ?? null,
        frame: this.describeFrame(context),
        pendingSource: this.initialHandshake(context),
        timeoutMs: estimateLoadTimeoutMs(context.downloadBytes),
        runtimeHandle: null
      };
    },

    async start(session) {
      session.runtimeHandle = await (runtime ?? session.runtime).mount(session);
    },

    async stop(session) {
      await (runtime ?? session.runtime)?.terminate?.(session);
    },

    async dispose(session) {
      await (runtime ?? session.runtime)?.release?.(session);
    }
  };
}

/**
 * Shared by both wasm adapters. Both cores dispatch on the file extension, so a
 * recovered segment without one is worse than useless — it silently picks the
 * wrong disc reader. Anything that does not look like `name.ext` falls back to a
 * name built from the game title instead.
 */
export function fileNameFromUrl(url, displayName, extension, baseUrl) {
  const fallback = `${displayName ?? 'game'}.${extension}`;
  if (typeof url !== 'string' || url === '') return fallback;
  try {
    const resolved = new URL(url, baseUrl ?? 'https://arcade.invalid/');
    const segment = decodeURIComponent(resolved.pathname.split('/').pop() ?? '');
    return /^[^/\\]+\.[A-Za-z0-9]{1,8}$/.test(segment) ? segment : fallback;
  } catch {
    return fallback;
  }
}
