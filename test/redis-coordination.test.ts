import assert from 'node:assert/strict';
import test from 'node:test';
import { RedisKeys } from '../server/src/redis/redis-keys.js';
import { RedisRoomDirectory } from '../server/src/redis/redis-room-directory.js';
import { RoomOwnershipService } from '../server/src/redis/room-ownership-service.js';
import type { RoomRecord } from '../server/src/rooms/room.js';
import { ServerRegistry } from '../server/src/servers/server-registry.js';
import { loadServerConfig } from '../server/src/config.js';
import { RuntimeMetrics } from '../server/src/metrics/metrics.js';
import { createLogger } from '../server/src/logging/logger.js';

class FakeRedis {
  strings = new Map<string, string>(); sets = new Map<string, Set<string>>(); sorted = new Map<string, Map<string, number>>();
  async get(key: string): Promise<string | null> { return this.strings.get(key) ?? null; }
  async set(key: string, value: string, options?: { condition?: string }): Promise<string | null> {
    if (options?.condition === 'NX' && this.strings.has(key)) return null;
    this.strings.set(key, value); return 'OK';
  }
  async del(key: string): Promise<number> { return this.strings.delete(key) ? 1 : 0; }
  async incr(key: string): Promise<number> { const value = Number(this.strings.get(key) ?? 0) + 1; this.strings.set(key, String(value)); return value; }
  async mGet(keys: string[]): Promise<Array<string | null>> { return Promise.all(keys.map((key) => this.get(key))); }
  async zAdd(key: string, entry: { score: number; value: string }): Promise<number> { const values = this.sorted.get(key) ?? new Map(); values.set(entry.value, entry.score); this.sorted.set(key, values); return 1; }
  async zRem(key: string, values: string | string[]): Promise<number> { const list = Array.isArray(values) ? values : [values]; const target = this.sorted.get(key); return list.reduce((count, value) => count + (target?.delete(value) ? 1 : 0), 0); }
  async zRange(key: string): Promise<string[]> { return [...(this.sorted.get(key) ?? [])].sort((a, b) => a[1] - b[1]).map(([value]) => value); }
  async zRangeByScore(key: string, minimum: number): Promise<string[]> { return [...(this.sorted.get(key) ?? [])].filter(([, score]) => score >= minimum).map(([value]) => value); }
  async zRemRangeByScore(key: string, minimum: number, maximum: number): Promise<number> {
    const values = this.sorted.get(key); if (!values) return 0; let removed = 0;
    for (const [value, score] of values) if (score >= minimum && score <= maximum) { values.delete(value); removed += 1; }
    return removed;
  }
  async sAdd(key: string, value: string): Promise<number> { const values = this.sets.get(key) ?? new Set(); const before = values.size; values.add(value); this.sets.set(key, values); return values.size - before; }
  async sRem(key: string, value: string): Promise<number> { return this.sets.get(key)?.delete(value) ? 1 : 0; }
  async expire(): Promise<number> { return 1; }
  async eval(_script: string, options: { keys: string[]; arguments: string[] }): Promise<number> {
    if (this.strings.get(options.keys[0]) !== options.arguments[0]) return 0;
    if (options.arguments.length === 1) this.strings.delete(options.keys[0]);
    return 1;
  }
  multi(): FakeMulti { return new FakeMulti(this); }
}

class FakeMulti {
  private operations: Array<() => Promise<unknown>> = [];
  constructor(private readonly redis: FakeRedis) {}
  set(key: string, value: string, options?: { condition?: string }): this { this.operations.push(() => this.redis.set(key, value, options)); return this; }
  del(key: string): this { this.operations.push(() => this.redis.del(key)); return this; }
  zAdd(key: string, entry: { score: number; value: string }): this { this.operations.push(() => this.redis.zAdd(key, entry)); return this; }
  zRem(key: string, value: string): this { this.operations.push(() => this.redis.zRem(key, value)); return this; }
  zRemRangeByScore(key: string, minimum: number, maximum: number): this { this.operations.push(() => this.redis.zRemRangeByScore(key, minimum, maximum)); return this; }
  sAdd(key: string, value: string): this { this.operations.push(() => this.redis.sAdd(key, value)); return this; }
  sRem(key: string, value: string): this { this.operations.push(() => this.redis.sRem(key, value)); return this; }
  expire(): this { this.operations.push(() => this.redis.expire()); return this; }
  async exec(): Promise<unknown[]> { return Promise.all(this.operations.map((operation) => operation())); }
}

const record = (id: string, serverId: string): RoomRecord => ({
  id, name: id, templateId: 'main', serverId, playerCount: 1, capacity: 24, status: 'available', health: 'healthy',
  createdAt: 1_000, lastActivityAt: 2_000, seeded: false, cabinetRevision: 0, worldRevision: 0
});

void test('Redis keys are versioned, environment scoped, and contain no player data', () => {
  const keys = new RedisKeys('arcade:v1:test');
  assert.equal(keys.server('server-a'), 'arcade:v1:test:servers:server-a');
  assert.equal(keys.room('room-a'), 'arcade:v1:test:rooms:room-a');
  assert.equal(keys.socketStream(), 'arcade:v1:test:socket-stream');
});

void test('Redis room directory stores isolated discoverable room records and removes stale entries', async () => {
  const redis = new FakeRedis(); const keys = new RedisKeys('arcade:v1:test');
  const directory = new RedisRoomDirectory(redis as never, keys, 30_000);
  await directory.register(record('room-a', 'server-a'));
  await directory.register(record('room-b', 'server-b'));
  assert.deepEqual((await directory.list(['available'])).map(({ id }) => id), ['room-a', 'room-b']);
  await directory.remove('room-a');
  assert.equal(await directory.get('room-a'), undefined);
  assert.equal((await directory.list()).length, 1);
});

void test('malformed room directory records are quarantined without hiding healthy rooms', async () => {
  const redis = new FakeRedis(); const keys = new RedisKeys('arcade:v1:test');
  const directory = new RedisRoomDirectory(redis as never, keys, 30_000);
  await directory.register(record('room-good', 'server-a'));
  redis.strings.set(keys.room('room-bad'), '{not-json');
  await redis.zAdd(keys.roomDirectory(), { score: 2_000, value: 'room-bad' });
  assert.deepEqual((await directory.list()).map(({ id }) => id), ['room-good']);
  assert.equal(await redis.get(keys.room('room-bad')), null);
  assert.equal(await directory.get('room-bad'), undefined);
});

void test('room ownership leases prevent duplicate owners and use fencing tokens', async () => {
  const redis = new FakeRedis(); const keys = new RedisKeys('arcade:v1:test');
  const firstOwner = new RoomOwnershipService(redis as never, keys, 'server-a', 30_000);
  const secondOwner = new RoomOwnershipService(redis as never, keys, 'server-b', 30_000);
  const first = await firstOwner.acquire('room-a', 1_000);
  assert.ok(first);
  assert.equal(await secondOwner.acquire('room-a', 1_000), undefined);
  assert.equal(await firstOwner.renew(first!, 2_000), true);
  assert.equal(await firstOwner.release(first!), true);
  const second = await secondOwner.acquire('room-a', 3_000);
  assert.ok(second && second.fencingToken > first!.fencingToken);
});

void test('server registrations heartbeat, filter draining servers, and clean up on stop', async () => {
  const redis = new FakeRedis(); const keys = new RedisKeys('arcade:v1:test');
  const runtimeMetrics = new RuntimeMetrics({ connectedSockets: () => 0, activePlayers: () => 0, activeRooms: () => 0, averageRoomPopulation: () => 0, draining: () => false });
  const config = loadServerConfig({ SERVER_ID: 'server-a', SERVER_REGION: 'test-region', MAX_SERVER_MEMORY_MB: '65536' });
  let draining = false;
  const registry = new ServerRegistry(redis as never, keys, config, {
    roomCount: () => 2, playerCount: () => 3, draining: () => draining, healthy: () => true
  }, runtimeMetrics, createLogger({ test: true }));
  await registry.heartbeat(10_000);
  assert.deepEqual((await registry.listHealthy(10_001)).map(({ serverId }) => serverId), ['server-a']);
  draining = true;
  await registry.heartbeat(11_000);
  assert.deepEqual(await registry.listHealthy(11_001), []);
  await registry.stop();
  assert.equal(await redis.get(keys.server('server-a')), null);
  runtimeMetrics.close();
});

void test('malformed server registrations are removed without breaking healthy discovery', async () => {
  const redis = new FakeRedis(); const keys = new RedisKeys('arcade:v1:test');
  const runtimeMetrics = new RuntimeMetrics({ connectedSockets: () => 0, activePlayers: () => 0, activeRooms: () => 0, averageRoomPopulation: () => 0, draining: () => false });
  const config = loadServerConfig({ SERVER_ID: 'server-good', SERVER_REGION: 'test-region', MAX_SERVER_MEMORY_MB: '65536' });
  const registry = new ServerRegistry(redis as never, keys, config, {
    roomCount: () => 1, playerCount: () => 1, draining: () => false, healthy: () => true
  }, runtimeMetrics, createLogger({ test: true }));
  await registry.heartbeat(10_000);
  redis.strings.set(keys.server('server-bad'), '{not-json');
  await redis.zAdd(keys.serverHeartbeats(), { score: 10_000, value: 'server-bad' });
  assert.deepEqual((await registry.listHealthy(10_001)).map(({ serverId }) => serverId), ['server-good']);
  assert.equal(await redis.get(keys.server('server-bad')), null);
  runtimeMetrics.close();
});
