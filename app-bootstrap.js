import * as THREE from 'three';
import { loadGameRegistry } from './games/game-registry.js?v=psx-multidisc-1';
import { Ps2GameCache } from './games/ps2-game-cache.js?v=ps2-local-cache-1';
import { loadRoomRegistry } from './rooms/room-registry.js?v=10-rooms-1';

// Legacy scene code and newer ES modules now share the exact same Three.js
// instance. This avoids duplicated render state and an unnecessary 650 KB
// production download.
window.THREE = THREE;
window.ARCADE_GAME_REGISTRY = await loadGameRegistry();
window.ARCADE_ROOM_REGISTRY = await loadRoomRegistry();
window.ARCADE_PS2_CACHE = new Ps2GameCache();

await import('./arcade.js?v=cabinet-art-2');
await import('./avatar-selection.js?v=phase8-username-1');
await import('./multiplayer-client.js?v=n64-wall-panels-removed-3');
