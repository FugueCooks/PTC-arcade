import { FRAME_SIGNALS, createCapabilities, estimateLoadTimeoutMs, platformOf, preflightAssets } from '../emulator-adapter.js';

/** Platform to EmulatorJS core name. The only place this mapping exists. */
const CORES = Object.freeze({ psx: 'psx', n64: 'n64', snes: 'snes9x', gb: 'gambatte', gbc: 'gambatte', gba: 'mgba', nds: 'melonds', nes: 'fceumm' });

export const EMULATORJS_FRAME_VERSION = 'player.html';

/**
 * Milestone 11.5 — a thin compatibility layer around the working EmulatorJS
 * setup. It reproduces the pre-Phase-11 query-string contract exactly, including
 * the `snes -> snes9x` core rename and the PSX-only BIOS parameter; this is not
 * a rewrite, and no new core is introduced.
 */
export function createEmulatorJsAdapter({ runtime } = {}) {
  return {
    id: 'emulatorjs',
    supportedPlatforms: Object.freeze(['psx', 'n64', 'snes', 'gb', 'gbc', 'gba', 'nds', 'nes']),

    // EmulatorJS runs behind an iframe that exposes none of these to us. Save
    // states and pause exist inside its own UI, but the adapter cannot drive
    // them, so it must not claim them.
    capabilities: createCapabilities(),

    /** The ROM travels in the frame URL, so there is nothing to hand over. */
    usesSourceHandshake: false,

    /**
     * Null for a platform this adapter does not cover. It used to answer 'psx'
     * for anything unrecognized, which meant a resolution bug could not fail
     * visibly: a SNES game launched on the PlayStation core and dropped the
     * player into the core's own menu with no error anywhere.
     */
    coreFor(platformId) {
      return CORES[platformId] ?? null;
    },

    /**
     * Prefetched while the player is still walking up. The PlayStation BIOS
     * joins the list only for that platform, matching what a launch will need.
     */
    warmupAssets(context = {}) {
      const targets = [['https://cdn.emulatorjs.org/stable/data/loader.js', 'script']];
      if ((context.platformId ?? context.system) === 'psx' && context.biosUrl) targets.push([context.biosUrl, 'fetch']);
      return targets;
    },

    async preflight(context) {
      return preflightAssets(context);
    },

    describeFrame(context) {
      // A hosted game names its own platform; an unassigned cabinet running a
      // local file has no game, so the cabinet's platform stands in.
      const platformId = platformOf(context.game) ?? context.platformId ?? null;
      const core = this.coreFor(platformId);
      if (!core) throw new Error(`No EmulatorJS core covers platform ${platformId ?? 'unknown'}.`);
      // The BIOS parameter is PlayStation-only, and stays empty when no BIOS is
      // configured — matching the previous behaviour of proceeding without one
      // rather than failing the launch.
      const biosUrl = core === 'psx' ? (context.biosUrl ?? '') : '';
      const gameName = context.displayName ?? 'Arcade Game';
      const parameters = new URLSearchParams({
        core,
        game: context.gameUrl ?? '',
        bios: biosUrl,
        name: gameName,
        id: String(context.emulatorContentId ?? 1)
      });
      return {
        src: `player.html?${parameters.toString()}`,
        title: `${gameName} player`,
        allow: 'autoplay; fullscreen',
        // Blob URLs this adapter caused to exist, for the host to revoke on stop.
        objectUrls: [context.gameUrl, biosUrl].filter((url) => typeof url === 'string' && url.startsWith('blob:'))
      };
    },

    /** EmulatorJS needs no source handshake: the ROM travels in the frame URL. */
    initialHandshake() {
      return null;
    },

    interpretMessage(message) {
      if (message?.type === 'arcade:emulator-ready') return { kind: FRAME_SIGNALS.READY };
      if (message?.type === 'arcade:emulator-error') return { kind: FRAME_SIGNALS.ERROR, message: 'EMULATOR COULD NOT LOAD.', detail: message.detail ?? null };
      if (message?.type === 'arcade:emulator-closed') return { kind: FRAME_SIGNALS.CLOSED, message: 'EMULATOR SESSION CLOSED.' };
      return { kind: FRAME_SIGNALS.IGNORE };
    },

    async createSession(context) {
      return {
        adapterId: this.id,
        gameId: context.game?.id ?? null,
        frame: this.describeFrame(context),
        pendingSource: null,
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
