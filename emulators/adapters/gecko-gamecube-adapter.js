import { FRAME_SIGNALS, createCapabilities, estimateLoadTimeoutMs, preflightAssets } from '../emulator-adapter.js';
import { fileNameFromUrl } from './play-ps2-adapter.js?v=ps2-diag-1';

export const GECKO_FRAME_SRC = 'emulators/gecko/index.html?v=gecko-hosted-clean-1';

/**
 * Milestone 11.5 — thin wrapper around the existing experimental Gecko WebGPU
 * GameCube core. Like Play!, it boots empty and receives its source over
 * postMessage; unlike Play!, it also needs the DSP firmware URL and reports
 * download progress, which the launcher surfaces to the player.
 */
export function createGeckoGameCubeAdapter({ runtime } = {}) {
  return {
    id: 'gecko-gamecube',
    supportedPlatforms: Object.freeze(['gamecube']),

    capabilities: createCapabilities(),

    /** The frame boots empty and receives its source over postMessage. */
    usesSourceHandshake: true,

    /** The wasm core is the long pole; prefetch it before the disc is chosen. */
    warmupAssets() {
      return [
        ['emulators/gecko/pkg/web_bg.wasm', 'fetch'],
        ['emulators/gecko/pkg/web.js', 'script'],
        ['emulators/gecko/main.js', 'script']
      ];
    },

    async preflight(context) {
      const assets = preflightAssets(context);
      if (!assets.ok) return assets;
      // Desktop-only, as shipped: the core needs more memory than a phone has.
      // Reported as a preflight refusal rather than a crash midway through a
      // multi-gigabyte download.
      if (context.isMobileDevice) return { ok: false, reason: 'desktop-only', missingAssets: [] };
      return { ok: true, missingAssets: [] };
    },

    describeFrame(context) {
      return {
        src: GECKO_FRAME_SRC,
        title: `${context.displayName ?? 'Arcade Game'} player`,
        allow: 'autoplay; fullscreen',
        objectUrls: []
      };
    },

    initialHandshake(context) {
      return context.localFile
        ? { type: 'arcade:gamecube-load-file', file: context.localFile, name: context.localFile.name, dspUrl: context.dspUrl }
        : {
          type: 'arcade:gamecube-load-remote',
          url: context.gameUrl,
          name: fileNameFromUrl(context.gameUrl, context.displayName, 'rvz', context.baseUrl),
          size: context.downloadBytes,
          dspUrl: context.dspUrl
        };
    },

    interpretMessage(message) {
      if (message?.type === 'arcade:emulator-ready' && message?.core === 'gamecube-gecko') return { kind: FRAME_SIGNALS.READY, needsSource: true };
      if (message?.type === 'arcade:gamecube-source-accepted') return { kind: FRAME_SIGNALS.SOURCE_ACCEPTED };
      if (message?.type === 'arcade:gamecube-source-loading') return { kind: FRAME_SIGNALS.SOURCE_LOADING };
      if (message?.type === 'arcade:gamecube-load-progress' && Number.isFinite(message?.percent)) {
        return { kind: FRAME_SIGNALS.PROGRESS, percent: message.percent };
      }
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
