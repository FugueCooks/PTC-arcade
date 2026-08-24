import type { ServerConfig } from '../config.js';
import type { RuntimeMetrics } from '../metrics/metrics.js';

export interface HealthSources {
  connectedSockets(): number;
  activePlayers(): number;
  activeRooms(): number;
  coordinationRequired?(): boolean;
  coordinationReady?(): boolean;
  databaseRequired?(): boolean;
  databaseReady?(): boolean;
}

export interface ReadinessResult {
  ready: boolean;
  reasons: string[];
}

export class HealthService {
  private initialized = false;
  private draining = false;
  private criticalFailure = false;

  constructor(
    private readonly config: ServerConfig,
    private readonly metrics: RuntimeMetrics,
    private readonly sources: HealthSources
  ) {}

  markInitialized(): void { this.initialized = true; }
  beginDraining(): void { this.draining = true; }
  markCriticalFailure(): void { this.criticalFailure = true; }
  get isDraining(): boolean { return this.draining; }

  readiness(): ReadinessResult {
    const reasons: string[] = [];
    if (!this.initialized) reasons.push('initializing');
    if (this.draining) reasons.push('draining');
    if (this.criticalFailure) reasons.push('critical-manager-failure');
    if (this.sources.coordinationRequired?.() && !this.sources.coordinationReady?.()) reasons.push('redis-unavailable');
    if (this.sources.databaseRequired?.() && !this.sources.databaseReady?.()) reasons.push('database-unavailable');
    if (this.sources.connectedSockets() >= this.config.maxPendingConnections + this.config.maxPlayersPerServer) reasons.push('connection-capacity');
    if (this.sources.activePlayers() >= this.config.maxPlayersPerServer) reasons.push('player-capacity');
    if (this.sources.activeRooms() > this.config.maxRoomsPerServer) reasons.push('room-capacity');
    if (process.memoryUsage().rss > this.config.maxMemoryMb * 1024 * 1024) reasons.push('memory-threshold');
    if (this.metrics.eventLoopDelayMs() > this.config.maxEventLoopDelayMs) reasons.push('event-loop-delay');
    return { ready: reasons.length === 0, reasons };
  }
}
