import assert from 'node:assert/strict';
import test from 'node:test';
import { loadServerConfig } from '../server/src/config.js';
import { HealthService } from '../server/src/health/health-service.js';
import { RuntimeMetrics } from '../server/src/metrics/metrics.js';
import { RoomManager } from '../server/src/rooms/room-manager.js';
import { DrainController } from '../server/src/shutdown/drain-controller.js';
import { createLogger } from '../server/src/logging/logger.js';

void test('operational configuration is bounded and deployment identity is normalized', () => {
  const config = loadServerConfig({
    PORT: '9090', SERVER_ID: ' arcade server / 1 ', SERVER_REGION: 'us-west', SOFTWARE_VERSION: 'abc123',
    MAX_PLAYERS_PER_ROOM: '25', MAX_ROOMS_PER_SERVER: '10', MAX_PLAYERS_PER_SERVER: '250',
    MAX_PENDING_CONNECTIONS: '100', MAX_SERVER_MEMORY_MB: '2048', MAX_EVENT_LOOP_DELAY_MS: '250',
    SERVER_DRAIN_TIMEOUT_SECONDS: '60', SERVER_SHUTDOWN_WARNING_SECONDS: '10'
    , PUBLIC_REALTIME_URL: 'https://west.arcade.example', MATCHMAKING_URL: 'https://match.arcade.example'
  });
  assert.equal(config.port, 9090);
  assert.equal(config.serverId, 'arcade-server-1');
  assert.equal(config.maxPlayersPerRoom, 25);
  assert.equal(config.maxRoomsPerServer, 10);
  assert.equal(config.maxPlayersPerServer, 250);
  assert.equal(config.redisStartupTimeoutMs, 5_000);
  assert.equal(config.drainTimeoutMs, 60_000);
  assert.equal(config.publicRealtimeUrl, 'https://west.arcade.example');
  assert.throws(() => loadServerConfig({ MAX_PLAYERS_PER_ROOM: '5000' }), /Invalid numeric server configuration/);
  assert.throws(() => loadServerConfig({ REDIS_REQUIRED: '1' }), /requires REDIS_URL/);
});

void test('configured room capacity is clamped by the per-server safety limit', () => {
  const rooms = new RoomManager(undefined, 24);
  assert.equal(rooms.getDefault().config.capacity, 24);
  assert.equal(rooms.roomCount, 10);
  assert.equal(rooms.activeRoomCount, 0);
});

void test('readiness reports initialization, capacity, and draining states without exposing internals', () => {
  let players = 0;
  const sources = { connectedSockets: () => players, activePlayers: () => players, activeRooms: () => players ? 1 : 0 };
  const metrics = new RuntimeMetrics({ ...sources, averageRoomPopulation: () => players, draining: () => false });
  const config = loadServerConfig({
    SERVER_ID: 'test-server', MAX_PLAYERS_PER_SERVER: '2', MAX_PLAYERS_PER_ROOM: '2', MAX_ROOMS_PER_SERVER: '2',
    MAX_PENDING_CONNECTIONS: '2', MAX_SERVER_MEMORY_MB: '65536', MAX_EVENT_LOOP_DELAY_MS: '10000'
  });
  const health = new HealthService(config, metrics, sources);
  assert.deepEqual(health.readiness().reasons, ['initializing']);
  health.markInitialized();
  assert.equal(health.readiness().ready, true);
  players = 2;
  assert.deepEqual(health.readiness().reasons, ['player-capacity']);
  players = 0;
  health.beginDraining();
  assert.deepEqual(health.readiness().reasons, ['draining']);
  assert.match(metrics.render(), /arcade_active_players 0/);
  metrics.close();
});

void test('required Redis coordination controls readiness without exposing its URL', () => {
  const sources = {
    connectedSockets: () => 0, activePlayers: () => 0, activeRooms: () => 1,
    coordinationRequired: () => true, coordinationReady: () => false
  };
  const metrics = new RuntimeMetrics({ ...sources, averageRoomPopulation: () => 0, draining: () => false });
  const config = loadServerConfig({ REDIS_URL: 'redis://example.invalid:6379', REDIS_REQUIRED: '1', MAX_SERVER_MEMORY_MB: '65536' });
  const health = new HealthService(config, metrics, sources); health.markInitialized();
  assert.deepEqual(health.readiness().reasons, ['redis-unavailable']);
  assert.doesNotMatch(JSON.stringify(health.readiness()), /example\.invalid/);
  metrics.close();
});

void test('runtime metrics normalize event names and expose process gauges', () => {
  const metrics = new RuntimeMetrics({ connectedSockets: () => 3, activePlayers: () => 2, activeRooms: () => 1, averageRoomPopulation: () => 2, draining: () => false });
  metrics.increment('events:room.join received total');
  const output = metrics.render();
  assert.match(output, /arcade_connected_sockets 3/);
  assert.match(output, /arcade_events:room_join_received_total 1/);
  assert.doesNotMatch(output, /token|secret|ROM/i);
  metrics.close();
});

void test('graceful draining is idempotent and closes an empty server cleanly', async () => {
  let socketCloseCount = 0;
  let httpCloseCount = 0;
  let timerStopCount = 0;
  const io = {
    emit: () => undefined,
    close: (callback: () => void) => { socketCloseCount += 1; callback(); return Promise.resolve(); }
  };
  const httpServer = { close: (callback: () => void) => { httpCloseCount += 1; callback(); return httpServer; } };
  const config = loadServerConfig({ SERVER_ID: 'drain-test', MAX_SERVER_MEMORY_MB: '65536', MAX_EVENT_LOOP_DELAY_MS: '10000' });
  const sources = { connectedSockets: () => 0, activePlayers: () => 0, activeRooms: () => 0 };
  const metrics = new RuntimeMetrics({ ...sources, averageRoomPopulation: () => 0, draining: () => true });
  const health = new HealthService(config, metrics, sources);
  health.markInitialized();
  const drain = new DrainController(httpServer as never, io as never, config, health, metrics, createLogger({ test: true }), {
    activePlayers: () => 0,
    stopTimers: () => { timerStopCount += 1; }
  });
  drain.begin('test');
  drain.begin('duplicate');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(health.isDraining, true);
  assert.equal(socketCloseCount, 1);
  assert.equal(httpCloseCount, 1);
  assert.equal(timerStopCount, 1);
});
