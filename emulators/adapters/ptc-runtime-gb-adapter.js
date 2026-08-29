import { RUNTIME_GB_ADAPTER_ID } from '../ptc-runtime/protocol.js';
import { SESSION_STATES, chooseRuntimeAdapter, createRuntimeAdapter } from './ptc-runtime-adapter.js';

/**
 * The Game Boy line through the native PTC Arcade Runtime, driving
 * VisualBoyAdvance-M. One emulator covers GB, GBC and GBA, which is why one
 * adapter claims all three platforms — the Pokemon arena's Game Boy machines
 * carry the whole handheld library.
 *
 * There is no browser fallback: these games run natively or the cabinet says
 * why not, the way GameCube would without Gecko.
 */
export function createPtcRuntimeGbAdapter({ runtime, detectRuntime } = {}) {
  return createRuntimeAdapter({
    platform: 'gb',
    platforms: ['gb', 'gbc', 'gba'],
    adapterId: RUNTIME_GB_ADAPTER_ID,
    emulatorKey: 'vbaPresent',
    emulatorMissingReason: 'vba-missing',
    runtime,
    detectRuntime
  });
}

/** The runtime when it is installed and working; nothing otherwise. */
export function chooseGbAdapter({ adapters, detection }) {
  return chooseRuntimeAdapter({
    adapters,
    detection,
    adapterId: RUNTIME_GB_ADAPTER_ID,
    emulatorKey: 'vbaPresent',
    fallbackId: null,
    noAdapterReason: 'runtime-required'
  });
}

export { SESSION_STATES };
