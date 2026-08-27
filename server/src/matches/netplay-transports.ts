import { NetplayTransportRegistry, type NetplayTransport } from './netplay.js';

/**
 * What each console family can actually do about netplay.
 *
 * Each entry is a claim the arcade makes to players, so each is written to be
 * true rather than encouraging. A transport that overstates itself produces the
 * worst possible outcome here: four people sit down, the arcade says the match
 * is starting, and they spend ten minutes discovering they are playing alone.
 */

/**
 * GameCube, through Dolphin.
 *
 * Assisted, not full. Dolphin exposes no netplay command line — its whole
 * option list is user, movie, exec, nand_title, config, save_state, debugger,
 * logger, batch, confirm, video_backend and audio_emulation — so the runtime
 * fills in every field through `--config` and the player presses one button.
 */
export const DOLPHIN_TRANSPORT: NetplayTransport = Object.freeze({
  id: 'dolphin-netplay',
  supportedPlatforms: Object.freeze(['gamecube']),
  automation: 'assisted',
  playerInstruction: 'Dolphin will open with your connection details already filled in. '
    + 'Open Netplay and press Host if you are player one, or Connect if you are not.'
});

/**
 * PlayStation, Nintendo 64 and SNES, through EmulatorJS.
 *
 * The cores are RetroArch's and RetroArch has netplay, but the EmulatorJS build
 * the arcade loads from the CDN is not configured for it and the browser has no
 * way to open a listening socket. Declared as none rather than left out, so the
 * arcade says "you will be playing separate games" instead of saying nothing.
 */
export const EMULATORJS_TRANSPORT: NetplayTransport = Object.freeze({
  id: 'emulatorjs-none',
  supportedPlatforms: Object.freeze(['psx', 'n64', 'snes']),
  automation: 'none',
  playerInstruction: null
});

/**
 * PlayStation 2, through Play!.
 *
 * Play! has no netplay at all. Same reasoning as above: stated, not omitted.
 */
export const PLAY_PS2_TRANSPORT: NetplayTransport = Object.freeze({
  id: 'play-ps2-none',
  supportedPlatforms: Object.freeze(['ps2']),
  automation: 'none',
  playerInstruction: null
});

export function createDefaultTransportRegistry(): NetplayTransportRegistry {
  const registry = new NetplayTransportRegistry();
  registry.register(DOLPHIN_TRANSPORT);
  registry.register(EMULATORJS_TRANSPORT);
  registry.register(PLAY_PS2_TRANSPORT);
  return registry;
}

/**
 * Whether a platform can genuinely put players in one game.
 *
 * The arcade asks this before letting a game declare more than one seat, so a
 * four-seat cabinet on a platform that cannot connect anybody is caught in the
 * suite rather than by four disappointed players.
 */
export function canConnectPlayers(registry: NetplayTransportRegistry, platformId: string): boolean {
  return registry.forPlatform(platformId)?.automation !== 'none';
}
