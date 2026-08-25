import { createHash } from 'node:crypto';
import type { RedisClientType } from 'redis';
import type { RedisKeys } from '../redis/redis-keys.js';
import { RequestRateLimiter } from './request-rate-limiter.js';

export interface AsyncRateLimiter {
  consume(key: string): Promise<{ allowed: boolean; retryAfterMs: number }>;
}

export class InMemoryAsyncRateLimiter implements AsyncRateLimiter {
  private readonly limiter: RequestRateLimiter;
  constructor(maximum: number, windowMs: number) { this.limiter = new RequestRateLimiter(maximum, windowMs); }
  async consume(key: string) { return this.limiter.consume(key); }
}

export class RedisAsyncRateLimiter implements AsyncRateLimiter {
  constructor(private readonly client: RedisClientType, private readonly keys: RedisKeys,
    private readonly maximum: number, private readonly windowMs: number) {}

  async consume(identifier: string): Promise<{ allowed: boolean; retryAfterMs: number }> {
    const digest = createHash('sha256').update(identifier).digest('hex');
    const result = await this.client.eval(
      "local count=redis.call('INCR',KEYS[1]); if count==1 then redis.call('PEXPIRE',KEYS[1],ARGV[1]) end; local ttl=redis.call('PTTL',KEYS[1]); return {count,ttl}",
      { keys: [this.keys.walletAuthRateLimit(digest)], arguments: [String(this.windowMs)] }
    );
    const values = Array.isArray(result) ? result : [];
    const count = Number(values[0] ?? this.maximum + 1);
    const retryAfterMs = Math.max(1, Number(values[1] ?? this.windowMs));
    return { allowed: count <= this.maximum, retryAfterMs: count <= this.maximum ? 0 : retryAfterMs };
  }
}
