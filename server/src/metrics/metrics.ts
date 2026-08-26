import { monitorEventLoopDelay } from 'node:perf_hooks';

export interface RuntimeMetricSources {
  connectedSockets(): number;
  activePlayers(): number;
  activeRooms(): number;
  averageRoomPopulation(): number;
  draining(): boolean;
  /**
   * Milestone 11.37 gauges. Optional so a caller that has not wired a subsystem
   * yet simply omits it, rather than reporting a fabricated zero.
   */
  cabinetRegistrySize?(): number;
  activeCabinetStates?(): number;
  cabinetZones?(): number;
  gameRegistrySize?(): number;
  pluginsStarted?(): number;
  pluginsFailed?(): number;
  jobQueueDepth?(): number;
  jobsDeadLettered?(): number;
  eventBusHandlerFailures?(): number;
  operatorSessions?(): number;
}

export class RuntimeMetrics {
  private readonly startedAt = Date.now();
  private readonly counters = new Map<string, number>();
  private readonly eventLoop = monitorEventLoopDelay({ resolution: 20 });
  private networkBytesReceived = 0;
  private networkBytesSent = 0;

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

  /**
   * Records a duration in milliseconds as a counter pair, so a rate and a mean
   * can both be derived without shipping a histogram implementation.
   */
  observeDuration(name: string, milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
    this.increment(`${name}_count`);
    this.increment(`${name}_milliseconds_total`, Math.round(milliseconds));
  }

  observeTransportPacket(direction: 'received' | 'sent', payload: unknown): void {
    const bytes = payloadSize(payload);
    if (direction === 'received') this.networkBytesReceived += bytes;
    else this.networkBytesSent += bytes;
  }

  render(): string {
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage();
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
      `arcade_process_external_memory_bytes ${memory.external}`,
      `arcade_process_cpu_user_seconds_total ${(cpu.user / 1_000_000).toFixed(6)}`,
      `arcade_process_cpu_system_seconds_total ${(cpu.system / 1_000_000).toFixed(6)}`,
      `arcade_transport_received_bytes_total ${this.networkBytesReceived}`,
      `arcade_transport_sent_bytes_total ${this.networkBytesSent}`,
      `arcade_event_loop_delay_mean_seconds ${(this.eventLoopDelayMs() / 1_000).toFixed(6)}`,
      `arcade_event_loop_delay_p50_seconds ${percentileSeconds(this.eventLoop, 50).toFixed(6)}`,
      `arcade_event_loop_delay_p95_seconds ${percentileSeconds(this.eventLoop, 95).toFixed(6)}`,
      `arcade_event_loop_delay_p99_seconds ${percentileSeconds(this.eventLoop, 99).toFixed(6)}`,
      `arcade_event_loop_delay_max_seconds ${(this.eventLoop.max / 1_000_000_000).toFixed(6)}`
    ];
    // Only gauges whose source is wired are emitted: a metric that is always
    // zero because nothing reports it is worse than an absent one.
    const gauges: Array<[string, (() => number) | undefined]> = [
      ['arcade_cabinet_registry_size', this.sources.cabinetRegistrySize],
      ['arcade_active_cabinet_states', this.sources.activeCabinetStates],
      ['arcade_cabinet_zones', this.sources.cabinetZones],
      ['arcade_game_registry_size', this.sources.gameRegistrySize],
      ['arcade_plugins_started', this.sources.pluginsStarted],
      ['arcade_plugins_failed', this.sources.pluginsFailed],
      ['arcade_job_queue_depth', this.sources.jobQueueDepth],
      ['arcade_jobs_dead_lettered', this.sources.jobsDeadLettered],
      ['arcade_event_bus_handler_failures', this.sources.eventBusHandlerFailures],
      ['arcade_operator_sessions', this.sources.operatorSessions]
    ];
    for (const [name, read] of gauges) {
      if (read === undefined) continue;
      const value = read.call(this.sources);
      if (Number.isFinite(value)) lines.push(`${name} ${value}`);
    }
    for (const [name, value] of [...this.counters].sort(([left], [right]) => left.localeCompare(right))) {
      lines.push(`${name} ${value}`);
    }
    return `${lines.join('\n')}\n`;
  }

  close(): void {
    this.eventLoop.disable();
  }
}

function percentileSeconds(histogram: ReturnType<typeof monitorEventLoopDelay>, percentile: number): number {
  const value = histogram.percentile(percentile) / 1_000_000_000;
  return Number.isFinite(value) ? value : 0;
}

function payloadSize(payload: unknown): number {
  if (typeof payload === 'string') return Buffer.byteLength(payload);
  if (Buffer.isBuffer(payload)) return payload.byteLength;
  if (payload instanceof ArrayBuffer) return payload.byteLength;
  if (ArrayBuffer.isView(payload)) return payload.byteLength;
  if (payload === undefined || payload === null) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(payload));
  } catch {
    return 0;
  }
}

function metricName(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_:]/g, '_');
  return normalized.startsWith('arcade_') ? normalized : `arcade_${normalized}`;
}
