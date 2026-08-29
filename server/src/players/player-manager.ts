import { randomUUID } from 'node:crypto';
import type { AnimationState, PlayerMoveInput, PlayerState, PlayerStatus, Position, RoomSnapshot } from '../protocol.js';
import type { Room } from '../rooms/room.js';
import type { RoomManager } from '../rooms/room-manager.js';
import type { PlayerIdentity } from './player-identity.js';

const MIN_WORLD_X = -42.7;
const MAX_WORLD_X = 42.7;
const MIN_WORLD_Z = -66.7;
// Stops at the hub's north wall: the GameCube room is sealed behind its
// construction barrier again, so nothing beyond z 16 is meant to be walked to.
// This bound is duplicated in the Cloudflare Worker and in arcade.js, and
// test/world-bounds.test.ts holds the three to the same numbers: a player who
// can walk somewhere the server will not accept gets snapped back on every
// step, which reads as lag rather than as a wall.
const MAX_WORLD_Z = 33.1;
// The world is not one rectangle. The Mega Man room reaches 4.6 m further west
// than the rest of the building, so ten cabinets stand in a single row against
// the wall carrying the PlayStation logo. That strip is out of bounds
// everywhere else, which is why it is a second region rather than a wider
// MIN_WORLD_X: widening the box would open the west wall of the PlayStation
// gallery and the PS2 room behind it.
// The world used to be two rectangles, because the Mega Man room reached
// further west than the rest of the building. Every side room is that width
// now, so the outer wall is a straight run and one rectangle states it.

function isInsideWorld(x: number, z: number): boolean {
  if (x >= MIN_WORLD_X && x <= MAX_WORLD_X && z >= MIN_WORLD_Z && z <= MAX_WORLD_Z) return true;
  // Silent Hill doubled sideways: its annex is bolted onto the OUTSIDE of
  // the building's west wall, over ground nothing else uses. Matches
  // SILENT_HILL_EXPANSE in arcade.js.
  if (x >= -64.3 && x <= MIN_WORLD_X && z >= -66.7 && z <= -42.5) return true;
  // The arena's own region, north of the building. Matches POKEMON_EXPANSE
  // in arcade.js.
  return x >= -12 && x <= 66 && z >= -138.6 && z <= -42.5;
}
const PLAYER_HEIGHT = 1.65;
const MAX_SPEED_PER_SECOND = 10.5;
const MAX_PACKET_RATE_MS = 50;
const DEFAULT_RECONNECT_GRACE_MS = 10_000;
const MOVEMENT_TOLERANCE = 0.3;
const PARTITION_WALL_X = 21.6;
const PARTITION_COLLISION_HALF_WIDTH = 0.52;
// Four rooms open off each partition wall, and every one of them is walkable.
// The only room still shut is the Multiplayer / Tournament hall, which is
// behind the hall's own front wall. arcade.js holds the same table.
// The east column re-planned around the grown garden: full rooms follow it
// south and the unbuilt bottom room absorbs the squeeze, so the two partition
// walls no longer mirror each other. Matches arcade.js.
const OPEN_DOOR_Z_WEST = [-25.2, -8, 8, 25.2];
const OPEN_DOOR_Z_EAST = [-25.2, -3.6, 13.2, 27.6];
const EAST_WALL_Z: Record<string, number> = { '-16.8': -12, '0': 4.8, '16.8': 21.6 };
// The top row's front wall, with a doorway into each of its four rooms, and the
// walls between them. The row was shut by the world bound until its barriers
// came down, so none of this needed enforcing before.
const TOP_ROW_WALL_Z = -50.4;
const NORTH_ROOM_X = [-10.8];
// The west end of the top row, plus the same bite of the band, is Silent
// Hill: fog behind a south wall with one doorway at its centre. Matches
// arcade.js.
const SILENT_EAST_X = -21.6;
const SILENT_SOUTH_Z = -42;
const SILENT_DOOR_X = -32.4;
// The east half of the top row, plus a bite of the band, is the Pokemon
// stadium at 1.5x. Its west wall has no doorway; its south wall has one.
const POKEMON_WEST_X = 10.8;
const POKEMON_SOUTH_Z = -42;
const POKEMON_DOOR_X = 27;
const NORTH_ROW_DIVIDER_X = [-21.6];
// The Pokemon bowl: the stands are solid, and the only way through them is the
// entrance lane on the doorway side. Matches POKEBOWL in arcade.js.
// The arena hangs in the void north of the building now, tripled. Matches
// POKEBOWL and POKEMON_EXPANSE in arcade.js.
const POKEBOWL = { cx: 27, cz: -108.45, ax: 38.7, az: 29.7, laneHalfWidth: 1.5 };
// The Chao Garden's cliffs: the same rule at the garden's scale, passable only
// where the cliffs part at the doorway. Matches CHAO_GARDEN in arcade.js.
// The garden moved to the east column's middle room and is an ellipse now,
// shallower along z to fit a standard-depth room. Matches arcade.js.
const CHAO_GARDEN = { cx: 32.9, cz: 13.2, ax: 9.2, az: 5.9, laneHalfWidth: 1.5, doorZ: 13.2 };
function insideChaoGarden(x: number, z: number): boolean {
  const dx = (x - CHAO_GARDEN.cx) / CHAO_GARDEN.ax;
  const dz = (z - CHAO_GARDEN.cz) / CHAO_GARDEN.az;
  return dx * dx + dz * dz <= 1;
}
function inChaoGardenLane(x: number, z: number): boolean {
  return Math.abs(z - CHAO_GARDEN.doorZ) < CHAO_GARDEN.laneHalfWidth && x < CHAO_GARDEN.cx - CHAO_GARDEN.ax * 0.5;
}
function insidePokemonBowl(x: number, z: number): boolean {
  const dx = (x - POKEBOWL.cx) / POKEBOWL.ax;
  const dz = (z - POKEBOWL.cz) / POKEBOWL.az;
  return dx * dx + dz * dz <= 1;
}
function inPokemonTunnelLane(x: number, z: number): boolean {
  return Math.abs(x - POKEBOWL.cx) < POKEBOWL.laneHalfWidth && z > POKEBOWL.cz + POKEBOWL.az * 0.5;
}
const SIDE_COLUMN_MIN_Z = -33.6;
const SIDE_COLUMN_MAX_Z = 33.6;
const SIDE_ROOM_DIVIDER_Z = [-33.6, -16.8, 0, 16.8, 33.6];
const ROOM_DOOR_CLEARANCE = 1.26;
// The couch ring and the round display case that used to stand at the origin
// are gone, so the middle of the hall is open floor and nothing here refuses a
// step into it. What remains in this function is the partition walls.
// The westernmost wall any annex reaches, which is now the Mega Man room's.
// Scopes the checks below to the side rooms; a player west of it is outside the
// building entirely and has already been refused by the world bounds.
const ANNEX_MIN_X = MIN_WORLD_X;

function violatesSocialLayout(fromX: number, fromZ: number, toX: number, toZ: number): boolean {
  for (const wallX of [-PARTITION_WALL_X, PARTITION_WALL_X]) {
    // The wall runs the length of its column and no further: north of it the
    // hall is full width, which is what lets the top row's outer rooms open
    // onto the hall.
    if (Math.max(fromZ, toZ) < SIDE_COLUMN_MIN_Z || Math.min(fromZ, toZ) > SIDE_COLUMN_MAX_Z) continue;
    const doors = wallX < 0 ? OPEN_DOOR_Z_WEST : OPEN_DOOR_Z_EAST;
    // The Pokemon Center's storefront: the east wall is open from the old
    // plaza door to the column's end. Matches arcade.js.
    const throughDoor = (z: number) => doors.some((doorZ) => Math.abs(z - doorZ) < ROOM_DOOR_CLEARANCE)
      || (wallX > 0 && z > -33.7 && z < -23.6);
    if (!throughDoor(toZ) && Math.abs(toX - wallX) < PARTITION_COLLISION_HALF_WIDTH) return true;
    if ((fromX - wallX) * (toX - wallX) > 0 || fromX === toX) continue;
    const crossing = (wallX - fromX) / (toX - fromX);
    const crossingZ = fromZ + (toZ - fromZ) * crossing;
    if (crossing >= 0 && crossing <= 1 && !throughDoor(crossingZ)) return true;
  }
  // The walls between the rooms in a column. None of them has a doorway: every
  // room is entered from the hall.
  const inSideColumn = Math.max(Math.abs(fromX), Math.abs(toX)) > PARTITION_WALL_X + PARTITION_COLLISION_HALF_WIDTH
    && Math.min(fromX, toX) >= ANNEX_MIN_X;
  if (inSideColumn) {
    for (const dividerZ of SIDE_ROOM_DIVIDER_Z) {
      // The east column's end wall is open: the Pokemon Center runs from the
      // stadium's wall across the old band pocket into its plaza.
      if (dividerZ === -33.6 && Math.min(fromX, toX) > 0) continue;
      // The east column's dividers all stand at their re-planned lines.
      const wallZ = (Math.min(fromX, toX) > 0 && EAST_WALL_Z[String(dividerZ)] !== undefined) ? EAST_WALL_Z[String(dividerZ)] : dividerZ;
      if (Math.abs(toZ - wallZ) < PARTITION_COLLISION_HALF_WIDTH) return true;
      if ((fromZ - wallZ) * (toZ - wallZ) < 0) return true;
    }
  }
  // The Pokemon bowl's stands. A step that crosses the ellipse is refused
  // unless it goes through the entrance lane; the far side of that lane is the
  // jumbotron, and there is no way through a jumbotron.
  if (insidePokemonBowl(fromX, fromZ) !== insidePokemonBowl(toX, toZ)
    && !(inPokemonTunnelLane(fromX, fromZ) || inPokemonTunnelLane(toX, toZ))) return true;
  // The Chao Garden's cliffs.
  if (insideChaoGarden(fromX, fromZ) !== insideChaoGarden(toX, toZ)
    && !(inChaoGardenLane(fromX, fromZ) || inChaoGardenLane(toX, toZ))) return true;
  // The top row's front wall, which ends where the Pokemon stadium begins.
  const throughTopRowDoor = (x: number) => NORTH_ROOM_X.some((doorX) => Math.abs(x - doorX) < ROOM_DOOR_CLEARANCE);
  if (toX > SILENT_EAST_X && toX < POKEMON_WEST_X && !throughTopRowDoor(toX) && Math.abs(toZ - TOP_ROW_WALL_Z) < PARTITION_COLLISION_HALF_WIDTH) return true;
  if ((fromZ - TOP_ROW_WALL_Z) * (toZ - TOP_ROW_WALL_Z) < 0) {
    const crossing = (TOP_ROW_WALL_Z - fromZ) / (toZ - fromZ);
    const crossingX = fromX + (toX - fromX) * crossing;
    if (crossing >= 0 && crossing <= 1 && crossingX > SILENT_EAST_X && crossingX < POKEMON_WEST_X && !throughTopRowDoor(crossingX)) return true;
  }
  // Silent Hill's south wall, with the entrance doorway at its centre.
  const throughSilentDoor = (x: number) => Math.abs(x - SILENT_DOOR_X) < 1.38;
  if (toX < SILENT_EAST_X && !throughSilentDoor(toX) && Math.abs(toZ - SILENT_SOUTH_Z) < PARTITION_COLLISION_HALF_WIDTH) return true;
  if ((fromZ - SILENT_SOUTH_Z) * (toZ - SILENT_SOUTH_Z) < 0) {
    const crossing = (SILENT_SOUTH_Z - fromZ) / (toZ - fromZ);
    const crossingX = fromX + (toX - fromX) * crossing;
    if (crossing >= 0 && crossing <= 1 && crossingX < SILENT_EAST_X && !throughSilentDoor(crossingX)) return true;
  }
  // The stadium's south wall, with the entrance doorway at its centre.
  const throughStadiumDoor = (x: number) => Math.abs(x - POKEMON_DOOR_X) < ROOM_DOOR_CLEARANCE;
  if (toX > POKEMON_WEST_X && !throughStadiumDoor(toX) && Math.abs(toZ - POKEMON_SOUTH_Z) < PARTITION_COLLISION_HALF_WIDTH) return true;
  if ((fromZ - POKEMON_SOUTH_Z) * (toZ - POKEMON_SOUTH_Z) < 0) {
    const crossing = (POKEMON_SOUTH_Z - fromZ) / (toZ - fromZ);
    const crossingX = fromX + (toX - fromX) * crossing;
    if (crossing >= 0 && crossing <= 1 && crossingX > POKEMON_WEST_X && !throughStadiumDoor(crossingX)) return true;
  }
  // The vomitory's two walls, from the mouth down to the field's edge.
  for (const wallX of [POKEMON_DOOR_X - 1.7, POKEMON_DOOR_X + 1.7]) {
    if (toZ > -87.8 && toZ < POKEMON_SOUTH_Z + 0.5 && Math.abs(toX - wallX) < 0.3) return true;
    if ((fromX - wallX) * (toX - wallX) < 0) {
      const crossing = (wallX - fromX) / (toX - fromX);
      const crossingZ = fromZ + (toZ - fromZ) * crossing;
      if (crossing >= 0 && crossing <= 1 && crossingZ > -87.8 && crossingZ < POKEMON_SOUTH_Z + 0.5) return true;
    }
  }
  // The old stadium room's west wall went with the arena: the concourse
  // room is open to the band, and the tube's own walls shepherd inside it.
  // The wall between Silent Hill and the middle room, running from the back
  // wall down to Silent Hill's own south wall.
  if (Math.max(fromZ, toZ) < SILENT_SOUTH_Z && Math.min(fromX, toX) < POKEMON_WEST_X) {
    for (const dividerX of NORTH_ROW_DIVIDER_X) {
      if (Math.abs(toX - dividerX) < PARTITION_COLLISION_HALF_WIDTH) return true;
      if ((fromX - dividerX) * (toX - dividerX) < 0) return true;
    }
  }
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
    if (!isInsideWorld(x, z)) return false;
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
