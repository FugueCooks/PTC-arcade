import type { SafeJsonValue } from '../domain/json-value.js';

/**
 * Milestone 11.25 — operator-safe platform status.
 *
 * This is operational control, not moderation: there is no chat, no message
 * history, and no social data anywhere in these shapes. Player identity appears
 * only as a public ID on a cabinet an operator may need to free, and never as
 * an email, wallet address, display name, or token.
 */
export interface ServerStatus {
  serverId: string;
  region: string;
  version: string;
  uptimeSeconds: number;
  roomCount: number;
  playerCount: number;
  capacity: { maxPlayers: number; maxRooms: number };
  draining: boolean;
  ready: boolean;
  readinessReasons: readonly string[];
  eventLoopDelayMs: number;
  memoryRssBytes: number;
}

export interface RoomStatus {
  roomId: string;
  population: number;
  owningServerId: string;
  status: 'active' | 'draining';
  activeCabinetCount: number;
  createdAt: number | null;
}

export interface CabinetStatus {
  cabinetId: string;
  zoneId: string;
  gameId: string | null;
  state: string;
  /** Present only while a cabinet is held, so an operator can free it. */
  occupantPublicId: string | null;
  enabled: boolean;
  maintenance: boolean;
  failureCount: number;
  lastSuccessfulSessionAt: number | null;
}

export interface DependencyHealth {
  name: string;
  required: boolean;
  ready: boolean;
  detail: string | null;
}

export interface OperationsOverview {
  at: number;
  deploymentVersion: string;
  server: ServerStatus;
  totals: {
    onlinePlayers: number;
    activeRooms: number;
    activeCabinets: number;
    activeGameSessions: number;
    pendingCompetitiveVerifications: number;
  };
  dependencies: readonly DependencyHealth[];
  plugins: { total: number; started: number; failed: number; disabled: number; failures: readonly { pluginId: string; error: string }[] };
  emulatorAdapters: readonly { adapterId: string; platforms: readonly string[] }[];
  registry: { cabinetDefinitions: number; zones: number; gameDefinitions: number };
  featureFlags: Readonly<Record<string, boolean>>;
  replay: { supported: false; note: string };
  queues: readonly { name: string; depth: number; failed: number }[];
}

export interface OperationsSources {
  server(): ServerStatus;
  rooms(): readonly RoomStatus[];
  cabinets(roomId?: string): readonly CabinetStatus[];
  dependencies(): readonly DependencyHealth[];
  plugins(): OperationsOverview['plugins'];
  emulatorAdapters(): OperationsOverview['emulatorAdapters'];
  registry(): OperationsOverview['registry'];
  featureFlags(): Readonly<Record<string, boolean>>;
  activeGameSessions(): number;
  queues(): readonly { name: string; depth: number; failed: number }[];
}

export class OperationsService {
  constructor(private readonly sources: OperationsSources, private readonly deploymentVersion: string) {}

  overview(now = Date.now()): OperationsOverview {
    const server = this.sources.server();
    const rooms = this.sources.rooms();
    const cabinets = this.sources.cabinets();
    return {
      at: now,
      deploymentVersion: this.deploymentVersion,
      server,
      totals: {
        onlinePlayers: server.playerCount,
        activeRooms: rooms.length,
        activeCabinets: cabinets.filter(({ state }) => state !== 'available').length,
        activeGameSessions: this.sources.activeGameSessions(),
        // Declared for the dashboard's shape; the competitive layer this would
        // count does not exist, and reporting a fabricated number would be worse
        // than reporting zero with an explanation.
        pendingCompetitiveVerifications: 0
      },
      dependencies: this.sources.dependencies(),
      plugins: this.sources.plugins(),
      emulatorAdapters: this.sources.emulatorAdapters(),
      registry: this.sources.registry(),
      featureFlags: this.sources.featureFlags(),
      replay: { supported: false, note: 'Replay and ghost systems are deferred to Phase 12.' },
      queues: this.sources.queues()
    };
  }

  servers(): readonly ServerStatus[] { return [this.sources.server()]; }
  rooms(): readonly RoomStatus[] { return this.sources.rooms(); }
  cabinets(roomId?: string): readonly CabinetStatus[] { return this.sources.cabinets(roomId); }
}

/** Serializes any structure the operations API returns, JSON-safe. */
export function toSafeJson(value: unknown): SafeJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as SafeJsonValue;
}
