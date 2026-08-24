import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { Logger } from '../logging/logger.js';
import type { RuntimeMetrics } from '../metrics/metrics.js';
import * as schema from './schema.js';

export class DatabaseConnection {
  readonly pool: Pool;
  readonly db: NodePgDatabase<typeof schema>;
  private readyValue = false;

  constructor(connectionString: string, poolMaximum: number, private readonly logger: Logger, private readonly metrics: RuntimeMetrics) {
    this.pool = new Pool({ connectionString, max: poolMaximum, application_name: 'retro-arcade' });
    this.pool.on('error', (error) => {
      this.readyValue = false;
      this.metrics.increment('database_pool_errors_total');
      const errorCode = typeof (error as NodeJS.ErrnoException).code === 'string' ? (error as NodeJS.ErrnoException).code : 'unknown';
      this.logger.error('database_pool_error', { errorName: error.name, errorCode });
    });
    this.db = drizzle(this.pool, { schema });
  }

  get isReady(): boolean { return this.readyValue; }

  async connect(timeoutMs: number): Promise<boolean> {
    const probe = this.pool.query('select 1').then(() => true, () => false);
    const connected = await Promise.race([
      probe,
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs))
    ]);
    this.readyValue = connected;
    this.metrics.increment(connected ? 'database_connect_success_total' : 'database_connect_failure_total');
    if (connected) this.logger.info('database_ready');
    else this.logger.error('database_unavailable', { timeoutMs });
    return connected;
  }

  async check(): Promise<boolean> {
    try {
      await this.pool.query('select 1');
      this.readyValue = true;
      return true;
    } catch {
      this.readyValue = false;
      return false;
    }
  }

  async close(): Promise<void> {
    this.readyValue = false;
    await this.pool.end();
  }
}
