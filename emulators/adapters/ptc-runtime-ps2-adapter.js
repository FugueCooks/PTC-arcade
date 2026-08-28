import { RUNTIME_PS2_ADAPTER_ID } from '../ptc-runtime/protocol.js';
import { SESSION_STATES, chooseRuntimeAdapter, createRuntimeAdapter } from './ptc-runtime-adapter.js';

/**
 * PlayStation 2 through the native PTC Arcade Runtime, driving PCSX2.
 *
 * The browser core plays some PS2 titles well and others badly: Mega Man X7
 * holds a median of 40 f/s in Play! with dips into the twenties, and that is
 * the core's speed rather than anything caching reaches. So PS2 takes the same
 * route GameCube already does, and a player with the runtime installed gets a
 * native emulator while the arcade still owns the cabinet and the session.
 */
export function createPtcRuntimePs2Adapter({ runtime, detectRuntime } = {}) {
  return createRuntimeAdapter({
    platform: 'ps2',
    adapterId: RUNTIME_PS2_ADAPTER_ID,
    emulatorKey: 'pcsx2Present',
    emulatorMissingReason: 'pcsx2-missing',
    runtime,
    detectRuntime
  });
}

/**
 * The runtime when it is installed and working, Play! otherwise.
 *
 * Unlike Gecko, the browser PS2 core runs on a phone — the touch controls exist
 * for it — so there is no desktop gate here. A player on a phone gets Play!
 * rather than nothing.
 */
export function choosePs2Adapter({ adapters, detection }) {
  return chooseRuntimeAdapter({
    adapters,
    detection,
    adapterId: RUNTIME_PS2_ADAPTER_ID,
    emulatorKey: 'pcsx2Present',
    fallbackId: 'play-ps2',
    noAdapterReason: 'no-ps2-adapter'
  });
}

export { SESSION_STATES };
