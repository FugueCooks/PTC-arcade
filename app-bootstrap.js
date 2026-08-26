import * as THREE from 'three';
import { loadGameRegistry } from './games/game-registry.js?v=megaman-cabinet-order-1';
import { Ps2GameCache } from './games/ps2-game-cache.js?v=ps2-local-cache-1';
import { loadRoomRegistry } from './rooms/room-registry.js?v=10-rooms-1';
import { createDefaultAdapterRegistry } from './emulators/emulator-adapter-registry.js?v=adapters-1';
import { CabinetSpatialIndex } from './cabinets/cabinet-spatial-index.js?v=spatial-1';

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
// Milestone 11.15: the render loop queries this instead of measuring the
// distance to every cabinet on every frame.
window.ARCADE_CABINET_SPATIAL_INDEX = new CabinetSpatialIndex([]);

await import('./arcade.js?v=megaman-mural-layout-1');
await import('./avatar-selection.js?v=triple-t-label-2');
await import('./multiplayer-client.js?v=megaman-cabinet-order-1');
