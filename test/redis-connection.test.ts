import assert from 'node:assert/strict';
import test from 'node:test';
import { redisReconnectDelay } from '../server/src/redis/redis-connection.js';

void test('Redis retries use bounded backoff without permanently stopping', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 100].map(redisReconnectDelay), [250, 500, 1_000, 2_000, 4_000, 5_000, 5_000]);
});
