import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

export interface ServerConfig {
  port: number;
  trustProxy: boolean;
  serverId: string;
  region: string;
  softwareVersion: string;
  maxPlayersPerRoom: number;
  minAvailableRooms: number;
  roomIdleTimeoutMs: number;
  maxRoomsPerServer: number;
  maxPlayersPerServer: number;
  maxPendingConnections: number;
  reconnectGraceMs: number;
  maxMemoryMb: number;
  maxEventLoopDelayMs: number;
  drainTimeoutMs: number;
  shutdownWarningMs: number;
  redisUrl?: string;
  redisRequired: boolean;
  redisStartupTimeoutMs: number;
  redisKeyPrefix: string;
  serverHeartbeatMs: number;
  serverTtlMs: number;
  roomDirectoryTtlMs: number;
  roomOwnershipTtlMs: number;
  publicRealtimeUrl?: string;
  matchmakingUrl?: string;
  admissionReservationTtlMs: number;
  databaseUrl?: string;
  databaseRequired: boolean;
  databaseStartupTimeoutMs: number;
  databasePoolMax: number;
  sessionTtlMs: number;
  guestSessionTtlMs: number;
  passwordArgon2MemoryKib: number;
  passwordArgon2Iterations: number;
  passwordArgon2Parallelism: number;
  authCookieName: string;
  authCookieSecure: boolean;
  authRequestLimit: number;
  authAllowedOrigin?: string;
  developmentAuthTokens: boolean;
  multiplayerTicketSecret?: string;
  multiplayerTicketTtlMs: number;
}

export function loadServerConfig(environment: NodeJS.ProcessEnv = process.env): ServerConfig {
  const deploymentId = cleanIdentifier(environment.SERVER_ID)
    ?? cleanIdentifier(environment.RENDER_INSTANCE_ID)
    ?? cleanIdentifier(environment.FLY_MACHINE_ID);
  const generatedId = `${cleanIdentifier(hostname()) ?? 'arcade'}-${process.pid}-${randomUUID().slice(0, 8)}`;

  const configuredRedisUrl = redisUrl(environment.REDIS_URL);
  const configuredDatabaseUrl = databaseUrl(environment.DATABASE_URL);
  const minAvailableRooms = integer(environment.MIN_AVAILABLE_ROOMS, 1, 1, 100);
  const maxRoomsPerServer = integer(environment.MAX_ROOMS_PER_SERVER, 10, 1, 100);
  if (minAvailableRooms > maxRoomsPerServer) throw new Error('MIN_AVAILABLE_ROOMS cannot exceed MAX_ROOMS_PER_SERVER.');
  if (environment.REDIS_REQUIRED === '1' && !configuredRedisUrl) throw new Error('REDIS_REQUIRED=1 requires REDIS_URL.');
  if (environment.DATABASE_REQUIRED === '1' && !configuredDatabaseUrl) throw new Error('DATABASE_REQUIRED=1 requires DATABASE_URL.');
  return {
    port: integer(environment.PORT, 8080, 1, 65_535),
    trustProxy: environment.TRUST_PROXY === '1',
    serverId: deploymentId ?? generatedId,
    region: cleanIdentifier(environment.SERVER_REGION ?? environment.RENDER_REGION ?? environment.FLY_REGION) ?? 'local',
    softwareVersion: cleanVersion(environment.SOFTWARE_VERSION ?? environment.RENDER_GIT_COMMIT ?? environment.FLY_IMAGE_REF) ?? 'development',
    maxPlayersPerRoom: integer(environment.MAX_PLAYERS_PER_ROOM, 25, 2, 48),
    minAvailableRooms,
    roomIdleTimeoutMs: seconds(environment.ROOM_IDLE_TIMEOUT_SECONDS, 900, 30, 86_400),
    maxRoomsPerServer,
    maxPlayersPerServer: integer(environment.MAX_PLAYERS_PER_SERVER, 250, 2, 5_000),
    maxPendingConnections: integer(environment.MAX_PENDING_CONNECTIONS, 128, 1, 10_000),
    reconnectGraceMs: seconds(environment.RECONNECT_GRACE_SECONDS, 10, 5, 300),
    maxMemoryMb: integer(environment.MAX_SERVER_MEMORY_MB, 768, 128, 65_536),
    maxEventLoopDelayMs: integer(environment.MAX_EVENT_LOOP_DELAY_MS, 150, 10, 10_000),
    drainTimeoutMs: seconds(environment.SERVER_DRAIN_TIMEOUT_SECONDS, 45, 5, 3_600),
    shutdownWarningMs: seconds(environment.SERVER_SHUTDOWN_WARNING_SECONDS, 15, 0, 600),
    redisUrl: configuredRedisUrl,
    redisRequired: environment.REDIS_REQUIRED === '1',
    redisStartupTimeoutMs: seconds(environment.REDIS_STARTUP_TIMEOUT_SECONDS, 5, 1, 60),
    redisKeyPrefix: cleanKeyPrefix(environment.REDIS_KEY_PREFIX) ?? 'arcade:v1:development',
    serverHeartbeatMs: seconds(environment.SERVER_HEARTBEAT_SECONDS, 10, 2, 60),
    serverTtlMs: seconds(environment.SERVER_TTL_SECONDS, 35, 10, 300),
    roomDirectoryTtlMs: seconds(environment.ROOM_DIRECTORY_TTL_SECONDS, 45, 10, 600),
    roomOwnershipTtlMs: seconds(environment.ROOM_OWNERSHIP_TTL_SECONDS, 30, 5, 300),
    publicRealtimeUrl: publicUrl(environment.PUBLIC_REALTIME_URL),
    matchmakingUrl: publicUrl(environment.MATCHMAKING_URL),
    admissionReservationTtlMs: seconds(environment.ADMISSION_RESERVATION_TTL_SECONDS, 15, 5, 60),
    databaseUrl: configuredDatabaseUrl,
    databaseRequired: environment.DATABASE_REQUIRED === '1',
    databaseStartupTimeoutMs: seconds(environment.DATABASE_STARTUP_TIMEOUT_SECONDS, 5, 1, 60),
    databasePoolMax: integer(environment.DATABASE_POOL_MAX, 10, 1, 100),
    sessionTtlMs: days(environment.SESSION_TTL_DAYS, 30, 1, 365),
    guestSessionTtlMs: days(environment.GUEST_SESSION_TTL_DAYS, 30, 1, 90),
    passwordArgon2MemoryKib: integer(environment.PASSWORD_ARGON2_MEMORY_KIB, 19_456, 7_168, 1_048_576),
    passwordArgon2Iterations: integer(environment.PASSWORD_ARGON2_ITERATIONS, 2, 1, 20),
    passwordArgon2Parallelism: integer(environment.PASSWORD_ARGON2_PARALLELISM, 1, 1, 8),
    authCookieName: cleanCookieName(environment.AUTH_COOKIE_NAME) ?? 'arcade_session',
    authCookieSecure: environment.NODE_ENV === 'production' || environment.AUTH_COOKIE_SECURE === '1',
    authRequestLimit: integer(environment.AUTH_REQUEST_LIMIT_PER_10_MINUTES, 30, 5, 1_000),
    authAllowedOrigin: publicUrl(environment.PUBLIC_APP_ORIGIN),
    developmentAuthTokens: environment.NODE_ENV !== 'production' && environment.AUTH_DEVELOPMENT_TOKENS === '1',
    multiplayerTicketSecret: secret(environment.MULTIPLAYER_TICKET_SECRET),
    multiplayerTicketTtlMs: seconds(environment.MULTIPLAYER_TICKET_TTL_SECONDS, 30, 10, 120)
  };
}

function publicUrl(value: string | undefined): string | undefined {
  const cleaned = value?.trim().replace(/\/$/, '');
  if (!cleaned) return undefined;
  const parsed = new URL(cleaned);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('Public service URLs must use http:// or https://.');
  return cleaned;
}

function integer(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Invalid numeric server configuration; expected an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function seconds(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  return integer(value, fallback, minimum, maximum) * 1_000;
}

function days(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  return integer(value, fallback, minimum, maximum) * 24 * 60 * 60 * 1_000;
}

function cleanIdentifier(value: string | undefined): string | undefined {
  const cleaned = value?.trim().replace(/[^A-Za-z0-9._:-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 96);
  return cleaned || undefined;
}

function cleanVersion(value: string | undefined): string | undefined {
  const cleaned = value?.trim().replace(/[^A-Za-z0-9._:+/-]/g, '-').slice(0, 128);
  return cleaned || undefined;
}

function redisUrl(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  if (!cleaned) return undefined;
  const parsed = new URL(cleaned);
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') throw new Error('REDIS_URL must use redis:// or rediss://.');
  return cleaned;
}

function databaseUrl(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  if (!cleaned) return undefined;
  const parsed = new URL(cleaned);
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL must use postgres:// or postgresql://.');
  }
  return cleaned;
}

function cleanKeyPrefix(value: string | undefined): string | undefined {
  const cleaned = value?.trim().replace(/[^A-Za-z0-9:_-]+/g, '-').replace(/:+/g, ':').replace(/^:|:$/g, '').slice(0, 96);
  return cleaned || undefined;
}

function cleanCookieName(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  if (!cleaned) return undefined;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(cleaned)) throw new Error('AUTH_COOKIE_NAME is invalid.');
  return cleaned;
}

function secret(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  if (!cleaned) return undefined;
  if (cleaned.length < 32) throw new Error('MULTIPLAYER_TICKET_SECRET must contain at least 32 characters.');
  return cleaned;
}
