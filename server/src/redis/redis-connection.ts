import { createClient, type RedisClientType } from 'redis';
import type { Logger } from '../logging/logger.js';
import type { RuntimeMetrics } from '../metrics/metrics.js';

export class RedisConnection {
  readonly client: RedisClientType;
  private readyValue = false;

  constructor(url: string, private readonly logger: Logger, private readonly metrics: RuntimeMetrics) {
    this.client = createClient({
      url,
      // The Socket.IO Streams adapter continuously polls with XREAD. Returning
      // an Error here permanently closes the client, after which those polls
      // reject immediately and can starve the event loop. Keep retrying with a
      // capped delay so liveness remains responsive during a Redis outage.
      socket: { reconnectStrategy: redisReconnectDelay }
    });
    this.client.on('ready', () => { this.readyValue = true; this.logger.info('redis_ready'); });
    this.client.on('reconnecting', () => { this.readyValue = false; this.metrics.increment('redis_reconnect_total'); });
    this.client.on('end', () => { this.readyValue = false; this.logger.warn('redis_disconnected'); });
    this.client.on('error', (error) => {
      this.readyValue = false;
      this.metrics.increment('redis_errors_total');
      this.logger.error('redis_error', { errorName: error.name, errorMessage: error.message });
    });
  }

  get isReady(): boolean { return this.readyValue && this.client.isReady; }

  async connect(timeoutMs?: number): Promise<boolean> {
    if (!this.client.isOpen) {
      const attempt = this.client.connect().then(() => true, () => false);
      const connected = timeoutMs
        ? await Promise.race([attempt, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs))])
        : await attempt;
      if (!connected) {
        this.readyValue = false;
        if (this.client.isOpen) this.client.destroy();
        return false;
      }
    }
    this.readyValue = this.client.isReady;
    return this.isReady;
  }

  async close(): Promise<void> {
    this.readyValue = false;
    if (this.client.isReady) await this.client.quit();
    else if (this.client.isOpen) this.client.destroy();
  }
}

export function redisReconnectDelay(retries: number): number {
  return Math.min(250 * 2 ** Math.min(Math.max(0, retries), 5), 5_000);
}
