import assert from 'node:assert/strict';
import test from 'node:test';
import { loadServerConfig } from '../server/src/config.js';
import { createLogger } from '../server/src/logging/logger.js';
import { RuntimeMetrics } from '../server/src/metrics/metrics.js';
import { InMemoryRoomAdmission } from '../server/src/rooms/room-admission.js';
import { InMemoryRoomDirectory } from '../server/src/rooms/room-directory.js';
import { RoomLifecycleService } from '../server/src/rooms/room-lifecycle-service.js';
import { RoomManager } from '../server/src/rooms/room-manager.js';
import { RoomPlacementService } from '../server/src/rooms/room-placement-service.js';

const config = { id: 'main', name: 'Main Arcade', capacity: 2, spawnSeparation: 1, spawnPoints: [{ x: 0, y: 1.65, z: 0, rotationY: 0 }] };

function runtimeMetrics(): RuntimeMetrics {
  return new RuntimeMetrics({ connectedSockets: () => 0, activePlayers: () => 0, activeRooms: () => 1, averageRoomPopulation: () => 0, draining: () => false });
}

void test('simultaneous placement cannot reserve beyond room capacity', async () => {
  const rooms = new RoomManager([config], 2, 'server-a'); const directory = new InMemoryRoomDirectory(); const metrics = runtimeMetrics();
  const lifecycle = new RoomLifecycleService(rooms, directory, metrics, createLogger({ test: true })); await lifecycle.start();
  const serverConfig = loadServerConfig({ SERVER_ID: 'server-a', MAX_PLAYERS_PER_ROOM: '2', MAX_ROOMS_PER_SERVER: '1', MAX_SERVER_MEMORY_MB: '65536' });
  const placement = new RoomPlacementService(rooms, directory, lifecycle, new InMemoryRoomAdmission(), undefined, serverConfig, metrics);
  const results = await Promise.all([placement.place({}), placement.place({}), placement.place({})]);
  assert.equal(results.filter(({ ok }) => ok).length, 2);
  assert.equal(results.filter(({ reason }) => reason === 'no-capacity').length, 1);
  await lifecycle.stop(); metrics.close();
});

void test('placement creates a globally unique room only when existing rooms are unavailable', async () => {
  const rooms = new RoomManager([config], 1, 'server-a'); const directory = new InMemoryRoomDirectory(); const metrics = runtimeMetrics();
  const lifecycle = new RoomLifecycleService(rooms, directory, metrics, createLogger({ test: true })); await lifecycle.start();
  const serverConfig = loadServerConfig({ SERVER_ID: 'server-a', MAX_PLAYERS_PER_ROOM: '2', MAX_ROOMS_PER_SERVER: '2', MAX_SERVER_MEMORY_MB: '65536' });
  const placement = new RoomPlacementService(rooms, directory, lifecycle, new InMemoryRoomAdmission(), undefined, serverConfig, metrics);
  assert.equal((await placement.place({})).room?.id, 'main');
  const created = await placement.place({});
  assert.equal(created.ok, true);
  assert.equal(created.created, true);
  assert.match(created.room?.id ?? '', /^main-[0-9a-f-]{36}$/);
  assert.notEqual(created.room?.id, 'main');
  await lifecycle.stop(); metrics.close();
});

void test('confirmed admission is released idempotently', async () => {
  const admission = new InMemoryRoomAdmission(10_000);
  const reservation = await admission.reserve('room-a', 1);
  assert.ok(reservation);
  assert.equal(await admission.confirm(reservation!.roomId, reservation!.token, 'player-a'), true);
  assert.equal(await admission.reserve('room-a', 1), undefined);
  await admission.release('room-a', 'player-a');
  await admission.release('room-a', 'player-a');
  assert.ok(await admission.reserve('room-a', 1));
});

void test('an explicit room ID never silently places the player into another room', async () => {
  const rooms = new RoomManager([config], 2, 'server-a'); const directory = new InMemoryRoomDirectory(); const metrics = runtimeMetrics();
  const lifecycle = new RoomLifecycleService(rooms, directory, metrics, createLogger({ test: true })); await lifecycle.start();
  const serverConfig = loadServerConfig({ SERVER_ID: 'server-a', MAX_PLAYERS_PER_ROOM: '2', MAX_ROOMS_PER_SERVER: '2', MAX_SERVER_MEMORY_MB: '65536' });
  const placement = new RoomPlacementService(rooms, directory, lifecycle, new InMemoryRoomAdmission(), undefined, serverConfig, metrics);
  const result = await placement.place({ requestedRoomId: 'friends-room' });
  assert.deepEqual(result, { ok: false, reason: 'unavailable' });
  assert.equal(rooms.roomCount, 1);
  await lifecycle.stop(); metrics.close();
});
