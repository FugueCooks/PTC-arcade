import * as THREE from 'three';
import { loadGameRegistry } from './games/game-registry.js?v=ps2-hosted-2';
import { loadRoomRegistry } from './rooms/room-registry.js?v=10-rooms-1';

// Legacy scene code and newer ES modules now share the exact same Three.js
// instance. This avoids duplicated render state and an unnecessary 650 KB
// production download.
window.THREE = THREE;
window.ARCADE_GAME_REGISTRY = await loadGameRegistry();
window.ARCADE_ROOM_REGISTRY = await loadRoomRegistry();

await import('./arcade.js?v=ps2-performance-1');
await import('./avatar-selection.js?v=text-only-1');
await import('./multiplayer-client.js?v=ps2-performance-1');
