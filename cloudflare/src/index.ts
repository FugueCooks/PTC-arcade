import cabinetRegistry from '../../assets/cabinets/registry.json';
import avatarRegistry from '../../assets/avatars/registry.json';
import worldConfig from '../../assets/world/config.json';
import roomRegistry from '../../assets/rooms/registry.json';

interface Env {
  ARCADE_ROOMS: DurableObjectNamespace;
  ARCADE_ASSETS: R2Bucket;
  MULTIPLAYER_TICKET_SECRET?: string;
  ORIGIN_HEALTH_URL?: string;
}
type AnimationState = 'idle' | 'walk' | 'run' | 'interact';
type PlayerStatus = 'idle' | 'walking' | 'playing' | 'loading' | 'away' | 'disconnected';
type Position = [number, number, number];
type CabinetStatus = 'available' | 'reserved' | 'in-use';
interface PlayerState {
  id: string; n: string; v: string; roomId: string; p: Position; r: number; a: AnimationState; s: PlayerStatus;
  activeCabinetId: string | null; interactionState: 'none' | 'reserved' | 'interact'; movementLocked: boolean;
  cabinetSessionStartedAt: number | null;
}
interface TicketIdentity { playerId: string; displayName: string; avatarId: string; mode: 'guest' | 'wallet' }
interface SocketAttachment { socketId: string; player?: PlayerState; resumeToken?: string; authenticatedIdentity?: TicketIdentity; lastAcceptedAt: number; lastActivityAt: number }
interface ResumeRecord { player: PlayerState; resumeToken: string; disconnectedAt: number; expiresAt: number }
interface CabinetState { cabinetId: string; occupiedByPlayerId: string | null; occupiedByDisplayName: string | null; status: CabinetStatus; reservedAt: number | null; sessionStartedAt: number | null }
interface ChatMessage { id: string; roomId: string; kind: 'chat' | 'system' | 'announcement'; playerId: string | null; displayName: string | null; text: string; at: number }
interface WorldState { roomId: string; themeId: string; weatherId: string; activityLevel: 'quiet' | 'active' | 'busy'; population: number; jukebox: { trackId: string | null; playing: boolean; startedAt: number | null; changedBy: string | null }; revision: number }
interface WireMessage { e?: string; d?: unknown; q?: string }

const ROOM_ID = 'main';
const PROTOCOL_VERSION = 1;
const PLAYER_HEIGHT = 1.65;
const RECONNECT_GRACE_MS = 10_000;
const MAX_SPEED_PER_SECOND = 10.5;
const MOVEMENT_PACKET_MS = 50;
const MOVEMENT_TOLERANCE = 0.3;
const MIN_WORLD_X = -42.7;
const MAX_WORLD_X = 42.7;
const MIN_WORLD_Z = -66.7;
const MAX_WORLD_Z = 33.1;   // Must match server/src/players/player-manager.ts.
// The Mega Man room's western extension. A second region rather than a wider
// MIN_WORLD_X, for the reason spelled out in player-manager.ts.
// One rectangle: see player-manager.ts.
const PARTITION_WALL_X = 21.6;
const PARTITION_COLLISION_HALF_WIDTH = 0.52;
// Four rooms open off each partition wall, and every one of them is walkable.
// The only room still shut is the Multiplayer / Tournament hall, which is
// behind the hall's own front wall. arcade.js holds the same table.
const OPEN_DOOR_Z = [-25.2, -8, 8, 25.2];
// The top row's front wall, with a doorway into each of its four rooms, and the
// walls between them. The row was shut by the world bound until its barriers
// came down, so none of this needed enforcing before.
const TOP_ROW_WALL_Z = -50.4;
const NORTH_ROOM_X = [-32.4, -10.8];
// The east half of the top row, plus a bite of the band, is the Pokemon
// stadium at 1.5x. Its west wall has no doorway; its south wall has one.
const POKEMON_WEST_X = 10.8;
const POKEMON_SOUTH_Z = -42;
const POKEMON_DOOR_X = 27;
const NORTH_ROW_DIVIDER_X = [-21.6];
// The Pokemon bowl: the stands are solid, and the only way through them is the
// entrance lane on the doorway side. Matches POKEBOWL in arcade.js.
const POKEBOWL = { cx: 27, cz: -54.6, ax: 15.35, az: 11.75, laneHalfWidth: 1.5 };
// The Chao Garden's cliffs: the same rule at the garden's scale, passable only
// where the cliffs part at the doorway. Matches CHAO_GARDEN in arcade.js.
const CHAO_GARDEN = { cx: 32.4, cz: -22.8, ax: 10.2, az: 10.2, laneHalfWidth: 1.5, doorZ: -25.2 };
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
// The westernmost wall any annex reaches. Must match player-manager.ts.
const ANNEX_MIN_X = MIN_WORLD_X;
const CABINET_DISTANCE = 2.6;
const CABINET_TIMEOUT_MS = 5_000;
const AFK_TIMEOUT_MS = 120_000;
const approvedAvatars = new Set(avatarRegistry.avatars.filter((avatar) => avatar.enabled).map((avatar) => avatar.id));
const defaultAvatarId = 'neon-capsule';
const cabinets = new Map(cabinetRegistry.map((cabinet) => [cabinet.id, cabinet]));
const approvedRooms = new Map(roomRegistry.rooms.filter((room) => room.enabled).map((room) => [room.id, room]));
const spawnPoints = [
  [0, PLAYER_HEIGHT, 11, Math.PI], [-2.2, PLAYER_HEIGHT, 11, Math.PI], [2.2, PLAYER_HEIGHT, 11, Math.PI],
  [-1.1, PLAYER_HEIGHT, 8.8, 0], [1.1, PLAYER_HEIGHT, 8.8, 0]
] as const;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname === 'assets.ptcarcade.fun') return serveAsset(request, env, ctx);
    if (url.pathname === '/healthz') return json({ ok: true, service: 'retro-arcade-realtime', edge: request.cf?.colo ?? null });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ ok: false, message: 'WebSocket upgrade required.' }, 426);
    if (!isAllowedOrigin(request.headers.get('Origin'))) return json({ ok: false, message: 'Origin is not allowed.' }, 403);
    const roomId = normalizeRoomId(url.searchParams.get('room'));
    return env.ARCADE_ROOMS.getByName(roomId).fetch(request);
  },

  /**
   * Keep-warm for a free-plan origin, which spins down after about fifteen
   * minutes without traffic and then takes roughly a minute to answer the next
   * request. The Worker is already always-on, so the cheapest fix is one
   * request from here on a schedule.
   *
   * It aims at the origin's own hostname rather than the public domain: a
   * request to the proxied domain would come straight back through Cloudflare
   * and might never reach the origin at all, which would keep nothing warm.
   *
   * A failure is logged and swallowed — the origin being down is not a reason
   * for the realtime Worker to start throwing.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const target = env.ORIGIN_HEALTH_URL;
    if (!target) return;
    ctx.waitUntil((async () => {
      try {
        const response = await fetch(target, {
          method: 'GET',
          headers: { 'user-agent': 'retro-arcade-keepalive' },
          signal: AbortSignal.timeout(20_000)
        });
        console.log(`keepalive ${target} -> ${response.status}`);
      } catch (error) {
        console.log(`keepalive ${target} failed: ${error instanceof Error ? error.message : 'unknown'}`);
      }
    })());
  }
} satisfies ExportedHandler<Env>;

const MAX_EDGE_CHUNK_BYTES = 8 * 1024 * 1024;
const ASSET_KEY_PATTERN = /^arcade\/(games|bios)\/[A-Za-z0-9._-]+$/;

export function assetKeyFromUrl(url: URL): string | null {
  let key: string;
  try { key = decodeURIComponent(url.pathname.replace(/^\/+/, '')); } catch { return null; }
  return ASSET_KEY_PATTERN.test(key) ? key : null;
}

export function finiteByteRange(value: string | null): { start: number; end: number } | null {
  const match = /^bytes=(\d+)-(\d+)$/.exec(value ?? '');
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start || end - start + 1 > MAX_EDGE_CHUNK_BYTES) return null;
  return { start, end };
}

async function serveAsset(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: assetCorsHeaders() });
  if (request.method !== 'GET' && request.method !== 'HEAD') return assetError(405, 'Method not allowed.');
  const url = new URL(request.url);
  const key = assetKeyFromUrl(url);
  if (!key) return assetError(404, 'Asset not found.');

  if (request.method === 'HEAD') {
    const object = await env.ARCADE_ASSETS.head(key);
    if (!object) return assetError(404, 'Asset not found.');
    return new Response(null, { status: 200, headers: assetHeaders(object, object.size) });
  }

  const requestedRange = request.headers.get('Range');
  const finiteRange = finiteByteRange(requestedRange);
  if (finiteRange) {
    const cacheKey = new Request(`${url.origin}/.arcade-range-cache/${encodeURIComponent(key)}/${finiteRange.start}-${finiteRange.end}`);
    const cached = await caches.default.match(cacheKey);
    if (cached) return rangeResponse(cached, finiteRange.start, finiteRange.end, Number(cached.headers.get('x-arcade-object-size')), 'HIT');

    const object = await env.ARCADE_ASSETS.get(key, {
      range: { offset: finiteRange.start, length: finiteRange.end - finiteRange.start + 1 }
    });
    if (!object) return assetError(404, 'Asset not found.');
    if (finiteRange.start >= object.size) return assetError(416, 'Requested range is outside this asset.');
    const actualEnd = Math.min(finiteRange.end, object.size - 1);
    const cacheHeaders = assetHeaders(object, actualEnd - finiteRange.start + 1);
    cacheHeaders.set('x-arcade-object-size', String(object.size));
    const cacheable = new Response(object.body, { status: 200, headers: cacheHeaders });
    ctx.waitUntil(caches.default.put(cacheKey, cacheable.clone()));
    return rangeResponse(cacheable, finiteRange.start, actualEnd, object.size, 'MISS');
  }

  const object = await env.ARCADE_ASSETS.get(key, requestedRange ? { range: request.headers } : undefined);
  if (!object) return assetError(404, 'Asset not found.');
  const range = object.range;
  const rangeOffset = range && 'offset' in range && typeof range.offset === 'number' ? range.offset : null;
  const rangeLength = range && 'length' in range && typeof range.length === 'number' ? range.length : null;
  const headers = assetHeaders(object, rangeLength ?? object.size);
  if (rangeOffset !== null && rangeLength !== null) {
    headers.set('content-range', `bytes ${rangeOffset}-${rangeOffset + rangeLength - 1}/${object.size}`);
    return new Response(object.body, { status: 206, headers });
  }
  return new Response(object.body, { status: 200, headers });
}

function rangeResponse(cached: Response, start: number, requestedEnd: number, totalSize: number, cacheStatus: 'HIT' | 'MISS'): Response {
  if (!Number.isSafeInteger(totalSize) || totalSize <= start) return assetError(502, 'Cached asset metadata is invalid.');
  const end = Math.min(requestedEnd, totalSize - 1);
  const headers = new Headers(cached.headers);
  headers.delete('x-arcade-object-size');
  headers.set('content-range', `bytes ${start}-${end}/${totalSize}`);
  headers.set('content-length', String(end - start + 1));
  headers.set('x-arcade-edge-cache', cacheStatus);
  return new Response(cached.body, { status: 206, headers });
}

function assetHeaders(object: R2Object, contentLength: number): Headers {
  const headers = assetCorsHeaders();
  object.writeHttpMetadata(headers);
  headers.set('accept-ranges', 'bytes');
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  headers.set('content-disposition', 'inline');
  headers.set('content-length', String(contentLength));
  headers.set('etag', object.httpEtag);
  headers.set('last-modified', object.uploaded.toUTCString());
  return headers;
}

function assetCorsHeaders(): Headers {
  return new Headers({
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, HEAD, OPTIONS',
    'access-control-allow-headers': 'Range',
    'access-control-expose-headers': 'Accept-Ranges, Content-Length, Content-Range, ETag, X-Arcade-Edge-Cache',
    'x-content-type-options': 'nosniff'
  });
}

function assetError(status: number, message: string): Response {
  return new Response(message, { status, headers: assetCorsHeaders() });
}

export class ArcadeRoom implements DurableObject {
  private readonly ctx: DurableObjectState;
  private readonly ticketSecret?: string;
  private roomId = ROOM_ID;
  private cabinetStates = new Map<string, CabinetState>();
  private history: ChatMessage[] = [];
  private world: WorldState = initialWorld(ROOM_ID);
  private resumes = new Map<string, ResumeRecord>();
  private requestTimes = new Map<string, number>();
  private chatTimes = new Map<string, number[]>();
  private reactionTimes = new Map<string, number>();
  private movementBroadcastTimes = new Map<string, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.ticketSecret = env.MULTIPLAYER_TICKET_SECRET;
    ctx.blockConcurrencyWhile(async () => {
      this.roomId = (await ctx.storage.get<string>('roomId')) ?? ROOM_ID;
      this.cabinetStates = new Map((await ctx.storage.get<Array<[string, CabinetState]>>('cabinets')) ?? cabinetRegistry.map(({ id }) => [id, availableCabinet(id)]));
      for (const { id } of cabinetRegistry) {
        if (!this.cabinetStates.has(id)) this.cabinetStates.set(id, availableCabinet(id));
      }
      this.history = (await ctx.storage.get<ChatMessage[]>('chat')) ?? [];
      this.world = (await ctx.storage.get<WorldState>('world')) ?? initialWorld(this.roomId);
      this.resumes = new Map((await ctx.storage.get<Array<[string, ResumeRecord]>>('resumes')) ?? []);
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ ok: false }, 426);
    const url = new URL(request.url);
    this.roomId = normalizeRoomId(url.searchParams.get('room'));
    await this.ctx.storage.put('roomId', this.roomId);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ socketId: crypto.randomUUID(), lastAcceptedAt: Date.now(),
      lastActivityAt: Date.now() } satisfies SocketAttachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== 'string' || raw.length > 4096) return;
    let message: WireMessage;
    try { message = JSON.parse(raw) as WireMessage; } catch { return; }
    if (!message || typeof message.e !== 'string') return;
    const attachment = socket.deserializeAttachment() as SocketAttachment;
    const acknowledge = (data: unknown) => { if (message.q) this.send(socket, undefined, data, message.q); };
    switch (message.e) {
      case 'room:join': await this.join(socket, attachment, message.d); break;
      case 'player:move': this.move(socket, attachment, message.d); break;
      case 'presence:activity': this.noteActivity(socket, attachment); break;
      case 'social:ping': acknowledge({ serverAt: Date.now() }); break;
      case 'chat:send': acknowledge(await this.chat(socket, attachment, message.d)); break;
      case 'reaction:send': acknowledge(this.reaction(socket, attachment, message.d)); break;
      case 'cabinet:request-use': acknowledge(await this.requestCabinet(socket, attachment, message.d)); break;
      case 'cabinet:activate': acknowledge(await this.activateCabinet(socket, attachment, message.d)); break;
      case 'cabinet:release': acknowledge(await this.releaseCabinet(socket, attachment, message.d)); break;
    }
  }

  async webSocketClose(socket: WebSocket): Promise<void> { await this.disconnect(socket); }
  async webSocketError(socket: WebSocket): Promise<void> { await this.disconnect(socket); }

  async alarm(): Promise<void> {
    const now = Date.now();
    let changed = false;
    for (const [token, record] of this.resumes) {
      if (record.expiresAt > now) continue;
      this.resumes.delete(token);
      await this.forceReleaseFor(record.player.id, 'disconnect-expired');
      this.broadcast('player:left', { id: record.player.id });
      await this.system(`${record.player.n} left the arcade.`);
      changed = true;
    }
    for (const state of this.cabinetStates.values()) {
      if (state.status !== 'reserved' || state.reservedAt === null || now - state.reservedAt <= CABINET_TIMEOUT_MS) continue;
      const playerId = state.occupiedByPlayerId;
      if (playerId) await this.forceReleaseFor(playerId, 'activation-timeout');
    }
    for (const socket of this.joinedSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment;
      if (!attachment.player || attachment.player.s === 'away' || attachment.player.activeCabinetId || now - attachment.lastActivityAt < AFK_TIMEOUT_MS) continue;
      attachment.player.s = 'away'; attachment.player.a = 'idle'; socket.serializeAttachment(attachment);
      this.broadcast('player:status', { id: attachment.player.id, status: 'away', at: now });
    }
    if (changed) await this.saveResumes();
    await this.updatePopulation();
    await this.scheduleAlarm();
  }

  private async join(socket: WebSocket, attachment: SocketAttachment, payload: unknown): Promise<void> {
    if (attachment.player) return;
    const request = asObject(payload);
    if (request?.protocolVersion !== undefined && request.protocolVersion !== PROTOCOL_VERSION) {
      this.send(socket, 'room:error', { message: 'This arcade client is out of date. Refresh the page and try again.' });
      return;
    }
    const authenticatedIdentity = this.ticketSecret
      ? await verifyRealtimeTicket(typeof request?.ticket === 'string' ? request.ticket : null, this.ticketSecret)
      : undefined;
    if (this.ticketSecret && !authenticatedIdentity) {
      this.send(socket, 'room:error', { code: 'authentication-required', message: 'Your multiplayer admission expired. Sign in again.' });
      socket.close(4003, 'authentication required');
      return;
    }
    attachment.authenticatedIdentity = authenticatedIdentity;
    const duplicate = authenticatedIdentity ? this.socketForPlayer(authenticatedIdentity.playerId) : undefined;
    if (duplicate && duplicate !== socket) duplicate.close(4001, 'session replaced');
    const capacity = approvedRooms.get(this.roomId)?.capacity ?? 25;
    if (this.joinedSockets().length >= capacity) {
      this.send(socket, 'room:error', { code: 'room-full', message: 'This arcade room is full. Moving you to another instance…' });
      return;
    }
    const identity = authenticatedIdentity ?? validateIdentity(request?.identity);
    if (!identity) { this.send(socket, 'room:error', { message: 'Choose a valid display name before entering the arcade.' }); return; }
    const now = Date.now();
    const requestedToken = typeof request?.resumeToken === 'string' ? request.resumeToken : undefined;
    const resumedCandidate = requestedToken ? this.resumes.get(requestedToken) : undefined;
    const resumed = resumedCandidate && (!authenticatedIdentity || resumedCandidate.player.id === authenticatedIdentity.playerId)
      ? resumedCandidate : undefined;
    let player: PlayerState;
    let resumeToken: string;
    if (resumed && resumed.expiresAt > now) {
      player = { ...resumed.player, p: [...resumed.player.p], s: 'idle' };
      resumeToken = resumed.resumeToken;
      this.resumes.delete(resumeToken);
      await this.saveResumes();
      this.broadcast('player:reconnected', player, socket);
    } else {
      const spawn = chooseSpawn(this.connectedPlayers());
      player = {
        id: authenticatedIdentity?.playerId ?? crypto.randomUUID(), n: identity.displayName, v: identity.avatarId, roomId: this.roomId,
        p: [spawn[0], spawn[1], spawn[2]], r: spawn[3], a: 'idle', s: 'idle', activeCabinetId: null,
        interactionState: 'none', movementLocked: false, cabinetSessionStartedAt: null
      };
      resumeToken = crypto.randomUUID();
      this.broadcast('player:joined', player, socket);
      await this.system(`${player.n} joined the arcade.`);
    }
    Object.assign(attachment, { player, resumeToken, lastAcceptedAt: now, lastActivityAt: now });
    socket.serializeAttachment(attachment);
    const players = this.connectedPlayers();
    this.send(socket, 'room:snapshot', { roomId: this.roomId, selfId: player.id, players });
    this.send(socket, 'player:state', player);
    this.send(socket, 'room:resume', { resumeToken, resumed: Boolean(resumed) });
    this.send(socket, 'cabinet:snapshot', { roomId: this.roomId, cabinets: [...this.cabinetStates.values()] });
    this.send(socket, 'chat:snapshot', { roomId: this.roomId, messages: this.history });
    this.send(socket, 'world:snapshot', this.world);
    await this.updatePopulation();
    await this.scheduleAlarm();
  }

  private move(socket: WebSocket, attachment: SocketAttachment, payload: unknown): void {
    const player = attachment.player;
    const input = asObject(payload);
    const position = Array.isArray(input?.p) ? input.p : [];
    const x = position[0]; const z = position[1]; const rotation = input?.r;
    const now = Date.now();
    if (!player || player.movementLocked || ![x, z, rotation].every(Number.isFinite)) return this.correct(socket, player);
    if (!isInsideWorld(x as number, z as number)) return this.correct(socket, player);
    if (violatesSocialLayout(player.p[0], player.p[2], x as number, z as number)) return this.correct(socket, player);
    const elapsed = now - attachment.lastAcceptedAt;
    const distance = Math.hypot((x as number) - player.p[0], (z as number) - player.p[2]);
    const permitted = MAX_SPEED_PER_SECOND * Math.min(elapsed, 500) / 1000 + MOVEMENT_TOLERANCE;
    if (elapsed < MOVEMENT_PACKET_MS || distance > permitted) return this.correct(socket, player);
    const wasAway = player.s === 'away';
    player.p = [x as number, PLAYER_HEIGHT, z as number]; player.r = normalizeAngle(rotation as number);
    player.a = distance > 0.005 ? 'walk' : 'idle'; player.s = distance > 0.005 ? 'walking' : 'idle';
    attachment.lastAcceptedAt = now; attachment.lastActivityAt = now; socket.serializeAttachment(attachment);
    const farBroadcastDue = now - (this.movementBroadcastTimes.get(player.id) ?? -Infinity) >= 300;
    for (const peer of this.joinedSockets()) {
      if (peer === socket) continue;
      const other = (peer.deserializeAttachment() as SocketAttachment).player;
      if (other && (Math.hypot(other.p[0] - player.p[0], other.p[2] - player.p[2]) <= 12 || farBroadcastDue)) this.send(peer, 'player:moved', player);
    }
    if (farBroadcastDue) this.movementBroadcastTimes.set(player.id, now);
    this.send(socket, 'player:state', player);
    if (wasAway) void this.scheduleAlarm();
  }

  private correct(socket: WebSocket, player?: PlayerState): void { if (player) this.send(socket, 'player:state', player); }

  private noteActivity(socket: WebSocket, attachment: SocketAttachment): void {
    if (!attachment.player) return;
    attachment.lastActivityAt = Date.now();
    if (attachment.player.s === 'away') {
      attachment.player.s = attachment.player.activeCabinetId ? (attachment.player.interactionState === 'interact' ? 'playing' : 'loading') : 'idle';
      this.broadcast('player:status', { id: attachment.player.id, status: attachment.player.s, at: Date.now() });
      void this.scheduleAlarm();
    }
    socket.serializeAttachment(attachment);
  }

  private async chat(socket: WebSocket, attachment: SocketAttachment, payload: unknown): Promise<{ ok: boolean; reason?: string }> {
    const text = sanitizeText(asObject(payload)?.text);
    const player = attachment.player;
    if (!player || !text) return { ok: false, reason: 'invalid' };
    if (text.length > 180) return { ok: false, reason: 'too-long' };
    const now = Date.now(); const cutoff = now - 6000;
    const recent = (this.chatTimes.get(player.id) ?? []).filter((time) => time > cutoff);
    if ((recent.length && now - recent.at(-1)! < 550) || recent.length >= 4) return { ok: false, reason: 'rate-limited' };
    recent.push(now); this.chatTimes.set(player.id, recent); attachment.lastActivityAt = now; socket.serializeAttachment(attachment);
    await this.pushChat({ id: crypto.randomUUID(), roomId: this.roomId, kind: 'chat', playerId: player.id, displayName: player.n, text, at: now });
    return { ok: true };
  }

  private reaction(socket: WebSocket, attachment: SocketAttachment, payload: unknown): { ok: boolean; reason?: string } {
    const emoji = asObject(payload)?.emoji;
    const player = attachment.player; const now = Date.now();
    if (!player || typeof emoji !== 'string' || !['👍', '😂', '❤️', '🔥', '😮'].includes(emoji)) return { ok: false, reason: 'invalid' };
    if (now - (this.reactionTimes.get(player.id) ?? -Infinity) < 550) return { ok: false, reason: 'rate-limited' };
    this.reactionTimes.set(player.id, now); attachment.lastActivityAt = now; socket.serializeAttachment(attachment);
    const event = { playerId: player.id, emoji, at: now, durationMs: 1700 };
    for (const peer of this.joinedSockets()) {
      const candidate = (peer.deserializeAttachment() as SocketAttachment).player;
      if (candidate && Math.hypot(candidate.p[0] - player.p[0], candidate.p[2] - player.p[2]) <= 15) this.send(peer, 'reaction:shown', event);
    }
    return { ok: true };
  }

  private async requestCabinet(socket: WebSocket, attachment: SocketAttachment, payload: unknown): Promise<Record<string, unknown>> {
    const player = attachment.player; const cabinetId = asObject(payload)?.cabinetId; const now = Date.now();
    if (!player || typeof cabinetId !== 'string') return { ok: false, reason: 'invalid-request' };
    const definition = cabinets.get(cabinetId); if (!definition) return { ok: false, reason: 'unknown-cabinet' };
    if (!definition.enabled) return { ok: false, reason: 'disabled' };
    if (now - (this.requestTimes.get(player.id) ?? -Infinity) < 250) return { ok: false, reason: 'rate-limited' };
    this.requestTimes.set(player.id, now);
    const state = this.cabinetStates.get(cabinetId)!;
    if (state.occupiedByPlayerId === player.id) return approved(state, definition);
    if (player.activeCabinetId) return { ok: false, reason: 'already-using' };
    if (state.status !== 'available') return { ok: false, reason: 'occupied' };
    if (Math.hypot(player.p[0] - definition.interactionPosition.x, player.p[2] - definition.interactionPosition.z) > CABINET_DISTANCE) return { ok: false, reason: 'too-far' };
    Object.assign(state, { status: 'reserved', occupiedByPlayerId: player.id, occupiedByDisplayName: player.n, reservedAt: now, sessionStartedAt: null });
    alignPlayer(player, definition, 'reserved', now); socket.serializeAttachment(attachment);
    await this.saveCabinets(); this.broadcast('cabinet:state-changed', state); this.broadcast('player:moved', player);
    await this.scheduleAlarm(); return approved(state, definition);
  }

  private async activateCabinet(socket: WebSocket, attachment: SocketAttachment, payload: unknown): Promise<Record<string, unknown>> {
    const player = attachment.player; const cabinetId = asObject(payload)?.cabinetId;
    if (!player || typeof cabinetId !== 'string') return { ok: false, reason: 'invalid-request' };
    const definition = cabinets.get(cabinetId); const state = this.cabinetStates.get(cabinetId);
    if (!definition || !state || state.occupiedByPlayerId !== player.id || player.activeCabinetId !== cabinetId) return { ok: false, reason: 'not-owner' };
    if (state.status !== 'in-use') { state.status = 'in-use'; state.sessionStartedAt = Date.now(); alignPlayer(player, definition, 'interact', Date.now()); socket.serializeAttachment(attachment); await this.saveCabinets(); this.broadcast('cabinet:state-changed', state); this.broadcast('player:moved', player); }
    return approved(state, definition);
  }

  private async releaseCabinet(socket: WebSocket, attachment: SocketAttachment, payload: unknown): Promise<Record<string, unknown>> {
    const player = attachment.player; const cabinetId = asObject(payload)?.cabinetId;
    if (!player || typeof cabinetId !== 'string') return { ok: false, reason: 'invalid-request' };
    const state = this.cabinetStates.get(cabinetId);
    if (!state || state.occupiedByPlayerId !== player.id) return { ok: false, reason: 'not-owner' };
    await this.releaseState(state, player); socket.serializeAttachment(attachment); return { ok: true, state };
  }

  private async disconnect(socket: WebSocket): Promise<void> {
    const attachment = socket.deserializeAttachment() as SocketAttachment;
    const player = attachment.player;
    if (!player || !attachment.resumeToken) return;
    const now = Date.now(); player.s = 'disconnected';
    this.resumes.set(attachment.resumeToken, { player: { ...player, p: [...player.p] }, resumeToken: attachment.resumeToken, disconnectedAt: now, expiresAt: now + RECONNECT_GRACE_MS });
    await this.saveResumes(); this.broadcast('player:disconnected', { id: player.id }, socket); await this.updatePopulation(); await this.scheduleAlarm();
  }

  private async forceReleaseFor(playerId: string, reason: string): Promise<void> {
    const state = [...this.cabinetStates.values()].find((candidate) => candidate.occupiedByPlayerId === playerId);
    if (!state) return;
    const socket = this.socketForPlayer(playerId); const attachment = socket?.deserializeAttachment() as SocketAttachment | undefined;
    if (attachment?.player) { clearCabinetPlayer(attachment.player); socket?.serializeAttachment(attachment); }
    Object.assign(state, availableCabinet(state.cabinetId)); await this.saveCabinets(); this.broadcast('cabinet:state-changed', state);
    if (socket) this.send(socket, 'cabinet:forced-release', { cabinetId: state.cabinetId, reason });
  }

  private async releaseState(state: CabinetState, player: PlayerState): Promise<void> {
    clearCabinetPlayer(player); Object.assign(state, availableCabinet(state.cabinetId)); await this.saveCabinets();
    this.broadcast('cabinet:state-changed', state); this.broadcast('player:moved', player);
  }

  private async system(text: string): Promise<void> { await this.pushChat({ id: crypto.randomUUID(), roomId: this.roomId, kind: 'system', playerId: null, displayName: null, text, at: Date.now() }); }
  private async pushChat(message: ChatMessage): Promise<void> { this.history.push(message); if (this.history.length > 40) this.history.splice(0, this.history.length - 40); await this.ctx.storage.put('chat', this.history); this.broadcast('chat:message', message); }
  private async saveCabinets(): Promise<void> { await this.ctx.storage.put('cabinets', [...this.cabinetStates]); }
  private async saveResumes(): Promise<void> { await this.ctx.storage.put('resumes', [...this.resumes]); }

  private async updatePopulation(): Promise<void> {
    const population = this.joinedSockets().length; const level = population >= 4 ? 'busy' : population >= 2 ? 'active' : 'quiet';
    if (this.world.population === population && this.world.activityLevel === level) return;
    const previous = this.world.activityLevel; this.world.population = population; this.world.activityLevel = level; this.world.revision += 1;
    await this.ctx.storage.put('world', this.world); this.broadcast('world:state-changed', this.world);
    if (level === 'busy' && previous !== 'busy') {
      const announcement = { id: crypto.randomUUID(), roomId: this.roomId, text: 'The arcade is getting busy.', kind: 'activity' as const, at: Date.now(), audioCue: 'busy' };
      this.broadcast('world:announcement', announcement); await this.pushChat({ ...announcement, kind: 'announcement', playerId: null, displayName: null });
    }
  }

  private joinedSockets(): WebSocket[] { return this.ctx.getWebSockets().filter((socket) => Boolean((socket.deserializeAttachment() as SocketAttachment).player)); }
  private connectedPlayers(): PlayerState[] { return this.joinedSockets().map((socket) => (socket.deserializeAttachment() as SocketAttachment).player!); }
  private socketForPlayer(playerId: string): WebSocket | undefined { return this.joinedSockets().find((socket) => (socket.deserializeAttachment() as SocketAttachment).player?.id === playerId); }
  private send(socket: WebSocket, event?: string, data?: unknown, requestId?: string): void { try { socket.send(JSON.stringify(event ? { e: event, d: data } : { q: requestId, d: data })); } catch { /* disconnected */ } }
  private broadcast(event: string, data: unknown, except?: WebSocket): void { for (const socket of this.joinedSockets()) if (socket !== except) this.send(socket, event, data); }
  private async scheduleAlarm(): Promise<void> {
    const now = Date.now();
    let next = Number.POSITIVE_INFINITY;
    for (const record of this.resumes.values()) next = Math.min(next, record.expiresAt);
    for (const state of this.cabinetStates.values()) if (state.status === 'reserved' && state.reservedAt !== null) next = Math.min(next, state.reservedAt + CABINET_TIMEOUT_MS);
    for (const socket of this.joinedSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment;
      if (attachment.player && !attachment.player.activeCabinetId && attachment.player.s !== 'away') next = Math.min(next, attachment.lastActivityAt + AFK_TIMEOUT_MS);
    }
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(Math.max(now + 250, next));
  }
}

function validateIdentity(value: unknown): { displayName: string; avatarId: string } | undefined {
  const identity = asObject(value); if (!identity || typeof identity.displayName !== 'string') return undefined;
  const displayName = identity.displayName.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (displayName.length < 2 || displayName.length > 18 || !/^[A-Za-z0-9 ._-]+$/.test(displayName)) return undefined;
  const avatarId = typeof identity.avatarId === 'string' && approvedAvatars.has(identity.avatarId) ? identity.avatarId : defaultAvatarId;
  return { displayName, avatarId };
}
function sanitizeText(value: unknown): string { return typeof value === 'string' ? value.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim() : ''; }
function asObject(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function normalizeRoomId(value: string | null): string { return typeof value === 'string' && approvedRooms.has(value) ? value : ROOM_ID; }
function isAllowedOrigin(value: string | null): boolean {
  if (!value) return true; // Native smoke tests and non-browser health tooling.
  if (
    value === 'https://ptcarcade.fun'
    || value === 'https://www.ptcarcade.fun'
    // The origin the domain currently fronts. Reachable directly, and the
    // useful thing to test against when the domain itself is in doubt.
    || value === 'https://retro-arcade-multiplayer.onrender.com'
    || value === 'https://retro-arcade-om7.pages.dev'
  ) return true;
  // Deliberately absent: the Fly hostname. Allowlisting a name nobody has
  // registered hands the entry to whoever registers it first; it goes back in
  // when the app exists and serves the site.
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(value);
}
async function verifyRealtimeTicket(value: string | null, secret: string): Promise<TicketIdentity | undefined> {
  if (!value || value.length > 2_048) return undefined;
  const parts = value.split('.');
  if (parts.length !== 2) return undefined;
  try {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify('HMAC', key, decodeBase64Url(parts[1]), new TextEncoder().encode(parts[0]));
    if (!valid) return undefined;
    const payload = asObject(JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[0]))));
    if (!payload || (payload.v !== 1 && payload.v !== 2) || typeof payload.pid !== 'string' || !/^player-[0-9a-f]{32}$/.test(payload.pid)) return undefined;
    if (payload.v === 2 && payload.mode !== 'guest' && payload.mode !== 'wallet') return undefined;
    if (typeof payload.exp !== 'number' || payload.exp <= Date.now() || payload.exp > Date.now() + 120_000) return undefined;
    const identity = validateIdentity({ displayName: payload.n, avatarId: payload.a });
    if (!identity) return undefined;
    return {
      playerId: payload.pid,
      displayName: identity.displayName,
      avatarId: payload.v === 2 ? identity.avatarId : 'neon-capsule',
      mode: payload.v === 2 && payload.mode === 'wallet' ? 'wallet' : 'guest'
    };
  } catch { return undefined; }
}
function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
function isInsideWorld(x: number, z: number): boolean {
  if (x >= MIN_WORLD_X && x <= MAX_WORLD_X && z >= MIN_WORLD_Z && z <= MAX_WORLD_Z) return true;
  // The Silent Hill room runs deeper than its column, into the west end of the
  // tournament hall down to its back wall. Matches SILENT_HILL_ANNEX in
  // arcade.js.
  return x >= -42.7 && x <= -13.7 && z >= MAX_WORLD_Z && z <= 49.9;
}

function violatesSocialLayout(fromX: number, fromZ: number, toX: number, toZ: number): boolean {
  for (const wallX of [-PARTITION_WALL_X, PARTITION_WALL_X]) {
    // The wall runs the length of its column and no further: north of it the
    // hall is full width, which is what lets the top row's outer rooms open
    // onto the hall.
    if (Math.max(fromZ, toZ) < SIDE_COLUMN_MIN_Z || Math.min(fromZ, toZ) > SIDE_COLUMN_MAX_Z) continue;
    const throughDoor = (z: number) => OPEN_DOOR_Z.some((doorZ) => Math.abs(z - doorZ) < ROOM_DOOR_CLEARANCE);
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
      // The west column's end wall is gone: Silent Hill continues into its
      // annex through where it stood. The Silent Hill annex is wider than the
      // room now, so the opening spans everything west of its east wall.
      if (dividerZ === 33.6 && Math.max(fromX, toX) < -13.4) continue;
      // The east column's first divider stands at the Chao Garden's new edge.
      const wallZ = (dividerZ === -16.8 && Math.min(fromX, toX) > 0) ? -12 : dividerZ;
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
  if (toX < POKEMON_WEST_X && !throughTopRowDoor(toX) && Math.abs(toZ - TOP_ROW_WALL_Z) < PARTITION_COLLISION_HALF_WIDTH) return true;
  if ((fromZ - TOP_ROW_WALL_Z) * (toZ - TOP_ROW_WALL_Z) < 0) {
    const crossing = (TOP_ROW_WALL_Z - fromZ) / (toZ - fromZ);
    const crossingX = fromX + (toX - fromX) * crossing;
    if (crossing >= 0 && crossing <= 1 && crossingX < POKEMON_WEST_X && !throughTopRowDoor(crossingX)) return true;
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
    if (toZ > -47.4 && toZ < POKEMON_SOUTH_Z + 0.5 && Math.abs(toX - wallX) < 0.3) return true;
    if ((fromX - wallX) * (toX - wallX) < 0) {
      const crossing = (wallX - fromX) / (toX - fromX);
      const crossingZ = fromZ + (toZ - fromZ) * crossing;
      if (crossing >= 0 && crossing <= 1 && crossingZ > -47.4 && crossingZ < POKEMON_SOUTH_Z + 0.5) return true;
    }
  }
  // The stadium's west wall: full depth, no doorway.
  if (Math.min(fromZ, toZ) < POKEMON_SOUTH_Z) {
    if (toZ < POKEMON_SOUTH_Z && Math.abs(toX - POKEMON_WEST_X) < PARTITION_COLLISION_HALF_WIDTH) return true;
    if ((fromX - POKEMON_WEST_X) * (toX - POKEMON_WEST_X) < 0) {
      const crossing = (POKEMON_WEST_X - fromX) / (toX - fromX);
      const crossingZ = fromZ + (toZ - fromZ) * crossing;
      if (crossing >= 0 && crossing <= 1 && crossingZ < POKEMON_SOUTH_Z) return true;
    }
  }
  // Inside the top row's west stretch, the wall between its two rooms.
  if (Math.max(fromZ, toZ) < TOP_ROW_WALL_Z && Math.min(fromX, toX) < POKEMON_WEST_X) {
    for (const dividerX of NORTH_ROW_DIVIDER_X) {
      if (Math.abs(toX - dividerX) < PARTITION_COLLISION_HALF_WIDTH) return true;
      if ((fromX - dividerX) * (toX - dividerX) < 0) return true;
    }
  }
  return false;
}
function normalizeAngle(value: number): number { return Math.atan2(Math.sin(value), Math.cos(value)); }
function chooseSpawn(players: PlayerState[]): typeof spawnPoints[number] { return spawnPoints.find((spawn) => players.every((player) => Math.hypot(player.p[0] - spawn[0], player.p[2] - spawn[2]) >= 1.4)) ?? spawnPoints[players.length % spawnPoints.length]; }
function availableCabinet(cabinetId: string): CabinetState { return { cabinetId, occupiedByPlayerId: null, occupiedByDisplayName: null, status: 'available', reservedAt: null, sessionStartedAt: null }; }
function initialWorld(roomId: string): WorldState { return { roomId, themeId: worldConfig.defaultThemeId, weatherId: worldConfig.defaultWeatherId, activityLevel: 'quiet', population: 0, jukebox: { trackId: null, playing: false, startedAt: null, changedBy: null }, revision: 1 }; }
function approved(state: CabinetState, definition: typeof cabinetRegistry[number]): Record<string, unknown> { return { ok: true, state: { ...state }, alignment: { position: [definition.playerPosition.x, definition.playerPosition.y, definition.playerPosition.z], rotationY: definition.playerRotationY } }; }
function alignPlayer(player: PlayerState, definition: typeof cabinetRegistry[number], state: 'reserved' | 'interact', now: number): void { player.activeCabinetId = definition.id; player.interactionState = state; player.movementLocked = true; player.cabinetSessionStartedAt = state === 'interact' ? now : null; player.p = [definition.playerPosition.x, definition.playerPosition.y, definition.playerPosition.z]; player.r = definition.playerRotationY; player.a = state === 'interact' ? 'interact' : 'idle'; player.s = state === 'interact' ? 'playing' : 'loading'; }
function clearCabinetPlayer(player: PlayerState): void { player.activeCabinetId = null; player.interactionState = 'none'; player.movementLocked = false; player.cabinetSessionStartedAt = null; player.a = 'idle'; player.s = 'idle'; }
function json(data: unknown, status = 200): Response { return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } }); }
