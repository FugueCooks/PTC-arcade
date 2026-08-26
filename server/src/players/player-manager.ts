import { randomUUID } from 'node:crypto';
import type { AnimationState, PlayerMoveInput, PlayerState, PlayerStatus, Position, RoomSnapshot } from '../protocol.js';
import type { Room } from '../rooms/room.js';
import type { RoomManager } from '../rooms/room-manager.js';
import type { PlayerIdentity } from './player-identity.js';

const MIN_WORLD_X = -30.5;
const MAX_WORLD_X = 30.5;
const MIN_WORLD_Z = -33.2;
const MAX_WORLD_Z = 16;
const PLAYER_HEIGHT = 1.65;
const MAX_SPEED_PER_SECOND = 7;
const MAX_PACKET_RATE_MS = 50;
const DEFAULT_RECONNECT_GRACE_MS = 10_000;
const MOVEMENT_TOLERANCE = 0.3;
const PARTITION_WALL_X = 14;
const PARTITION_COLLISION_HALF_WIDTH = 0.52;
const PLAYABLE_ROOM_DOOR_Z = -8;
const PS2_ROOM_DOOR_Z = -16.8;
const ROOM_DOOR_CLEARANCE = 1.26;
const SOCIAL_COUCH_OUTER_RADIUS = 6.75;
const SOCIAL_COUCH_INNER_RADIUS = 4.2;
const SOCIAL_COUCH_GAP_HALF_ANGLE = 0.34;
const SOCIAL_DISPLAY_RADIUS = 2.07;
const LEGACY_WORLD_MIN_X = -30.5;
const MEGAMAN_ROOM_DOOR_Z = 8;

function violatesSocialLayout(fromX: number, fromZ: number, toX: number, toZ: number): boolean {
  const socialDistance = Math.hypot(toX, toZ);
  if (socialDistance < SOCIAL_DISPLAY_RADIUS) return true;
  const inSideGap = Math.abs(Math.sin(Math.atan2(toZ, toX))) <= Math.sin(SOCIAL_COUCH_GAP_HALF_ANGLE);
  if (!inSideGap && socialDistance >= SOCIAL_COUCH_INNER_RADIUS && socialDistance < SOCIAL_COUCH_OUTER_RADIUS) return true;
  for (const wallX of [-PARTITION_WALL_X, PARTITION_WALL_X]) {
    const targetInDoor = Math.abs(toZ - PLAYABLE_ROOM_DOOR_Z) < ROOM_DOOR_CLEARANCE;
    const targetInMegaManDoor = wallX === -PARTITION_WALL_X
      && Math.abs(toZ - MEGAMAN_ROOM_DOOR_Z) < ROOM_DOOR_CLEARANCE;
    if (!targetInDoor && !targetInMegaManDoor && Math.abs(toX - wallX) < PARTITION_COLLISION_HALF_WIDTH) return true;
    if ((fromX - wallX) * (toX - wallX) > 0 || fromX === toX) continue;
    const crossing = (wallX - fromX) / (toX - fromX);
    const crossingZ = fromZ + (toZ - fromZ) * crossing;
    const crossingInPlayableDoor = Math.abs(crossingZ - PLAYABLE_ROOM_DOOR_Z) < ROOM_DOOR_CLEARANCE;
    const crossingInMegaManDoor = wallX === -PARTITION_WALL_X
      && Math.abs(crossingZ - MEGAMAN_ROOM_DOOR_Z) < ROOM_DOOR_CLEARANCE;
    if (crossing >= 0 && crossing <= 1 && !crossingInPlayableDoor && !crossingInMegaManDoor) return true;
  }
  const inSideAnnex = Math.max(Math.abs(fromX), Math.abs(toX)) > PARTITION_WALL_X + PARTITION_COLLISION_HALF_WIDTH
    && Math.min(fromX, toX) >= LEGACY_WORLD_MIN_X;
  if (inSideAnnex && Math.abs(toZ) < PARTITION_COLLISION_HALF_WIDTH) return true;
  if (inSideAnnex && fromZ * toZ <= 0 && fromZ !== toZ) return true;
  const inPlayStationRearGallery = Math.max(fromX, toX) <= -PARTITION_WALL_X - PARTITION_COLLISION_HALF_WIDTH
    && Math.min(fromX, toX) >= LEGACY_WORLD_MIN_X;
  if (inPlayStationRearGallery && Math.abs(toZ - PS2_ROOM_DOOR_Z) < PARTITION_COLLISION_HALF_WIDTH) return true;
  if (inPlayStationRearGallery && (fromZ - PS2_ROOM_DOOR_Z) * (toZ - PS2_ROOM_DOOR_Z) <= 0 && fromZ !== toZ) return true;
  return false;
}

interface ManagedPlayer {
  id: string;
  resumeToken: string;
  socketId?: string;
  roomId: string;
  displayName: string;
  avatarId: string;
  position: [number, number, number];
  rotationY: number;
  animation: AnimationState;
  status: PlayerStatus;
  lastAcceptedAt: number;
  disconnectedAt?: number;
  activeCabinetId: string | null;
  interactionState: 'none' | 'reserved' | 'interact';
  movementLocked: boolean;
  cabinetSessionStartedAt: number | null;
}

export type PlayerEvent =
  | { type: 'PlayerJoined'; roomId: string; player: PlayerState; socketId: string }
  | { type: 'PlayerMoved'; roomId: string; player: PlayerState; socketId: string }
  | { type: 'PlayerDisconnected'; roomId: string; playerId: string; player: PlayerState }
  | { type: 'PlayerReconnected'; roomId: string; player: PlayerState; socketId: string }
  | { type: 'PlayerLeft'; roomId: string; playerId: string; player: PlayerState }
  | { type: 'PlayerStatusChanged'; roomId: string; playerId: string; status: PlayerStatus; at: number };

export interface JoinResult {
  player: PlayerState;
  snapshot: RoomSnapshot;
  resumeToken: string;
  resumed: boolean;
  replacedSocketId?: string;
}

/**
 * The authoritative source for players: identity, rooms, spawn, movement and reconnect grace.
 * It exposes domain events; Socket.IO transport is deliberately kept out of this class.
 */
export class PlayerManager {
  private readonly players = new Map<string, ManagedPlayer>();
  private readonly tokens = new Map<string, string>();
  private readonly listeners = new Set<(event: PlayerEvent) => void>();

  constructor(private readonly rooms: RoomManager, private readonly reconnectGraceMs = DEFAULT_RECONNECT_GRACE_MS) {}

  get connectedCount(): number {
    return [...this.players.values()].filter((player) => typeof player.socketId === 'string').length;
  }

  get managedCount(): number {
    return this.players.size;
  }

  /** Connected players in one room, or undefined when the room has none. */
  roomPopulation(roomId: string): number | undefined {
    let population = 0;
    for (const player of this.players.values()) {
      if (player.roomId === roomId && typeof player.socketId === 'string') population += 1;
    }
    return population === 0 ? undefined : population;
  }

  canResume(resumeToken: string | undefined, roomId: string, now = Date.now()): boolean {
    if (!resumeToken) return false;
    const player = this.playerForToken(resumeToken);
    return Boolean(player && player.roomId === roomId && player.disconnectedAt !== undefined
      && now - player.disconnectedAt <= this.reconnectGraceMs);
  }

  subscribe(listener: (event: PlayerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  join(socketId: string, requestedRoomId: string, resumeToken: string | undefined, identity: PlayerIdentity, now = Date.now(), stablePlayerId?: string): JoinResult {
    let room = this.rooms.get(requestedRoomId) ?? this.rooms.getDefault();
    const existing = resumeToken ? this.playerForToken(resumeToken) : undefined;

    if (existing && existing.roomId === room.id && existing.disconnectedAt !== undefined
      && now - existing.disconnectedAt <= this.reconnectGraceMs) {
      existing.socketId = socketId;
      existing.disconnectedAt = undefined;
      existing.lastAcceptedAt = now;
      existing.status = 'idle';
      room.add(existing.id);
      const player = this.toPublic(existing);
      this.publish({ type: 'PlayerReconnected', roomId: room.id, player, socketId });
      return { player, snapshot: this.snapshot(room, existing.id), resumeToken: existing.resumeToken, resumed: true };
    }

    const stableExisting = stablePlayerId ? this.players.get(stablePlayerId) : undefined;
    if (stableExisting) {
      room = this.rooms.get(stableExisting.roomId) ?? room;
      const replacedSocketId = stableExisting.socketId;
      stableExisting.socketId = socketId;
      stableExisting.disconnectedAt = undefined;
      stableExisting.lastAcceptedAt = now;
      stableExisting.displayName = identity.displayName;
      stableExisting.avatarId = identity.avatarId;
      stableExisting.status = 'idle';
      room.add(stableExisting.id);
      const player = this.toPublic(stableExisting);
      this.publish({ type: 'PlayerReconnected', roomId: room.id, player, socketId });
      return { player, snapshot: this.snapshot(room, stableExisting.id), resumeToken: stableExisting.resumeToken,
        resumed: true, replacedSocketId: replacedSocketId === socketId ? undefined : replacedSocketId };
    }

    const token = randomUUID();
    const player = this.createPlayer(room, socketId, token, identity, now, stablePlayerId);
    this.players.set(player.id, player);
    this.tokens.set(token, player.id);
    room.add(player.id);
    const publicPlayer = this.toPublic(player);
    this.publish({ type: 'PlayerJoined', roomId: room.id, player: publicPlayer, socketId });
    return { player: publicPlayer, snapshot: this.snapshot(room, player.id), resumeToken: token, resumed: false };
  }

  move(socketId: string, input: PlayerMoveInput, now = Date.now()): PlayerState | undefined {
    const player = this.playerForSocket(socketId);
    if (!player || player.movementLocked || !this.isValidMove(player, input, now)) return undefined;

    const [x, z] = input.p;
    const movedDistance = Math.hypot(x - player.position[0], z - player.position[2]);
    player.position = [x, PLAYER_HEIGHT, z];
    player.rotationY = normalizeAngle(input.r);
    player.animation = movedDistance > 0.005 ? 'walk' : 'idle';
    player.status = movedDistance > 0.005 ? 'walking' : 'idle';
    player.lastAcceptedAt = now;
    const publicPlayer = this.toPublic(player);
    this.publish({ type: 'PlayerMoved', roomId: player.roomId, player: publicPlayer, socketId });
    return publicPlayer;
  }

  disconnect(socketId: string, now = Date.now()): void {
    const player = this.playerForSocket(socketId);
    if (!player) return;
    player.socketId = undefined;
    player.disconnectedAt = now;
    player.status = 'disconnected';
    this.publish({ type: 'PlayerDisconnected', roomId: player.roomId, playerId: player.id, player: this.toPublic(player) });
  }

  removeSocketNow(socketId: string): void {
    const player = this.playerForSocket(socketId);
    if (player) this.remove(player);
  }

  sweep(now = Date.now()): void {
    for (const player of this.players.values()) {
      if (player.disconnectedAt === undefined || now - player.disconnectedAt <= this.reconnectGraceMs) continue;
      this.remove(player);
    }
  }

  snapshotFor(socketId: string): RoomSnapshot | undefined {
    const player = this.playerForSocket(socketId);
    if (!player) return undefined;
    const room = this.rooms.get(player.roomId);
    return room ? this.snapshot(room, player.id) : undefined;
  }

  stateFor(socketId: string): PlayerState | undefined {
    const player = this.playerForSocket(socketId);
    return player ? this.toPublic(player) : undefined;
  }

  stateForPlayerId(playerId: string): PlayerState | undefined {
    const player = this.players.get(playerId);
    return player ? this.toPublic(player) : undefined;
  }

  playerIdForSocket(socketId: string): string | undefined {
    return this.playerForSocket(socketId)?.id;
  }

  socketIdForPlayerId(playerId: string): string | undefined {
    return this.players.get(playerId)?.socketId;
  }

  reconnectRouteForPlayerId(playerId: string): { resumeToken: string; roomId: string; connected: boolean } | undefined {
    const player = this.players.get(playerId);
    return player ? { resumeToken: player.resumeToken, roomId: player.roomId, connected: typeof player.socketId === 'string' } : undefined;
  }

  reconnectRoutes(): Array<{ playerId: string; resumeToken: string; roomId: string; connected: boolean }> {
    return [...this.players.values()].map((player) => ({
      playerId: player.id,
      resumeToken: player.resumeToken,
      roomId: player.roomId,
      connected: typeof player.socketId === 'string'
    }));
  }

  connectedPlayersInRoom(roomId: string): Array<{ socketId: string; player: PlayerState }> {
    return [...this.players.values()]
      .filter((player): player is ManagedPlayer & { socketId: string } => player.roomId === roomId && typeof player.socketId === 'string')
      .map((player) => ({ socketId: player.socketId, player: this.toPublic(player) }));
  }

  setPresenceStatus(playerId: string, status: PlayerStatus, now = Date.now()): PlayerState | undefined {
    const player = this.players.get(playerId);
    if (!player || player.status === status) return player ? this.toPublic(player) : undefined;
    player.status = status;
    this.publish({ type: 'PlayerStatusChanged', roomId: player.roomId, playerId, status, at: now });
    return this.toPublic(player);
  }

  updateIdentity(playerId: string, identity: PlayerIdentity): PlayerState | undefined {
    const player = this.players.get(playerId);
    if (!player) return undefined;
    player.displayName = identity.displayName;
    player.avatarId = identity.avatarId;
    const state = this.toPublic(player);
    if (player.socketId) this.publish({ type: 'PlayerMoved', roomId: player.roomId, player: state, socketId: player.socketId });
    return state;
  }

  setCabinetState(playerId: string, cabinetId: string | null, state: 'none' | 'reserved' | 'interact', alignment?: { position: Position; rotationY: number }, now = Date.now()): PlayerState | undefined {
    const player = this.players.get(playerId);
    if (!player) return undefined;
    player.activeCabinetId = cabinetId;
    player.interactionState = state;
    player.movementLocked = cabinetId !== null;
    player.cabinetSessionStartedAt = state === 'interact' ? (player.cabinetSessionStartedAt ?? now) : null;
    player.animation = state === 'interact' ? 'interact' : 'idle';
    player.status = state === 'interact' ? 'playing' : (state === 'reserved' ? 'loading' : 'idle');
    if (alignment) {
      player.position = [...alignment.position];
      player.rotationY = normalizeAngle(alignment.rotationY);
    }
    player.lastAcceptedAt = now;
    const publicPlayer = this.toPublic(player);
    if (player.socketId) this.publish({ type: 'PlayerMoved', roomId: player.roomId, player: publicPlayer, socketId: player.socketId });
    return publicPlayer;
  }

  private createPlayer(room: Room, socketId: string, token: string, identity: PlayerIdentity, now: number, stablePlayerId?: string): ManagedPlayer {
    const occupied = room.memberIds
      .map((id) => this.players.get(id))
      .filter((player): player is ManagedPlayer => Boolean(player && player.disconnectedAt === undefined))
      .map((player) => ({ x: player.position[0], z: player.position[2] }));
    const spawn = room.chooseSpawn(occupied);
    return {
      id: stablePlayerId ?? randomUUID(), resumeToken: token, socketId, roomId: room.id,
      displayName: identity.displayName, avatarId: identity.avatarId,
      position: [spawn.x, spawn.y, spawn.z], rotationY: spawn.rotationY,
      animation: 'idle', status: 'idle', lastAcceptedAt: now,
      activeCabinetId: null, interactionState: 'none', movementLocked: false, cabinetSessionStartedAt: null
    };
  }

  private isValidMove(player: ManagedPlayer, input: PlayerMoveInput, now: number): boolean {
    const [x, z] = input.p;
    if (![x, z, input.r].every(Number.isFinite)) return false;
    if (x < MIN_WORLD_X || x > MAX_WORLD_X || z < MIN_WORLD_Z || z > MAX_WORLD_Z) return false;
    if (violatesSocialLayout(player.position[0], player.position[2], x, z)) return false;
    const elapsed = now - player.lastAcceptedAt;
    if (elapsed < MAX_PACKET_RATE_MS) return false;
    const permittedDistance = MAX_SPEED_PER_SECOND * Math.min(elapsed, 500) / 1000 + MOVEMENT_TOLERANCE;
    return Math.hypot(x - player.position[0], z - player.position[2]) <= permittedDistance;
  }

  private snapshot(room: Room, selfId: string): RoomSnapshot {
    const players = room.memberIds
      .map((id) => this.players.get(id))
      .filter((player): player is ManagedPlayer => Boolean(player && player.disconnectedAt === undefined))
      .map((player) => this.toPublic(player));
    return { roomId: room.id, selfId, players };
  }

  private remove(player: ManagedPlayer): void {
    const publicPlayer = this.toPublic(player);
    this.players.delete(player.id);
    this.tokens.delete(player.resumeToken);
    this.rooms.get(player.roomId)?.remove(player.id);
    this.publish({ type: 'PlayerLeft', roomId: player.roomId, playerId: player.id, player: publicPlayer });
  }

  private playerForSocket(socketId: string): ManagedPlayer | undefined {
    return [...this.players.values()].find((player) => player.socketId === socketId);
  }

  private playerForToken(token: string): ManagedPlayer | undefined {
    const id = this.tokens.get(token);
    return id ? this.players.get(id) : undefined;
  }

  private toPublic(player: ManagedPlayer): PlayerState {
    return {
      id: player.id, n: player.displayName, v: player.avatarId, roomId: player.roomId,
      p: [...player.position] as Position, r: player.rotationY, a: player.animation, s: player.status,
      activeCabinetId: player.activeCabinetId, interactionState: player.interactionState,
      movementLocked: player.movementLocked, cabinetSessionStartedAt: player.cabinetSessionStartedAt
    };
  }

  private publish(event: PlayerEvent): void {
    this.listeners.forEach((listener) => listener(event));
  }
}

function normalizeAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}
