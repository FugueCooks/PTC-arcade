import { FRAME_SIGNALS, createCapabilities, estimateLoadTimeoutMs, platformOf } from '../emulator-adapter.js';
import { FRAME_MESSAGES, RUNTIME_ADAPTER_ID, SESSION_STATES } from '../ptc-runtime/protocol.js';

export const RUNTIME_FRAME_SRC = 'emulators/ptc-runtime/session.html?v=runtime-1';

/**
 * GameCube through the native PTC Arcade Runtime.
 *
 * The emulator runs outside the browser, but this is still an ordinary adapter
 * presenting an ordinary frame — and that is deliberate. The arcade's session
 * machinery already tracks which cabinet a player holds, when a session began,
 * when it ended, and tells the other players in the room. Bypassing the frame
 * to launch a native process directly would leave the player standing at a
 * cabinet the server thinks is free while Dolphin runs behind the browser.
 *
 * So the frame stays, showing progress and a way back, while Dolphin has the
 * player's screen. The cabinet is released when the frame reports the session
 * closed, exactly as it is for a browser core.
 */
export function createPtcRuntimeGameCubeAdapter({ runtime, detectRuntime } = {}) {
  return {
    id: RUNTIME_ADAPTER_ID,
    supportedPlatforms: Object.freeze(['gamecube']),

    /**
     * Native Dolphin can do all of this; this adapter cannot drive it. Claiming
     * a capability the adapter has no way to invoke would have the launcher
     * offering the player a save-state button that does nothing.
     */
    capabilities: createCapabilities(),

    /** The frame is told which game to ask the runtime for, over postMessage. */
    usesSourceHandshake: true,

    /**
     * Nothing to warm. The download is the runtime's, and it caches between
     * launches — prefetching anything here would duplicate a gigabyte the
     * runtime already holds.
     */
    warmupAssets() {
      return [];
    },

    /**
     * Refuses before a cabinet commits, so a player without the runtime is
     * offered the browser fallback rather than a frame that cannot start.
     */
    async preflight(context) {
      const platformId = platformOf(context.game) ?? context.platformId ?? null;
      if (!this.supportedPlatforms.includes(platformId)) {
        return { ok: false, reason: 'unsupported-platform', missingAssets: [] };
      }
      const detect = detectRuntime ?? context.detectRuntime;
      if (typeof detect !== 'function') return { ok: false, reason: 'runtime-absent', missingAssets: [] };

      const detection = await detect();
      if (!detection?.present) return { ok: false, reason: 'runtime-absent', missingAssets: [] };
      if (!detection.usable) return { ok: false, reason: detection.reason ?? 'runtime-unusable', missingAssets: [] };
      if (detection.dolphinPresent === false) return { ok: false, reason: 'dolphin-missing', missingAssets: [] };
      return { ok: true, missingAssets: [] };
    },

    describeFrame(context) {
      return {
        src: RUNTIME_FRAME_SRC,
        title: `${context.displayName ?? 'Arcade Game'} runtime session`,
        allow: '',
        // No blob is minted: the bytes never pass through the browser.
        objectUrls: []
      };
    },

    /**
     * The id, never a URL.
     *
     * The browser holds a signed hosted URL for this game and it would be the
     * obvious thing to pass. It is not passed, because a frame that can hand
     * the runtime a URL is a frame that can hand it any URL, and the runtime
     * would then be downloading whatever a compromised page told it to.
     */
    initialHandshake(context) {
      return {
        type: 'arcade:runtime-launch',
        gameId: context.game?.id ?? null,
        platformId: platformOf(context.game) ?? context.platformId ?? null,
        cabinetId: context.cabinetId ?? null,
        displayName: context.displayName ?? 'Arcade Game'
      };
    },

    interpretMessage(message) {
      if (message?.type === FRAME_MESSAGES.READY) return { kind: FRAME_SIGNALS.READY, needsSource: true };
      if (message?.type === FRAME_MESSAGES.PROGRESS && Number.isFinite(message?.percent)) {
        return { kind: FRAME_SIGNALS.PROGRESS, percent: message.percent };
      }
      if (message?.type === FRAME_MESSAGES.RUNNING) return { kind: FRAME_SIGNALS.SOURCE_ACCEPTED };
      if (message?.type === FRAME_MESSAGES.ERROR) {
        return { kind: FRAME_SIGNALS.ERROR, message: 'THE ARCADE RUNTIME COULD NOT START THIS GAME.', detail: message.detail ?? null };
      }
      if (message?.type === FRAME_MESSAGES.CLOSED) {
        return { kind: FRAME_SIGNALS.CLOSED, message: 'RUNTIME SESSION CLOSED.' };
      }
      return { kind: FRAME_SIGNALS.IGNORE };
    },

    async createSession(context) {
      return {
        adapterId: this.id,
        gameId: context.game?.id ?? null,
        frame: this.describeFrame(context),
        pendingSource: this.initialHandshake(context),
        // A first launch downloads the image before anything appears, and a
        // GameCube image is large enough that the browser-core timeout would
        // fire mid-download. The runtime reports progress throughout, so the
        // launcher has evidence of life; this only bounds a silent session.
        timeoutMs: Math.max(estimateLoadTimeoutMs(context.downloadBytes), 300_000),
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
 * Which adapter should run a GameCube cabinet for this player.
 *
 * The runtime when it is installed and working, Gecko otherwise. Expressed as
 * one function because the choice is per-player rather than per-game: the same
 * cabinet is native for someone with the runtime and experimental for someone
 * without, and the registry cannot know which.
 */
export async function chooseGameCubeAdapter({ adapters, detect, isMobileDevice = false }) {
  const runtimeAdapter = adapters.get(RUNTIME_ADAPTER_ID);
  if (runtimeAdapter && typeof detect === 'function') {
    const detection = await detect();
    if (detection?.present && detection.usable && detection.dolphinPresent !== false) {
      return { adapter: runtimeAdapter, reason: 'runtime-available' };
    }
  }
  const fallback = adapters.get('gecko-gamecube');
  if (!fallback) return { adapter: null, reason: 'no-gamecube-adapter' };
  // Gecko needs more memory than a phone has, and saying so here means the
  // player is told before a multi-gigabyte download rather than during it.
  if (isMobileDevice) return { adapter: null, reason: 'desktop-only' };
  return { adapter: fallback, reason: 'runtime-absent' };
}

export { SESSION_STATES };
