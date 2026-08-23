import { monitorEventLoopDelay } from 'node:perf_hooks';

export interface RuntimeMetricSources {
  connectedSockets(): number;
  activePlayers(): number;
  activeRooms(): number;
  averageRoomPopulation(): number;
  draining(): boolean;
}

export class RuntimeMetrics {
  private readonly startedAt = Date.now();
  private readonly counters = new Map<string, number>();
  private readonly eventLoop = monitorEventLoopDelay({ resolution: 20 });

  constructor(private readonly sources: RuntimeMetricSources) {
    this.eventLoop.enable();
  }

  increment(name: string, amount = 1): void {
    this.counters.set(metricName(name), (this.counters.get(metricName(name)) ?? 0) + amount);
  }

  eventLoopDelayMs(): number {
    const mean = this.eventLoop.mean / 1_000_000;
    return Number.isFinite(mean) ? mean : 0;
  }

  render(): string {
    const memory = process.memoryUsage();
    const lines = [
      '# HELP arcade_process_start_time_seconds Process start time.',
      '# TYPE arcade_process_start_time_seconds gauge',
      `arcade_process_start_time_seconds ${Math.floor(this.startedAt / 1_000)}`,
      `arcade_connected_sockets ${this.sources.connectedSockets()}`,
      `arcade_active_players ${this.sources.activePlayers()}`,
      `arcade_active_rooms ${this.sources.activeRooms()}`,
      `arcade_average_room_population ${this.sources.averageRoomPopulation().toFixed(3)}`,
      `arcade_server_draining ${this.sources.draining() ? 1 : 0}`,
      `arcade_process_resident_memory_bytes ${memory.rss}`,
      `arcade_process_heap_used_bytes ${memory.heapUsed}`,
      `arcade_event_loop_delay_mean_seconds ${(this.eventLoopDelayMs() / 1_000).toFixed(6)}`,
      `arcade_event_loop_delay_max_seconds ${(this.eventLoop.max / 1_000_000_000).toFixed(6)}`
    ];
    for (const [name, value] of [...this.counters].sort(([left], [right]) => left.localeCompare(right))) {
      lines.push(`${name} ${value}`);
    }
    return `${lines.join('\n')}\n`;
  }

  close(): void {
    this.eventLoop.disable();
  }
}

function metricName(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_:]/g, '_');
  return normalized.startsWith('arcade_') ? normalized : `arcade_${normalized}`;
}
