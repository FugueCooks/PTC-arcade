import type { RedisClientType } from 'redis';
import type { RedisKeys } from './redis-keys.js';

interface ActiveConnection { serverId: string; socketId: string; at: number }

export class RedisIdentityDirectory {
  constructor(private readonly client: RedisClientType, private readonly keys: RedisKeys,
    private readonly serverId: string, private readonly ttlMs = 30_000) {}

  async claim(playerId: string, socketId: string): Promise<ActiveConnection | undefined> {
    const value = JSON.stringify({ serverId: this.serverId, socketId, at: Date.now() });
    const prior = await this.client.eval(
      "local old=redis.call('GET',KEYS[1]); redis.call('SET',KEYS[1],ARGV[1],'PX',ARGV[2]); return old",
      { keys: [this.keys.activeIdentity(playerId)], arguments: [value, String(this.ttlMs)] }
    );
    return parseConnection(prior);
  }

  async refresh(playerId: string, socketId: string): Promise<void> {
    const value = JSON.stringify({ serverId: this.serverId, socketId, at: Date.now() });
    await this.client.eval(
      "local old=redis.call('GET',KEYS[1]); if old and string.find(old,ARGV[1],1,true) then redis.call('SET',KEYS[1],ARGV[2],'PX',ARGV[3]); return 1 end; return 0",
      { keys: [this.keys.activeIdentity(playerId)], arguments: [socketId, value, String(this.ttlMs)] }
    );
  }

  async release(playerId: string, socketId: string): Promise<void> {
    await this.client.eval(
      "local old=redis.call('GET',KEYS[1]); if old and string.find(old,ARGV[1],1,true) then return redis.call('DEL',KEYS[1]) end; return 0",
      { keys: [this.keys.activeIdentity(playerId)], arguments: [socketId] }
    );
  }

  async presence(playerId: string, roomId: string, socketId: string, expiresInMs: number): Promise<void> {
    await this.client.set(this.keys.identityPresence(playerId), JSON.stringify({ serverId: this.serverId, roomId, socketId }), { PX: expiresInMs });
  }
}

function parseConnection(value: unknown): ActiveConnection | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<ActiveConnection>;
    return typeof parsed.serverId === 'string' && typeof parsed.socketId === 'string' && typeof parsed.at === 'number'
      ? parsed as ActiveConnection : undefined;
  } catch { return undefined; }
}
