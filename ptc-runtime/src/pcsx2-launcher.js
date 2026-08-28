import { spawn } from 'node:child_process';
import { FAILURE_REASONS } from '../../emulators/ptc-runtime/protocol.js';
import { NativeEmulatorLauncher } from './native-launcher.js';
import { buildPcsx2Args, locatePcsx2 } from './pcsx2.js';

/**
 * PCSX2, for PlayStation 2.
 *
 * Same shape as the Dolphin launcher, and for the same reason: two emulators
 * launched two different ways would be two things to reason about when a
 * launch fails. Only the arguments, the install locations and the missing
 * reason differ.
 */
export class Pcsx2Launcher extends NativeEmulatorLauncher {
  constructor({ pcsx2Path, spawnImpl = spawn, now = () => Date.now() }) {
    super({
      binaryPath: pcsx2Path,
      buildArgs: ({ imagePath }) => buildPcsx2Args({ imagePath }),
      missingReason: FAILURE_REASONS.PCSX2_MISSING,
      spawnImpl,
      now
    });
  }

  static discover({ platform = process.platform, configuredPath = null, exists }) {
    return locatePcsx2({ platform, configuredPath, exists });
  }
}
