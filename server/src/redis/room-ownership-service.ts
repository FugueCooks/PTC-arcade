import type { RedisClientType } from 'redis';
import type { RedisKeys } from './redis-keys.js';

export interface RoomLease { roomId: string; serverId: string; fencingToken: number; value: string; expiresAt: number }

const RENEW_SCRIPT = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE_SCRIPT = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;

export class RoomOwnershipService {
  constructor(private readonly client: RedisClientType, private readonly keys: RedisKeys, private readonly serverId: string, private readonly ttlMs: number) {}

  async acquire(roomId: string, now = Date.now()): Promise<RoomLease | undefined> {
    const fencingToken = await this.client.incr(this.keys.roomFence(roomId));
    await this.client.expire(this.keys.roomFence(roomId), 86_400);
    const value = `${this.serverId}:${fencingToken}`;
    const result = await this.client.set(this.keys.roomOwner(roomId), value, { condition: 'NX', expiration: { type: 'PX', value: this.ttlMs } });
    return result === 'OK' ? { roomId, serverId: this.serverId, fencingToken, value, expiresAt: now + this.ttlMs } : undefined;
  }

  async renew(lease: RoomLease, now = Date.now()): Promise<boolean> {
    const result = await this.client.eval(RENEW_SCRIPT, { keys: [this.keys.roomOwner(lease.roomId)], arguments: [lease.value, String(this.ttlMs)] });
    if (Number(result) === 1) lease.expiresAt = now + this.ttlMs;
    return Number(result) === 1;
  }

  async release(lease: RoomLease): Promise<boolean> {
    const result = await this.client.eval(RELEASE_SCRIPT, { keys: [this.keys.roomOwner(lease.roomId)], arguments: [lease.value] });
    return Number(result) === 1;
  }
}
