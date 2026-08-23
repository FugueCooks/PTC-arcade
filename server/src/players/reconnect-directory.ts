import { createHash } from 'node:crypto';
import type { RedisClientType } from 'redis';
import type { RedisKeys } from '../redis/redis-keys.js';

export interface ReconnectRecord { playerId: string; roomId: string; serverId: string; expiresAt: number }
export interface ReconnectDirectory { save(token: string, record: ReconnectRecord): Promise<void>; get(token: string, now?: number): Promise<ReconnectRecord | undefined> }

export class RedisReconnectDirectory implements ReconnectDirectory {
  constructor(private readonly client: RedisClientType, private readonly keys: RedisKeys) {}
  async save(token: string, record: ReconnectRecord): Promise<void> {
    const ttl = Math.max(1, record.expiresAt - Date.now());
    await this.client.set(this.keys.reconnect(hash(token)), JSON.stringify(record), { expiration: { type: 'PX', value: ttl } });
  }
  async get(token: string, now = Date.now()): Promise<ReconnectRecord | undefined> {
    const value = await this.client.get(this.keys.reconnect(hash(token)));
    if (!value) return undefined;
    const record = JSON.parse(value) as ReconnectRecord;
    return record.expiresAt > now && typeof record.roomId === 'string' && typeof record.serverId === 'string' ? record : undefined;
  }
}

export class InMemoryReconnectDirectory implements ReconnectDirectory {
  private readonly records = new Map<string, ReconnectRecord>();
  async save(token: string, record: ReconnectRecord): Promise<void> { this.records.set(hash(token), record); }
  async get(token: string, now = Date.now()): Promise<ReconnectRecord | undefined> {
    const key = hash(token); const record = this.records.get(key);
    if (!record || record.expiresAt <= now) { this.records.delete(key); return undefined; }
    return record;
  }
}

function hash(token: string): string { return createHash('sha256').update(token).digest('hex'); }
