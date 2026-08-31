import * as THREE from 'three';
import { loadGameRegistry } from './games/game-registry.js?v=poke-7';
import { Ps2GameCache } from './games/ps2-game-cache.js?v=ps2-local-cache-1';
import { loadRoomRegistry } from './rooms/room-registry.js?v=10-rooms-1';
import { createDefaultAdapterRegistry } from './emulators/emulator-adapter-registry.js?v=poke-7';
import { CabinetSpatialIndex } from './cabinets/cabinet-spatial-index.js?v=spatial-1';
import { createPtcRuntimeGameCubeAdapter, chooseGameCubeAdapter } from './emulators/adapters/ptc-runtime-gamecube-adapter.js?v=runtime-1';
import { createPtcRuntimePs2Adapter, choosePs2Adapter } from './emulators/adapters/ptc-runtime-ps2-adapter.js?v=runtime-1';
import { createPtcRuntimeGbAdapter, chooseGbAdapter } from './emulators/adapters/ptc-runtime-gb-adapter.js?v=runtime-1';
import { createPtcRuntimeNdsAdapter, chooseNdsAdapter } from './emulators/adapters/ptc-runtime-nds-adapter.js?v=runtime-1';
import { RuntimeClient } from './emulators/ptc-runtime/runtime-client.js?v=runtime-1';

// Legacy scene code and newer ES modules now share the exact same Three.js
// instance. This avoids duplicated render state and an unnecessary 650 KB
// production download.
window.THREE = THREE;
window.ARCADE_GAME_REGISTRY = await loadGameRegistry();
window.ARCADE_ROOM_REGISTRY = await loadRoomRegistry();
window.ARCADE_PS2_CACHE = new Ps2GameCache();
// Milestone 11.4: one adapter registry for the page. Registration validates each
// adapter's declaration, so a misdeclared core fails here at startup rather than
// when a player walks up to a cabinet.
window.ARCADE_EMULATOR_ADAPTERS = createDefaultAdapterRegistry();
// GameCube can run natively through the PTC Arcade Runtime. The adapter is
// always registered; whether it is chosen depends on the probe below.
window.ARCADE_EMULATOR_ADAPTERS.register(createPtcRuntimeGameCubeAdapter());
window.ARCADE_CHOOSE_GAMECUBE_ADAPTER = chooseGameCubeAdapter;
// PlayStation 2 the same way. The browser core holds about 40 f/s on the
// demanding titles, so a player with the runtime installed gets PCSX2 while
// everyone else stays on Play! — including on a phone, which Gecko cannot do.
window.ARCADE_EMULATOR_ADAPTERS.register(createPtcRuntimePs2Adapter());
window.ARCADE_CHOOSE_PS2_ADAPTER = choosePs2Adapter;
// The handhelds run natively or not at all: VBA-M carries the Game Boy line
// and melonDS carries the DS library, both through the runtime.
window.ARCADE_EMULATOR_ADAPTERS.register(createPtcRuntimeGbAdapter());
window.ARCADE_CHOOSE_GB_ADAPTER = chooseGbAdapter;
window.ARCADE_EMULATOR_ADAPTERS.register(createPtcRuntimeNdsAdapter());
window.ARCADE_CHOOSE_NDS_ADAPTER = chooseNdsAdapter;
window.ARCADE_RUNTIME_CLIENT = new RuntimeClient();
window.ARCADE_RUNTIME_DETECTION = null;

/**
 * Probes for the runtime, once, and only when it could matter.
 *
 * Not run at startup on purpose. A browser cannot fetch a closed port quietly —
 * every refused connection prints a network error the page has no way to
 * suppress — so probing on load would put four red lines in the console of
 * every player who has no runtime installed, which is most of them. Nothing in
 * this session has been harder than telling a real console error from noise,
 * and permanent noise is how that starts.
 *
 * So the probe waits until a player walks up to a GameCube cabinet. They then
 * see it once, and only if they were going to play a GameCube game anyway.
 */
window.ARCADE_ENSURE_RUNTIME_DETECTION = () => {
  window.ARCADE_RUNTIME_DETECTION ??= { present: false, pending: true };
  // Kept as a promise too. The choice of adapter reads the resolved value, and
  // a player who presses play before the probe answers would otherwise be given
  // the browser core on the grounds that nothing had replied yet.
  window.ARCADE_RUNTIME_DETECTION_PROMISE ??= window.ARCADE_RUNTIME_CLIENT.detect().then((detection) => {
    window.ARCADE_RUNTIME_DETECTION = detection;
    if (detection?.usable) console.info('[arcade] PTC Arcade Runtime detected.', detection);
    else console.info('[arcade] No PTC Arcade Runtime; games run in the browser.', detection);
    return detection;
  }).catch((error) => {
    console.info('[arcade] The runtime probe failed; games run in the browser.', error);
    return (window.ARCADE_RUNTIME_DETECTION = { present: false, reason: String(error?.message ?? error) });
  });
  return window.ARCADE_RUNTIME_DETECTION_PROMISE;
};
// Milestone 11.15: the render loop queries this instead of measuring the
// distance to every cabinet on every frame.
window.ARCADE_CABINET_SPATIAL_INDEX = new CabinetSpatialIndex([]);

await import('./arcade.js?v=reveal-1');
await import('./avatar-selection.js?v=triple-t-label-2');
await import('./multiplayer-client.js?v=reveal-1');
