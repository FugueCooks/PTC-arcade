import { spawn } from 'node:child_process';
import { FAILURE_REASONS } from '../../emulators/ptc-runtime/protocol.js';
import { NativeEmulatorLauncher } from './native-launcher.js';
import { buildMelondsArgs, locateMelonds } from './melonds.js';

/**
 * melonDS, for Nintendo DS. Same shape as the Dolphin and PCSX2 launchers,
 * and for the same reason: emulators launched different ways would be
 * different things to reason about when a launch fails.
 */
export class MelondsLauncher extends NativeEmulatorLauncher {
  constructor({ melondsPath, spawnImpl = spawn, now = () => Date.now() }) {
    super({
      binaryPath: melondsPath,
      buildArgs: ({ imagePath }) => buildMelondsArgs({ imagePath }),
      missingReason: FAILURE_REASONS.MELONDS_MISSING,
      spawnImpl,
      now
    });
  }

  static discover({ platform = process.platform, configuredPath = null, exists }) {
    return locateMelonds({ platform, configuredPath, exists });
  }
}
