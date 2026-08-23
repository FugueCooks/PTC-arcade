import { createClient, type RedisClientType } from 'redis';
import type { Logger } from '../logging/logger.js';
import type { RuntimeMetrics } from '../metrics/metrics.js';

export class RedisConnection {
  readonly client: RedisClientType;
  private readyValue = false;

  constructor(url: string, private readonly logger: Logger, private readonly metrics: RuntimeMetrics) {
    this.client = createClient({
      url,
      socket: { reconnectStrategy: (retries) => retries > 5 ? new Error('Redis startup retry limit reached.') : Math.min(250 * 2 ** Math.min(retries, 5), 5_000) }
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

  async connect(): Promise<void> {
    if (!this.client.isOpen) await this.client.connect();
    this.readyValue = this.client.isReady;
  }

  async close(): Promise<void> {
    this.readyValue = false;
    if (this.client.isOpen) await this.client.quit();
  }
}
