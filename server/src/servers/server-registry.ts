import type { RedisClientType } from 'redis';
import type { ServerConfig } from '../config.js';
import type { Logger } from '../logging/logger.js';
import type { RuntimeMetrics } from '../metrics/metrics.js';
import type { RedisKeys } from '../redis/redis-keys.js';

export type ServerHealth = 'healthy' | 'unhealthy';
export interface ServerRecord {
  serverId: string; region: string; startupAt: number; roomCount: number; playerCount: number;
  maximumCapacity: number; heartbeatAt: number; draining: boolean; health: ServerHealth; softwareVersion: string;
}

export interface ServerRegistrySources { roomCount(): number; playerCount(): number; draining(): boolean; healthy(): boolean }

export class ServerRegistry {
  private heartbeatTimer?: NodeJS.Timeout;
  private readonly startupAt = Date.now();

  constructor(
    private readonly client: RedisClientType,
    private readonly keys: RedisKeys,
    private readonly config: ServerConfig,
    private readonly sources: ServerRegistrySources,
    private readonly metrics: RuntimeMetrics,
    private readonly logger: Logger
  ) {}

  async start(): Promise<void> {
    await this.heartbeat();
    this.heartbeatTimer = setInterval(() => { void this.heartbeat().catch((error: unknown) => this.failed(error)); }, this.config.serverHeartbeatMs);
    this.heartbeatTimer.unref();
  }

  async heartbeat(now = Date.now()): Promise<void> {
    const record: ServerRecord = {
      serverId: this.config.serverId, region: this.config.region, startupAt: this.startupAt,
      roomCount: this.sources.roomCount(), playerCount: this.sources.playerCount(), maximumCapacity: this.config.maxPlayersPerServer,
      heartbeatAt: now, draining: this.sources.draining(), health: this.sources.healthy() ? 'healthy' : 'unhealthy',
      softwareVersion: this.config.softwareVersion
    };
    const ttlSeconds = Math.max(1, Math.ceil(this.config.serverTtlMs / 1_000));
    await this.client.multi()
      .set(this.keys.server(this.config.serverId), JSON.stringify(record), { expiration: { type: 'EX', value: ttlSeconds } })
      .zAdd(this.keys.serverHeartbeats(), { score: now, value: this.config.serverId })
      .zRemRangeByScore(this.keys.serverHeartbeats(), 0, now - this.config.serverTtlMs)
      .exec();
    this.metrics.increment('server_heartbeat_total');
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    await this.client.multi().del(this.keys.server(this.config.serverId)).zRem(this.keys.serverHeartbeats(), this.config.serverId).exec();
    this.logger.info('server_registration_removed');
  }

  async listHealthy(now = Date.now()): Promise<ServerRecord[]> {
    const ids = await this.client.zRangeByScore(this.keys.serverHeartbeats(), now - this.config.serverTtlMs, '+inf');
    if (!ids.length) return [];
    const values = await this.client.mGet(ids.map((id) => this.keys.server(id)));
    return values.flatMap((value) => value ? [parse(value)] : []).filter((record) => record.health === 'healthy' && !record.draining);
  }

  private failed(error: unknown): void {
    this.metrics.increment('server_heartbeat_failure_total');
    this.logger.error('server_heartbeat_failed', { errorMessage: error instanceof Error ? error.message : 'unknown' });
  }
}

function parse(value: string): ServerRecord {
  const record = JSON.parse(value) as ServerRecord;
  if (!record || typeof record.serverId !== 'string' || typeof record.heartbeatAt !== 'number') throw new Error('Malformed server registration.');
  return record;
}
