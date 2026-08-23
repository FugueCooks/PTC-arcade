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

const projectRoot = path.resolve(process.cwd());
const port = Number(process.env.PORT ?? 8080);
const app = express();
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
const httpServer = createServer(app);
httpServer.keepAliveTimeout = 65_000;
httpServer.headersTimeout = 66_000;
const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  maxHttpBufferSize: 1_000_000,
  perMessageDeflate: false,
  transports: ['websocket', 'polling']
});
const rooms = new RoomManager();
const players = new PlayerManager(rooms);
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

installStaticHosting(app, projectRoot, publicRuntimeConfig());

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
      io.to(event.roomId).emit('player:disconnected', { id: event.playerId });
      break;
    case 'PlayerReconnected':
      io.to(event.roomId).except(event.socketId).emit('player:reconnected', event.player);
      break;
    case 'PlayerLeft':
      presence.remove(event.playerId);
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
  if (event.type === 'WorldStateChanged') io.to(event.state.roomId).emit('world:state-changed', event.state);
  if (event.type === 'WorldAnnouncement') {
    io.to(event.announcement.roomId).emit('world:announcement', event.announcement);
    chat.announce(event.announcement.roomId, event.announcement.text, event.announcement.at);
  }
  if (event.type === 'WorldEventTriggered') io.to(event.event.roomId).emit('world:event', event.event);
});

cabinets.subscribe((event) => {
  if (event.type === 'CabinetStateChanged') io.to(event.roomId).emit('cabinet:state-changed', event.state);
  if (event.type === 'CabinetForcedRelease') {
    const socketId = players.socketIdForPlayerId(event.playerId);
    if (socketId) io.to(socketId).emit('cabinet:forced-release', { cabinetId: event.cabinetId, reason: event.reason });
  }
});

io.on('connection', (socket) => {
  let joined = false;

  socket.on('room:join', (request) => {
    if (joined) return;
    const roomId = typeof request?.roomId === 'string' ? request.roomId : DEFAULT_ROOM_ID;
    const resumeToken = typeof request?.resumeToken === 'string' ? request.resumeToken : undefined;
    const identity = validateIdentity(request?.identity);
    if (!identity) {
      socket.emit('room:error', { message: 'Choose a valid display name before entering the arcade.' });
      return;
    }
    const requestedRoom = rooms.get(roomId) ?? rooms.getDefault();
    if (requestedRoom.isFull) {
      socket.emit('room:error', { code: 'room-full', message: 'This arcade room is full. Choose another instance.' });
      return;
    }
    joined = true;
    const result = players.join(socket.id, roomId, resumeToken, identity);
    void socket.join(result.snapshot.roomId);
    socket.emit('room:snapshot', result.snapshot);
    socket.emit('player:state', result.player);
    socket.emit('room:resume', { resumeToken: result.resumeToken, resumed: result.resumed });
    socket.emit('cabinet:snapshot', { roomId: result.snapshot.roomId, cabinets: cabinets.snapshot(result.snapshot.roomId) });
    socket.emit('chat:snapshot', { roomId: result.snapshot.roomId, messages: chat.snapshot(result.snapshot.roomId) });
    socket.emit('world:snapshot', world.snapshot(result.snapshot.roomId));
  });

  socket.on('player:move', (input) => {
    statuses.noteActivityForSocket(socket.id);
    const player = players.move(socket.id, input);
    // Always answer movement packets with server state: accepted state corrects prediction,
    // rejected state quietly restores a client that drifted or attempted an invalid move.
    const authoritativeState = player ?? players.stateFor(socket.id);
    if (authoritativeState) socket.emit('player:state', authoritativeState);
  });

  socket.on('chat:send', (payload, acknowledge) => {
    const result = chat.send(socket.id, payload?.text);
    if (result.ok) statuses.noteActivityForSocket(socket.id);
    if (typeof acknowledge === 'function') acknowledge(result);
  });
  socket.on('reaction:send', (payload, acknowledge) => {
    const result = reactions.send(socket.id, payload?.emoji);
    if (result.ok) statuses.noteActivityForSocket(socket.id);
    if (typeof acknowledge === 'function') acknowledge(result);
  });
  socket.on('presence:activity', () => statuses.noteActivityForSocket(socket.id));
  socket.on('social:ping', (_payload, acknowledge) => {
    if (typeof acknowledge === 'function') acknowledge({ serverAt: Date.now() });
  });
  socket.on('world:jukebox-set', (payload, acknowledge) => {
    const result = world.setJukebox(socket.id, payload?.trackId, payload?.playing);
    if (result.ok) statuses.noteActivityForSocket(socket.id);
    if (typeof acknowledge === 'function') acknowledge(result);
  });

  socket.on('cabinet:request-use', (payload, acknowledge) => {
    const result = cabinets.requestUse(socket.id, payload?.cabinetId);
    if (typeof acknowledge === 'function') acknowledge(result);
  });
  socket.on('cabinet:activate', (payload, acknowledge) => {
    const result = cabinets.activate(socket.id, payload?.cabinetId);
    if (typeof acknowledge === 'function') acknowledge(result);
  });
  socket.on('cabinet:release', (payload, acknowledge) => {
    const result = cabinets.release(socket.id, payload?.cabinetId);
    if (typeof acknowledge === 'function') acknowledge(result);
  });

  socket.on('disconnect', () => players.disconnect(socket.id));
});

const cleanupTimer = setInterval(() => { players.sweep(); cabinets.sweep(); statuses.sweep(); }, 1_000);
cleanupTimer.unref();
let worldEventIndex = 0;
const worldEventTypes = ['neon-surge', 'power-flicker', 'fireworks'] as const;
const worldEventTimer = setInterval(() => {
  world.trigger(DEFAULT_ROOM_ID, worldEventTypes[worldEventIndex % worldEventTypes.length]);
  worldEventIndex += 1;
}, Number(process.env.WORLD_EVENT_INTERVAL_MS ?? 90_000));
worldEventTimer.unref();

httpServer.listen(port, '0.0.0.0', () => {
  console.log(`ROMS multiplayer server running at http://localhost:${port}/`);
});
