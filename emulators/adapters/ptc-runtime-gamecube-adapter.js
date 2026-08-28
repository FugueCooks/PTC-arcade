import { RUNTIME_ADAPTER_ID } from '../ptc-runtime/protocol.js';
import { RUNTIME_FRAME_SRC, SESSION_STATES, chooseRuntimeAdapter, createRuntimeAdapter } from './ptc-runtime-adapter.js';

/**
 * GameCube through the native PTC Arcade Runtime, driving Dolphin.
 *
 * The runtime protocol itself lives in `ptc-runtime-adapter.js` and is shared
 * with PlayStation 2. What is GameCube's own is the platform it claims, the
 * emulator that has to be installed, and that its browser fallback needs a
 * desktop.
 */
export function createPtcRuntimeGameCubeAdapter({ runtime, detectRuntime } = {}) {
  return createRuntimeAdapter({
    platform: 'gamecube',
    adapterId: RUNTIME_ADAPTER_ID,
    emulatorKey: 'dolphinPresent',
    emulatorMissingReason: 'dolphin-missing',
    runtime,
    detectRuntime
  });
}

/** The runtime when it is installed and working, Gecko otherwise. */
export function chooseGameCubeAdapter({ adapters, detection, isMobileDevice = false }) {
  return chooseRuntimeAdapter({
    adapters,
    detection,
    adapterId: RUNTIME_ADAPTER_ID,
    emulatorKey: 'dolphinPresent',
    fallbackId: 'gecko-gamecube',
    // Gecko needs more memory than a phone has, and saying so here means the
    // player is told before a multi-gigabyte download rather than during it.
    fallbackNeedsDesktop: true,
    isMobileDevice,
    noAdapterReason: 'no-gamecube-adapter'
  });
}

export { RUNTIME_FRAME_SRC, SESSION_STATES };
