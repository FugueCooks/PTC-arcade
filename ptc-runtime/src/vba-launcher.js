import { spawn } from 'node:child_process';
import { FAILURE_REASONS } from '../../emulators/ptc-runtime/protocol.js';
import { NativeEmulatorLauncher } from './native-launcher.js';
import { buildVbaArgs, locateVba } from './vba.js';

/**
 * VisualBoyAdvance-M, for the whole Game Boy line. Same shape as the Dolphin
 * and PCSX2 launchers, and for the same reason: emulators launched different
 * ways would be different things to reason about when a launch fails.
 */
export class VbaLauncher extends NativeEmulatorLauncher {
  constructor({ vbaPath, spawnImpl = spawn, now = () => Date.now() }) {
    super({
      binaryPath: vbaPath,
      buildArgs: ({ imagePath }) => buildVbaArgs({ imagePath }),
      missingReason: FAILURE_REASONS.VBA_MISSING,
      spawnImpl,
      now
    });
  }

  static discover({ platform = process.platform, configuredPath = null, exists }) {
    return locateVba({ platform, configuredPath, exists });
  }
}
