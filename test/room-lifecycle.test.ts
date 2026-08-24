import assert from 'node:assert/strict';
import test from 'node:test';
import { createLogger } from '../server/src/logging/logger.js';
import { RuntimeMetrics } from '../server/src/metrics/metrics.js';
import { InMemoryRoomDirectory } from '../server/src/rooms/room-directory.js';
import { RoomLifecycleService } from '../server/src/rooms/room-lifecycle-service.js';
import { RoomManager } from '../server/src/rooms/room-manager.js';

const roomConfig = {
  id: 'main', name: 'Main Arcade', capacity: 2, spawnSeparation: 1,
  spawnPoints: [{ x: 0, y: 1.65, z: 0, rotationY: 0 }]
};

function metrics(): RuntimeMetrics {
  return new RuntimeMetrics({ connectedSockets: () => 0, activePlayers: () => 0, activeRooms: () => 0, averageRoomPopulation: () => 0, draining: () => false });
}

void test('room records expose ownership, lifecycle, population, and state revisions', () => {
  const rooms = new RoomManager([roomConfig], 2, 'server-a');
  const room = rooms.getDefault();
  assert.equal(room.tryAdd('one', 1_100), true);
  room.bumpRevision('cabinet', 1_200);
  room.bumpRevision('world', 1_300);
  assert.deepEqual({ serverId: room.record().serverId, players: room.record().playerCount, cabinet: room.record().cabinetRevision, world: room.record().worldRevision },
    { serverId: 'server-a', players: 1, cabinet: 1, world: 1 });
  assert.equal(room.tryAdd('two', 1_400), true);
  assert.equal(room.status, 'full');
  assert.equal(room.tryAdd('three', 1_500), false);
  room.remove('two', 1_600);
  assert.equal(room.status, 'available');
});

void test('room lifecycle mirrors records and closes only idle dynamic rooms', async () => {
  const rooms = new RoomManager([roomConfig], 2, 'server-a');
  const directory = new InMemoryRoomDirectory();
  const runtimeMetrics = metrics();
  const lifecycle = new RoomLifecycleService(rooms, directory, runtimeMetrics, createLogger({ test: true }));
  await lifecycle.start();
  const dynamic = rooms.create('main', 1_000);
  await lifecycle.flush();
  assert.equal((await directory.get(dynamic.id))?.status, 'available');
  assert.deepEqual(lifecycle.closeIdle(500, 1_600), [dynamic.id]);
  await lifecycle.flush();
  assert.equal(await directory.get(dynamic.id), undefined);
  assert.equal(rooms.close('main', 2_000), false);
  await lifecycle.stop(); runtimeMetrics.close();
});

void test('draining marks every room unavailable for new admissions', async () => {
  const rooms = new RoomManager([roomConfig], 2, 'server-a');
  const directory = new InMemoryRoomDirectory();
  const runtimeMetrics = metrics();
  const lifecycle = new RoomLifecycleService(rooms, directory, runtimeMetrics, createLogger({ test: true }));
  await lifecycle.start();
  lifecycle.beginDraining();
  await lifecycle.flush();
  assert.equal(rooms.getDefault().acceptsPlayers, false);
  assert.equal((await directory.get('main'))?.status, 'draining');
  await lifecycle.stop(); runtimeMetrics.close();
});

void test('room ownership is reacquired and republished after Redis loses leases', async () => {
  const rooms = new RoomManager([roomConfig], 2, 'server-a');
  const directory = new InMemoryRoomDirectory();
  const runtimeMetrics = metrics();
  let acquireCount = 0;
  const ownership = {
    async acquire(roomId: string) {
      acquireCount += 1;
      return { roomId, serverId: 'server-a', fencingToken: acquireCount, value: `server-a:${acquireCount}`, expiresAt: Date.now() + 30_000 };
    },
    async renew() { return false; },
    async release() { return true; }
  };
  const lifecycle = new RoomLifecycleService(rooms, directory, runtimeMetrics, createLogger({ test: true }), ownership as never, 60_000);
  await lifecycle.start();
  await (lifecycle as unknown as { refresh(): Promise<void> }).refresh();
  assert.equal(acquireCount, 2);
  assert.equal(rooms.getDefault().health, 'healthy');
  assert.equal((await directory.get('main'))?.status, 'available');
  await lifecycle.stop(); runtimeMetrics.close();
});
