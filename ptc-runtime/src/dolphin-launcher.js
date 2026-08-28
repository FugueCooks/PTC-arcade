import { spawn } from 'node:child_process';
import { FAILURE_REASONS } from '../../emulators/ptc-runtime/protocol.js';
import { buildDolphinArgs, locateDolphin } from './dolphin.js';
import { NativeEmulatorLauncher } from './native-launcher.js';

/**
 * Dolphin, for GameCube.
 *
 * The spawning, the window heuristic, the exit interpretation and the shutdown
 * grace period are shared with the PlayStation 2 launcher and live in
 * `NativeEmulatorLauncher`. What is Dolphin's own is its argument list, where
 * it is installed, and the reason a launch gives when it is not.
 */
export class DolphinLauncher extends NativeEmulatorLauncher {
  constructor({ dolphinPath, userDirectory, spawnImpl = spawn, now = () => Date.now() }) {
    super({
      binaryPath: dolphinPath,
      buildArgs: ({ imagePath }) => buildDolphinArgs({ imagePath, userDirectory }),
      missingReason: FAILURE_REASONS.DOLPHIN_MISSING,
      spawnImpl,
      now
    });
  }

  static discover({ platform = process.platform, configuredPath = null, exists }) {
    return locateDolphin({ platform, configuredPath, exists });
  }
}
