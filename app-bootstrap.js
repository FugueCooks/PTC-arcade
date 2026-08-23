import * as THREE from 'three';
import { loadGameRegistry } from './games/game-registry.js';
import { loadRoomRegistry } from './rooms/room-registry.js';

// Legacy scene code and newer ES modules now share the exact same Three.js
// instance. This avoids duplicated render state and an unnecessary 650 KB
// production download.
window.THREE = THREE;
window.ARCADE_GAME_REGISTRY = await loadGameRegistry();
window.ARCADE_ROOM_REGISTRY = await loadRoomRegistry();

await import('./arcade.js?v=production-assets-2');
await import('./avatar-selection.js?v=phase4-4');
await import('./multiplayer-client.js?v=phase6-2');
