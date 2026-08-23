import type { Express, Response } from 'express';
import type { ServerConfig } from '../config.js';
import type { HealthService } from '../health/health-service.js';
import type { RuntimeMetrics } from '../metrics/metrics.js';

export function installOperationalRoutes(
  app: Express,
  config: ServerConfig,
  health: HealthService,
  metrics: RuntimeMetrics,
  startedAt: number
): void {
  const live = (_request: unknown, response: Response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.json({ ok: true, service: 'roms-retro-arcade', serverId: config.serverId, version: config.softwareVersion, startedAt });
  };
  app.get('/health', live);
  app.get('/healthz', live);
  app.get('/ready', (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const result = health.readiness();
    response.status(result.ready ? 200 : 503).json({ ok: result.ready, acceptingPlayers: result.ready, reasons: result.reasons });
  });
  app.get('/metrics', (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.type('text/plain; version=0.0.4').send(metrics.render());
  });
}
