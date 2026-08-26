import { createServer } from 'node:http';
import path from 'node:path';
import express from 'express';
import { Server } from 'socket.io';
import { DEFAULT_ROOM_ID } from './protocol.js';
import type { CabinetState, ClientToServerEvents, ServerToClientEvents } from './protocol.js';
import { PlayerManager } from './players/player-manager.js';
import { validateIdentity } from './players/player-identity.js';
import { RoomManager } from './rooms/room-manager.js';
import { CabinetManager } from './cabinets/cabinet-manager.js';
import { ChatManager } from './social/chat-manager.js';
import { ReactionManager } from './social/reaction-manager.js';
import { PresenceManager } from './social/presence-manager.js';
import { StatusManager } from './social/status-manager.js';
import { WorldManager } from './world/world-manager.js';
import { installStaticHosting, publicRuntimeConfig } from './http/static-hosting.js';
import { loadServerConfig } from './config.js';
import { createLogger } from './logging/logger.js';
import { RuntimeMetrics } from './metrics/metrics.js';
import { HealthService } from './health/health-service.js';
import { installOperationalRoutes } from './http/operational-routes.js';
import { DrainController } from './shutdown/drain-controller.js';
import { InMemoryRoomDirectory } from './rooms/room-directory.js';
import { RoomLifecycleService } from './rooms/room-lifecycle-service.js';
import { RedisConnection } from './redis/redis-connection.js';
import { RedisKeys } from './redis/redis-keys.js';
import { RedisRoomDirectory } from './redis/redis-room-directory.js';
import { RoomOwnershipService } from './redis/room-ownership-service.js';
import { ServerRegistry } from './servers/server-registry.js';
import { createAdapter as createRedisStreamsAdapter } from '@socket.io/redis-streams-adapter';
import { InMemoryRoomAdmission, RedisRoomAdmission } from './rooms/room-admission.js';
import { RoomPlacementService } from './rooms/room-placement-service.js';
import { installMatchmakingRoutes } from './http/matchmaking-routes.js';
import { InMemoryReconnectDirectory, RedisReconnectDirectory } from './players/reconnect-directory.js';
import { DatabaseConnection } from './database/connection.js';
import { PasswordHasher } from './auth/password-hasher.js';
import { SessionTokenService } from './auth/session-token-service.js';
import { DrizzleAuthRepository } from './auth/auth-repository.js';
import { AuthService } from './auth/auth-service.js';
import { installAuthRoutes } from './http/auth-routes.js';
import { RealtimeTicketService, stablePublicPlayerId } from './auth/realtime-ticket.js';
import { readSessionCookie } from './auth/session-cookie.js';
import type { SafeIdentity } from './auth/auth-repository.js';
import { AccountRepository } from './auth/account-repository.js';
import { AccountService } from './auth/account-service.js';
import { installAccountRoutes } from './http/account-routes.js';
import { RedisIdentityDirectory } from './redis/identity-directory.js';
import { InMemoryWalletChallengeStore, RedisWalletChallengeStore } from './auth/wallet-challenge-store.js';
import { WalletChallengeService } from './auth/wallet-challenge-service.js';
import { DrizzleWalletAccountRepository } from './auth/wallet-account-repository.js';
import { WalletAuthService } from './auth/wallet-auth-service.js';
import { installWalletAuthRoutes } from './http/wallet-auth-routes.js';
import { InMemoryAsyncRateLimiter, RedisAsyncRateLimiter } from './auth/distributed-rate-limiter.js';
import { bootstrapPlugins } from './plugins/plugin-bootstrap.js';
import { createOperationsRuntime } from './operations/operations-bootstrap.js';
import { installOperationsRoutes } from './http/operations-routes.js';
import { loadGameRegistry } from './games/game-registry-service.js';
import type { PluginHost } from './plugins/plugin-host.js';

/** Bounds a resync request so one client cannot ask for unbounded work. */
const MAX_RESYNC_ZONES = 16;

function toZoneSnapshotPayload(snapshot: { roomId: string; revision: number; zoneIds: readonly string[]; cabinets: CabinetState[] }) {
  return { roomId: snapshot.roomId, revision: snapshot.revision, zoneIds: [...snapshot.zoneIds], cabinets: snapshot.cabinets };
}

const projectRoot = path.resolve(process.cwd());
let gameRegistry = loadGameRegistry(projectRoot).registry;
const startedAt = Date.now();
const config = loadServerConfig();
const logger = createLogger({ service: 'roms-retro-arcade', serverId: config.serverId, region: config.region, version: config.softwareVersion });
const app = express();
if (config.trustProxy) app.set('trust proxy', 1);
const httpServer = createServer(app);
httpServer.keepAliveTimeout = 65_000;
httpServer.headersTimeout = 66_000;
const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  maxHttpBufferSize: 1_000_000,
  perMessageDeflate: false,
  transports: ['websocket', 'polling']
});
const rooms = new RoomManager(undefined, config.maxPlayersPerRoom, config.serverId, Boolean(config.redisUrl));
const players = new PlayerManager(rooms, config.reconnectGraceMs);
const cabinets = new CabinetManager(players, {
  interactionDistance: Number(process.env.CABINET_INTERACTION_DISTANCE ?? 2.6),
  activationTimeoutMs: Number(process.env.CABINET_ACTIVATION_TIMEOUT_MS ?? 5_000),
  requestCooldownMs: Number(process.env.CABINET_REQUEST_COOLDOWN_MS ?? 250)
});
const presence = new PresenceManager(players, {
  nearbyDistance: Number(process.env.PRESENCE_NEARBY_DISTANCE ?? 12),
  socialDistance: Number(process.env.PRESENCE_SOCIAL_DISTANCE ?? 15),
  farUpdateIntervalMs: Number(process.env.PRESENCE_FAR_UPDATE_INTERVAL_MS ?? 300)
});
const statuses = new StatusManager(players, { afkTimeoutMs: Number(process.env.AFK_TIMEOUT_MS ?? 120_000) });
const chat = new ChatManager(players, { maxLength: Number(process.env.CHAT_MAX_LENGTH ?? 180) });
const reactions = new ReactionManager(players, Number(process.env.REACTION_COOLDOWN_MS ?? 550));
const world = new WorldManager(players, Number(process.env.WORLD_REQUEST_COOLDOWN_MS ?? 500));

let health: HealthService;
const metrics = new RuntimeMetrics({
  connectedSockets: () => io.engine.clientsCount,
  activePlayers: () => players.connectedCount,
  activeRooms: () => rooms.roomCount,
  averageRoomPopulation: () => rooms.averagePopulation,
  draining: () => health?.isDraining ?? false
});
io.engine.on('connection', (transportSocket) => {
  transportSocket.on('packet', (packet: { data?: unknown }) => metrics.observeTransportPacket('received', packet.data));
  transportSocket.on('packetCreate', (packet: { data?: unknown }) => metrics.observeTransportPacket('sent', packet.data));
});
const redis = config.redisUrl ? new RedisConnection(config.redisUrl, logger, metrics) : undefined;
let redisBootstrapped = false;
if (redis) {
  try {
    redisBootstrapped = await redis.connect(config.redisStartupTimeoutMs);
    if (redisBootstrapped) {
      io.adapter(createRedisStreamsAdapter(redis.client, {
        streamName: new RedisKeys(config.redisKeyPrefix).socketStream(),
        sessionKeyPrefix: new RedisKeys(config.redisKeyPrefix).socketSessions(),
        maxLen: 10_000,
        onlyPlaintext: true
      }));
      logger.info('socket_redis_streams_adapter_ready');
    } else {
      metrics.increment('redis_startup_timeout_total');
      logger.error('redis_startup_unavailable', { timeoutMs: config.redisStartupTimeoutMs, restartRequired: true });
    }
  } catch (error) {
    metrics.increment('redis_startup_failure_total');
    logger.error('redis_startup_failed', { errorMessage: error instanceof Error ? error.message : 'unknown' });
  }
}
const database = config.databaseUrl ? new DatabaseConnection(config.databaseUrl, config.databasePoolMax, logger, metrics) : undefined;
let databaseBootstrapped = false;
if (database) {
  databaseBootstrapped = await database.connect(config.databaseStartupTimeoutMs);
  if (!databaseBootstrapped && config.databaseRequired) logger.error('database_startup_required_unavailable');
}
const passwordHasher = new PasswordHasher({
  memoryCostKib: config.passwordArgon2MemoryKib,
  iterations: config.passwordArgon2Iterations,
  parallelism: config.passwordArgon2Parallelism
});
const authRepository = database ? new DrizzleAuthRepository(database.db) : undefined;
const registeredSessionTokens = new SessionTokenService(config.sessionTtlMs);
const authService = authRepository ? new AuthService(
  authRepository, passwordHasher,
  registeredSessionTokens, new SessionTokenService(config.guestSessionTtlMs),
  await passwordHasher.hash('not-a-real-account-password')
) : undefined;
const accountService = database ? new AccountService(new AccountRepository(database.db), passwordHasher) : undefined;
const realtimeTickets = config.multiplayerTicketSecret
  ? new RealtimeTicketService(config.multiplayerTicketSecret, config.multiplayerTicketTtlMs)
  : undefined;
health = new HealthService(config, metrics, {
  connectedSockets: () => io.engine.clientsCount,
  activePlayers: () => players.connectedCount,
  activeRooms: () => rooms.roomCount,
  coordinationRequired: () => config.redisRequired,
  coordinationReady: () => redisBootstrapped && (redis?.isReady ?? false),
  databaseRequired: () => config.databaseRequired,
  databaseReady: () => databaseBootstrapped && (database?.isReady ?? false)
});
const redisKeys = new RedisKeys(config.redisKeyPrefix);
const walletChallengeStore = redisBootstrapped && redis
  ? new RedisWalletChallengeStore(redis.client, redisKeys) : new InMemoryWalletChallengeStore();
const walletChallenges = new WalletChallengeService(walletChallengeStore, config);
const walletAuthService = database && authRepository ? new WalletAuthService(walletChallenges,
  new DrizzleWalletAccountRepository(database.db), registeredSessionTokens, authRepository, config.solanaNetwork) : undefined;
const walletChallengeLimiter = redisBootstrapped && redis
  ? new RedisAsyncRateLimiter(redis.client, redisKeys, Math.max(5, Math.floor(config.authRequestLimit / 2)), 10 * 60_000)
  : new InMemoryAsyncRateLimiter(Math.max(5, Math.floor(config.authRequestLimit / 2)), 10 * 60_000);
const walletVerificationLimiter = redisBootstrapped && redis
  ? new RedisAsyncRateLimiter(redis.client, redisKeys, config.authRequestLimit, 10 * 60_000)
  : new InMemoryAsyncRateLimiter(config.authRequestLimit, 10 * 60_000);
const authenticationLimiter = redisBootstrapped && redis
  ? new RedisAsyncRateLimiter(redis.client, redisKeys, config.authRequestLimit, 10 * 60_000)
  : new InMemoryAsyncRateLimiter(config.authRequestLimit, 10 * 60_000);
const identityDirectory = redisBootstrapped && redis ? new RedisIdentityDirectory(redis.client, redisKeys, config.serverId) : undefined;
const roomDirectory = redisBootstrapped && redis ? new RedisRoomDirectory(redis.client, redisKeys, config.roomDirectoryTtlMs) : new InMemoryRoomDirectory();
const roomOwnership = redisBootstrapped && redis ? new RoomOwnershipService(redis.client, redisKeys, config.serverId, config.roomOwnershipTtlMs) : undefined;
const roomLifecycle = new RoomLifecycleService(rooms, roomDirectory, metrics, logger, roomOwnership, Math.max(1_000, Math.floor(config.roomOwnershipTtlMs / 3)));
await roomLifecycle.start();
roomLifecycle.ensureAvailable(config.minAvailableRooms, config.maxRoomsPerServer);
await roomLifecycle.flush();
const serverRegistry = redisBootstrapped && redis ? new ServerRegistry(redis.client, redisKeys, config, {
  roomCount: () => rooms.roomCount,
  playerCount: () => players.connectedCount,
  draining: () => health.isDraining,
  healthy: () => redis.isReady
}, metrics, logger) : undefined;
await serverRegistry?.start();
const roomAdmission = redisBootstrapped && redis
  ? new RedisRoomAdmission(redis.client, redisKeys, config.admissionReservationTtlMs)
  : new InMemoryRoomAdmission(config.admissionReservationTtlMs);
const roomPlacement = new RoomPlacementService(rooms, roomDirectory, roomLifecycle, roomAdmission, serverRegistry, config, metrics);
const reconnectDirectory = redisBootstrapped && redis ? new RedisReconnectDirectory(redis.client, redisKeys) : new InMemoryReconnectDirectory();

installOperationalRoutes(app, config, health, metrics, startedAt);
app.use(express.json({ limit: '16kb' }));
installAuthRoutes(app, config, { service: authService, tickets: realtimeTickets,
  limiter: authenticationLimiter,
  databaseReady: () => databaseBootstrapped && (database?.isReady ?? false) });
installWalletAuthRoutes(app, config, { challenges: walletChallenges, walletAuth: walletAuthService,
  challengeLimiter: walletChallengeLimiter, verificationLimiter: walletVerificationLimiter,
  ready: () => databaseBootstrapped && (database?.isReady ?? false) && (!config.redisRequired || Boolean(redis?.isReady)) });
installAccountRoutes(app, config, {
  auth: authService, accounts: accountService, databaseReady: () => databaseBootstrapped && (database?.isReady ?? false),
  identityChanged: (identity) => { players.updateIdentity(stablePublicPlayerId(identity), { displayName: identity.displayName, avatarId: identity.avatarId }); },
  accountDeleted: (identity) => {
    const socketId = players.socketIdForPlayerId(stablePublicPlayerId(identity));
    if (socketId) io.sockets.sockets.get(socketId)?.disconnect(true);
  }
});
installMatchmakingRoutes(app, roomPlacement, roomDirectory, reconnectDirectory, config, () => health.readiness().ready);
installStaticHosting(app, projectRoot, publicRuntimeConfig());

const socketIdentities = new Map<string, SafeIdentity>();
const socketPlayerIds = new Map<string, string>();
io.use(async (socket, next) => {
  const readiness = health.readiness();
  const connectionLimit = config.maxPlayersPerServer + config.maxPendingConnections;
  if (!readiness.ready || io.engine.clientsCount > connectionLimit) {
    metrics.increment('socket_connections_rejected_total');
    next(new Error('server-unavailable'));
    return;
  }
  if (authService && databaseBootstrapped) {
    try {
      const token = readSessionCookie(socket.handshake.headers.cookie, config.authCookieName);
      const session = await authService.session(token);
      if (!session) {
        metrics.increment('socket_authentication_rejected_total');
        next(new Error('authentication-required'));
        return;
      }
      socketIdentities.set(socket.id, session.identity);
      const playerId = stablePublicPlayerId(session.identity);
      socketPlayerIds.set(socket.id, playerId);
      const prior = await identityDirectory?.claim(playerId, socket.id);
      if (prior && prior.socketId !== socket.id) io.in(prior.socketId).disconnectSockets(true);
    } catch {
      metrics.increment('socket_authentication_failure_total');
      next(new Error('authentication-unavailable'));
      return;
    }
  }
  next();
});

// The Socket.IO layer only translates domain events. Multiplayer rules stay in PlayerManager.
players.subscribe((event) => {
  cabinets.handlePlayerEvent(event);
  statuses.handlePlayerEvent(event);
  chat.handlePlayerEvent(event);
  reactions.handlePlayerEvent(event);
  world.handlePlayerEvent(event);
  switch (event.type) {
    case 'PlayerJoined':
      io.to(event.roomId).except(event.socketId).emit('player:joined', event.player);
      break;
    case 'PlayerMoved':
      for (const socketId of presence.movementRecipients(event.player, event.socketId)) {
        io.to(socketId).emit('player:moved', event.player);
      }
      break;
    case 'PlayerDisconnected':
      {
        const route = players.reconnectRouteForPlayerId(event.playerId);
        if (route) {
          void reconnectDirectory.save(route.resumeToken, {
            playerId: event.playerId,
            roomId: route.roomId,
            serverId: config.serverId,
            expiresAt: Date.now() + config.reconnectGraceMs
          }).catch(() => metrics.increment('reconnect_route_refresh_failure_total'));
        }
      }
      io.to(event.roomId).emit('player:disconnected', { id: event.playerId });
      break;
    case 'PlayerReconnected':
      io.to(event.roomId).except(event.socketId).emit('player:reconnected', event.player);
      break;
    case 'PlayerLeft':
      presence.remove(event.playerId);
      void roomAdmission.release(event.roomId, event.playerId).catch(() => metrics.increment('admission_release_failure_total'));
      io.to(event.roomId).emit('player:left', { id: event.playerId });
      break;
    case 'PlayerStatusChanged':
      io.to(event.roomId).emit('player:status', { id: event.playerId, status: event.status, at: event.at });
      break;
  }
});

chat.subscribe((event) => io.to(event.message.roomId).emit('chat:message', event.message));

reactions.subscribe((event) => {
  const recipients = presence.nearbySocketIds(event.event.playerId);
  for (const socketId of recipients) io.to(socketId).emit('reaction:shown', event.event);
});

world.subscribe((event) => {
  if (event.type === 'WorldStateChanged') {
    rooms.bumpStateRevision(event.state.roomId, 'world');
    io.to(event.state.roomId).emit('world:state-changed', event.state);
  }
  if (event.type === 'WorldAnnouncement') {
    io.to(event.announcement.roomId).emit('world:announcement', event.announcement);
    chat.announce(event.announcement.roomId, event.announcement.text, event.announcement.at);
  }
  if (event.type === 'WorldEventTriggered') io.to(event.event.roomId).emit('world:event', event.event);
});

cabinets.subscribe((event) => {
  if (event.type === 'CabinetStateChanged') {
    rooms.bumpStateRevision(event.roomId, 'cabinet');
    // Milestone 11.14: the revision-stamped delta is the scaled channel. The
    // unstamped event stays alongside it so clients that predate zone streaming
    // keep working through the migration (Milestone 11.39).
    io.to(event.roomId).emit('cabinet:delta', { roomId: event.roomId, revision: event.revision, zoneId: event.zoneId, state: event.state });
    io.to(event.roomId).emit('cabinet:state-changed', event.state);
    metrics.increment('cabinet_delta_published_total');
  }
  if (event.type === 'CabinetForcedRelease') {
    const socketId = players.socketIdForPlayerId(event.playerId);
    if (socketId) io.to(socketId).emit('cabinet:forced-release', { cabinetId: event.cabinetId, reason: event.reason });
  }
});

io.on('connection', (socket) => {
  let joined = false;
  metrics.increment('socket_connections_total');

  socket.on('room:join', async (request) => {
    metrics.increment('events_room_join_received_total');
    if (joined) return;
    const readiness = health.readiness();
    if (!readiness.ready) {
      metrics.increment('join_rejected_unavailable_total');
      socket.emit('room:error', { code: 'server-unavailable', message: 'This arcade server is temporarily unavailable. Please retry shortly.' });
      return;
    }
    const roomId = typeof request?.roomId === 'string' ? request.roomId : DEFAULT_ROOM_ID;
    const resumeToken = typeof request?.resumeToken === 'string' ? request.resumeToken : undefined;
    const reservationToken = typeof request?.reservationToken === 'string' ? request.reservationToken : undefined;
    const authenticatedIdentity = socketIdentities.get(socket.id);
    const identity = authenticatedIdentity
      ? { displayName: authenticatedIdentity.displayName, avatarId: authenticatedIdentity.avatarId }
      : validateIdentity(request?.identity);
    if (!identity) {
      metrics.increment('join_rejected_invalid_identity_total');
      socket.emit('room:error', { message: 'Choose a valid display name before entering the arcade.' });
      return;
    }
    const requestedRoom = rooms.get(roomId) ?? rooms.getDefault();
    if (!requestedRoom.acceptsPlayers && !players.canResume(resumeToken, requestedRoom.id)) {
      metrics.increment('join_rejected_room_full_total');
      socket.emit('room:error', { code: 'room-full', message: 'This arcade room is full. Choose another instance.' });
      return;
    }
    const stablePlayerId = authenticatedIdentity ? stablePublicPlayerId(authenticatedIdentity) : undefined;
    const result = players.join(socket.id, roomId, resumeToken, identity, Date.now(), stablePlayerId);
    if (result.replacedSocketId) {
      const replaced = io.sockets.sockets.get(result.replacedSocketId);
      replaced?.emit('room:error', { code: 'session-replaced', message: 'This account continued in another browser window.' });
      replaced?.disconnect(true);
    }
    if (!result.resumed && reservationToken) {
      const confirmed = await roomAdmission.confirm(result.snapshot.roomId, reservationToken, result.player.id);
      if (!confirmed) {
        players.removeSocketNow(socket.id);
        metrics.increment('join_rejected_expired_reservation_total');
        socket.emit('room:error', { code: 'reservation-expired', message: 'Your arcade spot expired before entry. Please retry.' });
        return;
      }
    } else if (result.resumed && reservationToken) {
      await roomAdmission.release(requestedRoom.id, undefined, reservationToken);
    } else if (!result.resumed && config.redisRequired) {
      players.removeSocketNow(socket.id);
      metrics.increment('join_rejected_missing_reservation_total');
      socket.emit('room:error', { code: 'reservation-required', message: 'Reserve an arcade spot before connecting.' });
      return;
    }
    joined = true;
    void socket.join(result.snapshot.roomId);
    socket.emit('room:snapshot', result.snapshot);
    socket.emit('player:state', result.player);
    socket.emit('room:resume', { resumeToken: result.resumeToken, resumed: result.resumed });
    await reconnectDirectory.save(result.resumeToken, {
      playerId: result.player.id, roomId: result.snapshot.roomId, serverId: config.serverId,
      expiresAt: Date.now() + Math.max(config.reconnectGraceMs + 5_000, 20_000)
    });
    if (stablePlayerId) await identityDirectory?.presence(stablePlayerId, result.snapshot.roomId, socket.id,
      Math.max(config.reconnectGraceMs + 10_000, 30_000));
    // A join receives the zones around its spawn, plus the legacy whole-room
    // snapshot for clients that have not migrated to zone streaming yet.
    const spawn = result.snapshot.players.find(({ id }) => id === result.snapshot.selfId);
    const spawnZones = spawn ? cabinets.activeZoneIds(spawn.p[0], spawn.p[2]) : cabinets.zones.all().map(({ id }) => id);
    socket.emit('cabinet:zone-snapshot', toZoneSnapshotPayload(cabinets.zoneSnapshot(result.snapshot.roomId, spawnZones)));
    socket.emit('cabinet:snapshot', { roomId: result.snapshot.roomId, cabinets: cabinets.snapshot(result.snapshot.roomId) });
    socket.emit('chat:snapshot', { roomId: result.snapshot.roomId, messages: chat.snapshot(result.snapshot.roomId) });
    socket.emit('world:snapshot', world.snapshot(result.snapshot.roomId));
    metrics.increment(result.resumed ? 'reconnect_success_total' : 'player_join_success_total');
  });

  socket.on('player:move', (input) => {
    metrics.increment('events_player_move_received_total');
    statuses.noteActivityForSocket(socket.id);
    const player = players.move(socket.id, input);
    // Always answer movement packets with server state: accepted state corrects prediction,
    // rejected state quietly restores a client that drifted or attempted an invalid move.
    const authoritativeState = player ?? players.stateFor(socket.id);
    if (!player) metrics.increment('movement_rejected_total');
    if (authoritativeState) socket.emit('player:state', authoritativeState);
  });

  socket.on('chat:send', (payload, acknowledge) => {
    metrics.increment('events_chat_send_received_total');
    const result = chat.send(socket.id, payload?.text);
    if (!result.ok) metrics.increment('chat_rejected_total');
    if (result.ok) statuses.noteActivityForSocket(socket.id);
    if (typeof acknowledge === 'function') acknowledge(result);
  });
  socket.on('reaction:send', (payload, acknowledge) => {
    metrics.increment('events_reaction_send_received_total');
    const result = reactions.send(socket.id, payload?.emoji);
    if (!result.ok) metrics.increment('reaction_rejected_total');
    if (result.ok) statuses.noteActivityForSocket(socket.id);
    if (typeof acknowledge === 'function') acknowledge(result);
  });
  socket.on('presence:activity', () => statuses.noteActivityForSocket(socket.id));
  socket.on('social:ping', (_payload, acknowledge) => {
    if (typeof acknowledge === 'function') acknowledge({ serverAt: Date.now() });
  });
  socket.on('cabinet:request-use', (payload, acknowledge) => {
    metrics.increment('events_cabinet_request_received_total');
    const result = cabinets.requestUse(socket.id, payload?.cabinetId);
    if (!result.ok) metrics.increment('cabinet_request_rejected_total');
    if (typeof acknowledge === 'function') acknowledge(result);
  });
  socket.on('cabinet:activate', (payload, acknowledge) => {
    metrics.increment('events_cabinet_activate_received_total');
    const result = cabinets.activate(socket.id, payload?.cabinetId);
    if (typeof acknowledge === 'function') acknowledge(result);
  });
  socket.on('cabinet:resync', (payload, acknowledge) => {
    metrics.increment('events_cabinet_resync_received_total');
    const playerId = players.playerIdForSocket(socket.id);
    const player = playerId ? players.stateForPlayerId(playerId) : undefined;
    const requested: unknown = payload?.zoneIds;
    if (!player || !Array.isArray(requested) || requested.length === 0 || requested.length > MAX_RESYNC_ZONES
      || !requested.every((zoneId) => typeof zoneId === 'string')) {
      return acknowledge({ ok: false, reason: 'invalid-request' });
    }
    // Only zones that exist are honoured, so a client cannot use resync to
    // enumerate or allocate arbitrary keys.
    const known = (requested as string[]).filter((zoneId) => cabinets.zones.get(zoneId) !== undefined);
    if (known.length === 0) return acknowledge({ ok: false, reason: 'unknown-zone' });
    metrics.increment('cabinet_resync_served_total');
    acknowledge({ ok: true, snapshot: toZoneSnapshotPayload(cabinets.zoneSnapshot(player.roomId, known)) });
  });

  socket.on('cabinet:release', (payload, acknowledge) => {
    metrics.increment('events_cabinet_release_received_total');
    const result = cabinets.release(socket.id, payload?.cabinetId);
    if (typeof acknowledge === 'function') acknowledge(result);
  });

  socket.on('disconnect', () => {
    metrics.increment('socket_disconnects_total');
    players.disconnect(socket.id);
    socketIdentities.delete(socket.id);
    const playerId = socketPlayerIds.get(socket.id);
    socketPlayerIds.delete(socket.id);
    if (playerId) void identityDirectory?.release(playerId, socket.id).catch(() => metrics.increment('identity_release_failure_total'));
  });
});

const cleanupTimer = setInterval(() => {
  players.sweep(); cabinets.sweep(); statuses.sweep(); roomLifecycle.closeIdle(config.roomIdleTimeoutMs);
  roomLifecycle.ensureAvailable(config.minAvailableRooms, config.maxRoomsPerServer);
}, 1_000);
cleanupTimer.unref();
const reconnectRouteTimer = setInterval(() => {
  const expiresAt = Date.now() + Math.max(config.reconnectGraceMs + 5_000, 20_000);
  for (const route of players.reconnectRoutes()) {
    if (!route.connected) continue;
    void reconnectDirectory.save(route.resumeToken, {
      playerId: route.playerId, roomId: route.roomId, serverId: config.serverId, expiresAt
    }).catch(() => metrics.increment('reconnect_route_refresh_failure_total'));
  }
}, 5_000);
reconnectRouteTimer.unref();
const identityHeartbeatTimer = identityDirectory ? setInterval(() => {
  for (const [socketId, playerId] of socketPlayerIds) {
    void identityDirectory.refresh(playerId, socketId).catch(() => metrics.increment('identity_heartbeat_failure_total'));
  }
}, 10_000) : undefined;
identityHeartbeatTimer?.unref();
const databaseHealthTimer = database ? setInterval(() => {
  void database.check().then((ready) => { databaseBootstrapped = ready; });
}, 15_000) : undefined;
databaseHealthTimer?.unref();
let worldEventIndex = 0;
const worldEventTypes = ['neon-surge', 'power-flicker', 'fireworks'] as const;
const worldEventTimer = setInterval(() => {
  for (const room of rooms.records) world.trigger(room.id, worldEventTypes[worldEventIndex % worldEventTypes.length]);
  worldEventIndex += 1;
}, Number(process.env.WORLD_EVENT_INTERVAL_MS ?? 90_000));
worldEventTimer.unref();

/**
 * Milestone 11.7/11.9. Plugins are given only the narrow services below — never
 * a database handle, a Redis client, or a socket. A plugin failure is contained
 * by the host and surfaced through health, so it cannot take the arcade down.
 */
const pluginBootstrap = await bootstrapPlugins(config, {
  safeProfile: (publicPlayerId) => {
    const player = players.stateForPlayerId(publicPlayerId);
    return player ? { publicPlayerId, displayName: player.n, avatarId: player.v } : undefined;
  },
  roomState: (roomId) => {
    const population = players.roomPopulation(roomId);
    if (population === undefined) return undefined;
    return {
      roomId,
      population,
      activeCabinetIds: cabinets.snapshot(roomId).filter(({ status }) => status !== 'available').map(({ cabinetId }) => cabinetId)
    };
  },
  emitRoomEvent: (pluginId, roomId, event) => {
    // Namespaced so a plugin event can never impersonate a core one.
    io.to(roomId).emit('world:announcement', {
      id: `plugin-${pluginId}-${Date.now()}`,
      roomId,
      text: String(event.payload.text ?? ''),
      kind: 'event',
      at: Date.now()
    });
    metrics.increment('plugin_room_events_total');
  }
}, (level, event, details) => logger[level === 'error' ? 'error' : level](event, details));

const plugins: PluginHost = pluginBootstrap.host;

/**
 * Milestones 11.25 through 11.29. Operations authenticate against a separate
 * credential store, so no player session — wallet or otherwise — can reach any
 * of this.
 */
const operationsRuntime = createOperationsRuntime({
  config,
  cabinets,
  games: gameRegistry,
  plugins,
  beginDraining: () => void drain.begin('operator-action'),
  isDraining: () => health.isDraining,
  closeEmptyRoom: (roomId) => rooms.close(roomId),
  roomPopulation: (roomId) => players.roomPopulation(roomId),
  refreshRegistry: () => {
    gameRegistry = loadGameRegistry(projectRoot).registry;
    return { cabinetDefinitions: cabinets.index.size, gameDefinitions: gameRegistry.size };
  },
  sources: {
    server: () => {
      const readiness = health.readiness();
      return {
        serverId: config.serverId,
        region: config.region,
        version: config.softwareVersion,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1_000),
        roomCount: rooms.activeRoomCount,
        playerCount: players.connectedCount,
        capacity: { maxPlayers: config.maxPlayersPerServer, maxRooms: config.maxRoomsPerServer },
        draining: health.isDraining,
        ready: readiness.ready,
        readinessReasons: readiness.reasons,
        eventLoopDelayMs: metrics.eventLoopDelayMs(),
        memoryRssBytes: process.memoryUsage().rss
      };
    },
    rooms: () => rooms.records.map((record) => ({
      roomId: record.id,
      population: players.roomPopulation(record.id) ?? 0,
      owningServerId: config.serverId,
      status: health.isDraining ? 'draining' as const : 'active' as const,
      activeCabinetCount: cabinets.activeStateCount(record.id),
      createdAt: record.createdAt
    })),
    cabinets: (roomId) => {
      const room = roomId ?? DEFAULT_ROOM_ID;
      return cabinets.index.definitions.map((definition) => {
        const state = cabinets.snapshot(room).find(({ cabinetId }) => cabinetId === definition.id);
        return {
          cabinetId: definition.id,
          zoneId: definition.zoneId,
          gameId: definition.gameId,
          state: state?.status ?? 'available',
          // Only the public player ID, and only while the cabinet is held: an
          // operator may need to free it. No other player data is exposed.
          occupantPublicId: state?.occupiedByPlayerId ?? null,
          enabled: definition.enabled && !operationsRuntime.disabledCabinets.has(definition.id),
          maintenance: operationsRuntime.disabledCabinets.has(definition.id),
          failureCount: 0,
          lastSuccessfulSessionAt: state?.sessionStartedAt ?? null
        };
      });
    },
    dependencies: () => [
      { name: 'redis', required: Boolean(config.redisUrl), ready: redis?.isReady ?? false, detail: null },
      { name: 'postgres', required: config.databaseRequired, ready: database?.isReady ?? false, detail: null },
      { name: 'object-storage', required: false, ready: false, detail: 'read-only asset CDN; no upload path in Phase 11' }
    ],
    plugins: () => plugins.health(),
    emulatorAdapters: () => [
      { adapterId: 'emulatorjs', platforms: ['psx', 'n64', 'snes'] },
      { adapterId: 'play-ps2', platforms: ['ps2'] },
      { adapterId: 'gecko-gamecube', platforms: ['gamecube'] }
    ],
    registry: () => ({
      cabinetDefinitions: cabinets.index.size,
      zones: cabinets.zones.size,
      gameDefinitions: gameRegistry.size
    }),
    featureFlags: () => Object.fromEntries(operationsRuntime.featureFlags),
    // Game sessions are client-side in Phase 11; the server counts cabinets in
    // use rather than reporting a number it cannot observe.
    activeGameSessions: () => rooms.records.reduce((total, record) => total + cabinets.activeStateCount(record.id), 0),
    queues: () => []
  },
  auditSink: (record) => logger.info('operations_audit', record as Record<string, unknown>)
});

installOperationsRoutes(app, config, {
  auth: operationsRuntime.auth,
  operations: operationsRuntime.operations,
  actions: operationsRuntime.actions,
  executor: operationsRuntime.executor,
  audit: operationsRuntime.audit,
  metrics
}, projectRoot);

const drain = new DrainController(httpServer, io, config, health, metrics, logger, {
  activePlayers: () => players.connectedCount,
  beginDraining: () => roomLifecycle.beginDraining(),
  stopTimers: async () => {
    clearInterval(cleanupTimer);
    clearInterval(reconnectRouteTimer);
    if (identityHeartbeatTimer) clearInterval(identityHeartbeatTimer);
    if (databaseHealthTimer) clearInterval(databaseHealthTimer);
    clearInterval(worldEventTimer);
    await roomLifecycle.stop();
    // Plugins stop before shared infrastructure so their cleanup still has
    // whatever it needs, and a plugin that throws cannot block the drain.
    await plugins.stopAll('shutdown');
    await serverRegistry?.stop();
    await redis?.close();
    await database?.close();
  }
});

process.once('SIGTERM', () => drain.begin('SIGTERM'));
process.once('SIGINT', () => drain.begin('SIGINT'));
httpServer.on('error', (error) => {
  health.markCriticalFailure();
  logger.error('http_server_error', { errorName: error.name, errorMessage: error.message });
  process.exitCode = 1;
});

httpServer.listen(config.port, '0.0.0.0', () => {
  health.markInitialized();
  logger.info('server_started', {
    port: config.port,
    maxPlayersPerRoom: config.maxPlayersPerRoom,
    maxRoomsPerServer: config.maxRoomsPerServer,
    maxPlayersPerServer: config.maxPlayersPerServer
  });
});
