import { createServer } from 'node:http';
import path from 'node:path';
import express from 'express';
import { Server } from 'socket.io';
import { DEFAULT_ROOM_ID } from './protocol.js';
import type { ClientToServerEvents, ServerToClientEvents } from './protocol.js';
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

const projectRoot = path.resolve(process.cwd());
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
const redis = config.redisUrl ? new RedisConnection(config.redisUrl, logger, metrics) : undefined;
if (redis) {
  try {
    await redis.connect();
    io.adapter(createRedisStreamsAdapter(redis.client, {
      streamName: new RedisKeys(config.redisKeyPrefix).socketStream(),
      sessionKeyPrefix: new RedisKeys(config.redisKeyPrefix).socketSessions(),
      maxLen: 10_000,
      onlyPlaintext: true
    }));
    logger.info('socket_redis_streams_adapter_ready');
  } catch (error) {
    metrics.increment('redis_startup_failure_total');
    logger.error('redis_startup_failed', { errorMessage: error instanceof Error ? error.message : 'unknown' });
  }
}
health = new HealthService(config, metrics, {
  connectedSockets: () => io.engine.clientsCount,
  activePlayers: () => players.connectedCount,
  activeRooms: () => rooms.roomCount,
  coordinationRequired: () => config.redisRequired,
  coordinationReady: () => redis?.isReady ?? false
});
const redisKeys = new RedisKeys(config.redisKeyPrefix);
const roomDirectory = redis?.isReady ? new RedisRoomDirectory(redis.client, redisKeys, config.roomDirectoryTtlMs) : new InMemoryRoomDirectory();
const roomOwnership = redis?.isReady ? new RoomOwnershipService(redis.client, redisKeys, config.serverId, config.roomOwnershipTtlMs) : undefined;
const roomLifecycle = new RoomLifecycleService(rooms, roomDirectory, metrics, logger, roomOwnership, Math.max(1_000, Math.floor(config.roomOwnershipTtlMs / 3)));
await roomLifecycle.start();
const serverRegistry = redis?.isReady ? new ServerRegistry(redis.client, redisKeys, config, {
  roomCount: () => rooms.roomCount,
  playerCount: () => players.connectedCount,
  draining: () => health.isDraining,
  healthy: () => redis.isReady
}, metrics, logger) : undefined;
await serverRegistry?.start();
const roomAdmission = redis?.isReady
  ? new RedisRoomAdmission(redis.client, redisKeys, config.admissionReservationTtlMs)
  : new InMemoryRoomAdmission(config.admissionReservationTtlMs);
const roomPlacement = new RoomPlacementService(rooms, roomDirectory, roomLifecycle, roomAdmission, serverRegistry, config, metrics);
const reconnectDirectory = redis?.isReady ? new RedisReconnectDirectory(redis.client, redisKeys) : new InMemoryReconnectDirectory();

installOperationalRoutes(app, config, health, metrics, startedAt);
app.use(express.json({ limit: '16kb' }));
installMatchmakingRoutes(app, roomPlacement, roomDirectory, reconnectDirectory, config);
installStaticHosting(app, projectRoot, publicRuntimeConfig());

io.use((_socket, next) => {
  const readiness = health.readiness();
  const connectionLimit = config.maxPlayersPerServer + config.maxPendingConnections;
  if (!readiness.ready || io.engine.clientsCount > connectionLimit) {
    metrics.increment('socket_connections_rejected_total');
    next(new Error('server-unavailable'));
    return;
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
    io.to(event.roomId).emit('cabinet:state-changed', event.state);
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
    const identity = validateIdentity(request?.identity);
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
    const result = players.join(socket.id, roomId, resumeToken, identity);
    if (!result.resumed && reservationToken) {
      const confirmed = await roomAdmission.confirm(result.snapshot.roomId, reservationToken, result.player.id);
      if (!confirmed) {
        players.removeSocketNow(socket.id);
        metrics.increment('join_rejected_expired_reservation_total');
        socket.emit('room:error', { code: 'reservation-expired', message: 'Your arcade spot expired before entry. Please retry.' });
        return;
      }
    } else if (result.resumed && reservationToken) {
      await roomAdmission.release(result.snapshot.roomId, undefined, reservationToken);
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
  socket.on('cabinet:release', (payload, acknowledge) => {
    metrics.increment('events_cabinet_release_received_total');
    const result = cabinets.release(socket.id, payload?.cabinetId);
    if (typeof acknowledge === 'function') acknowledge(result);
  });

  socket.on('disconnect', () => {
    metrics.increment('socket_disconnects_total');
    players.disconnect(socket.id);
  });
});

const cleanupTimer = setInterval(() => {
  players.sweep(); cabinets.sweep(); statuses.sweep(); roomLifecycle.closeIdle(config.roomIdleTimeoutMs);
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
let worldEventIndex = 0;
const worldEventTypes = ['neon-surge', 'power-flicker', 'fireworks'] as const;
const worldEventTimer = setInterval(() => {
  world.trigger(DEFAULT_ROOM_ID, worldEventTypes[worldEventIndex % worldEventTypes.length]);
  worldEventIndex += 1;
}, Number(process.env.WORLD_EVENT_INTERVAL_MS ?? 90_000));
worldEventTimer.unref();

const drain = new DrainController(httpServer, io, config, health, metrics, logger, {
  activePlayers: () => players.connectedCount,
  beginDraining: () => roomLifecycle.beginDraining(),
  stopTimers: async () => {
    clearInterval(cleanupTimer);
    clearInterval(reconnectRouteTimer);
    clearInterval(worldEventTimer);
    await roomLifecycle.stop();
    await serverRegistry?.stop();
    await redis?.close();
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
