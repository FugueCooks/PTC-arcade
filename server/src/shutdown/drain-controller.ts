import type { Server as HttpServer } from 'node:http';
import type { Server as SocketServer } from 'socket.io';
import type { ServerConfig } from '../config.js';
import type { HealthService } from '../health/health-service.js';
import type { Logger } from '../logging/logger.js';
import type { RuntimeMetrics } from '../metrics/metrics.js';

export interface DrainOptions {
  activePlayers(): number;
  beginDraining?(): void;
  stopTimers(): void | Promise<void>;
}

export class DrainController {
  private draining = false;
  private deadlineAt = 0;
  private pollTimer?: NodeJS.Timeout;
  private finishing = false;

  constructor(
    private readonly httpServer: HttpServer,
    private readonly io: SocketServer,
    private readonly config: ServerConfig,
    private readonly health: HealthService,
    private readonly metrics: RuntimeMetrics,
    private readonly logger: Logger,
    private readonly options: DrainOptions
  ) {}

  begin(reason: string): void {
    if (this.draining) return;
    this.draining = true;
    this.deadlineAt = Date.now() + this.config.drainTimeoutMs;
    this.health.beginDraining();
    this.options.beginDraining?.();
    this.metrics.increment('server_drain_started_total');
    this.logger.warn('server_draining', { reason, deadlineAt: this.deadlineAt, activePlayers: this.options.activePlayers() });
    this.io.emit('server:draining', {
      message: 'This arcade server is restarting soon. Existing sessions may continue briefly.',
      deadlineAt: this.deadlineAt,
      warningMs: this.config.shutdownWarningMs
    });
    this.pollTimer = setInterval(() => this.poll(), 250);
    this.pollTimer.unref();
    this.poll();
  }

  private poll(): void {
    if (this.options.activePlayers() > 0 && Date.now() < this.deadlineAt) return;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.finishing) return;
    this.finishing = true;
    void this.finish();
  }

  private async finish(): Promise<void> {
    await this.options.stopTimers();
    this.metrics.increment('server_drain_completed_total');
    this.logger.info('server_shutdown', { activePlayers: this.options.activePlayers(), durationMs: this.config.drainTimeoutMs - Math.max(0, this.deadlineAt - Date.now()) });
    this.metrics.close();
    await new Promise<void>((resolve, reject) => {
      void this.io.close((error) => { if (error) reject(error); else resolve(); });
    });
    await new Promise<void>((resolve) => { this.httpServer.close(() => resolve()); });
    process.exitCode = 0;
  }
}
