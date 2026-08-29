import { RUNTIME_NDS_ADAPTER_ID } from '../ptc-runtime/protocol.js';
import { SESSION_STATES, chooseRuntimeAdapter, createRuntimeAdapter } from './ptc-runtime-adapter.js';

/**
 * Nintendo DS through the native PTC Arcade Runtime, driving melonDS. The
 * arena's DS Lite machines carry the DS Pokemon library, and there is no
 * browser fallback: the games run natively or the cabinet says why not.
 */
export function createPtcRuntimeNdsAdapter({ runtime, detectRuntime } = {}) {
  return createRuntimeAdapter({
    platform: 'nds',
    adapterId: RUNTIME_NDS_ADAPTER_ID,
    emulatorKey: 'melondsPresent',
    emulatorMissingReason: 'melonds-missing',
    runtime,
    detectRuntime
  });
}

/** The runtime when it is installed and working; nothing otherwise. */
export function chooseNdsAdapter({ adapters, detection }) {
  return chooseRuntimeAdapter({
    adapters,
    detection,
    adapterId: RUNTIME_NDS_ADAPTER_ID,
    emulatorKey: 'melondsPresent',
    fallbackId: 'emulatorjs',
    noAdapterReason: 'no-nds-adapter'
  });
}

export { SESSION_STATES };
