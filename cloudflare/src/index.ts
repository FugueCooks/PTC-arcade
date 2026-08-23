import cabinetRegistry from '../../assets/cabinets/registry.json';
import avatarRegistry from '../../assets/avatars/registry.json';
import worldConfig from '../../assets/world/config.json';

interface Env { ARCADE_ROOMS: DurableObjectNamespace }
type AnimationState = 'idle' | 'walk' | 'run' | 'interact';
type PlayerStatus = 'idle' | 'walking' | 'playing' | 'loading' | 'away' | 'disconnected';
type Position = [number, number, number];
type CabinetStatus = 'available' | 'reserved' | 'in-use';
interface PlayerState {
  id: string; n: string; v: string; roomId: string; p: Position; r: number; a: AnimationState; s: PlayerStatus;
  activeCabinetId: string | null; interactionState: 'none' | 'reserved' | 'interact'; movementLocked: boolean;
  cabinetSessionStartedAt: number | null;
}
interface SocketAttachment { socketId: string; player?: PlayerState; resumeToken?: string; lastAcceptedAt: number; lastActivityAt: number }
interface ResumeRecord { player: PlayerState; resumeToken: string; disconnectedAt: number; expiresAt: number }
interface CabinetState { cabinetId: string; occupiedByPlayerId: string | null; occupiedByDisplayName: string | null; status: CabinetStatus; reservedAt: number | null; sessionStartedAt: number | null }
interface ChatMessage { id: string; roomId: string; kind: 'chat' | 'system' | 'announcement'; playerId: string | null; displayName: string | null; text: string; at: number }
interface WorldState { roomId: string; themeId: string; weatherId: string; activityLevel: 'quiet' | 'active' | 'busy'; population: number; jukebox: { trackId: string | null; playing: boolean; startedAt: number | null; changedBy: string | null }; revision: number }
interface WireMessage { e?: string; d?: unknown; q?: string }

const ROOM_ID = 'main';
const PLAYER_HEIGHT = 1.65;
const RECONNECT_GRACE_MS = 10_000;
const MAX_SPEED_PER_SECOND = 7;
const MOVEMENT_PACKET_MS = 50;
const MOVEMENT_TOLERANCE = 0.3;
const CABINET_DISTANCE = 2.6;
const CABINET_TIMEOUT_MS = 5_000;
const AFK_TIMEOUT_MS = 120_000;
const approvedAvatars = new Set(avatarRegistry.avatars.filter((avatar) => avatar.enabled).map((avatar) => avatar.id));
const defaultAvatarId = 'neon-capsule';
const cabinets = new Map(cabinetRegistry.map((cabinet) => [cabinet.id, cabinet]));
const spawnPoints = [
  [0, PLAYER_HEIGHT, 11, Math.PI], [-2.2, PLAYER_HEIGHT, 11, Math.PI], [2.2, PLAYER_HEIGHT, 11, Math.PI],
  [-1.1, PLAYER_HEIGHT, 8.8, 0], [1.1, PLAYER_HEIGHT, 8.8, 0]
] as const;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/healthz') return json({ ok: true, service: 'retro-arcade-realtime', edge: request.cf?.colo ?? null });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ ok: false, message: 'WebSocket upgrade required.' }, 426);
    const roomId = normalizeRoomId(url.searchParams.get('room'));
    return env.ARCADE_ROOMS.getByName(roomId).fetch(request);
  }
} satisfies ExportedHandler<Env>;

export class ArcadeRoom implements DurableObject {
  private readonly ctx: DurableObjectState;
  private roomId = ROOM_ID;
  private cabinetStates = new Map<string, CabinetState>();
  private history: ChatMessage[] = [];
  private world: WorldState = initialWorld(ROOM_ID);
  private resumes = new Map<string, ResumeRecord>();
  private requestTimes = new Map<string, number>();
  private chatTimes = new Map<string, number[]>();
  private reactionTimes = new Map<string, number>();
  private movementBroadcastTimes = new Map<string, number>();

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
    ctx.blockConcurrencyWhile(async () => {
      this.roomId = (await ctx.storage.get<string>('roomId')) ?? ROOM_ID;
      this.cabinetStates = new Map((await ctx.storage.get<Array<[string, CabinetState]>>('cabinets')) ?? cabinetRegistry.map(({ id }) => [id, availableCabinet(id)]));
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
    server.serializeAttachment({ socketId: crypto.randomUUID(), lastAcceptedAt: Date.now(), lastActivityAt: Date.now() } satisfies SocketAttachment);
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
      case 'world:jukebox-set': acknowledge(await this.setJukebox(socket, attachment, message.d)); break;
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
    const identity = validateIdentity(request?.identity);
    if (!identity) { this.send(socket, 'room:error', { message: 'Choose a valid display name before entering the arcade.' }); return; }
    const now = Date.now();
    const requestedToken = typeof request?.resumeToken === 'string' ? request.resumeToken : undefined;
    const resumed = requestedToken ? this.resumes.get(requestedToken) : undefined;
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
        id: crypto.randomUUID(), n: identity.displayName, v: identity.avatarId, roomId: this.roomId,
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
    if ((x as number) < -27 || (x as number) > 27 || Math.abs(z as number) > 16) return this.correct(socket, player);
    const elapsed = now - attachment.lastAcceptedAt;
    const distance = Math.hypot((x as number) - player.p[0], (z as number) - player.p[2]);
    const permitted = MAX_SPEED_PER_SECOND * Math.min(elapsed, 500) / 1000 + MOVEMENT_TOLERANCE;
    if (elapsed < MOVEMENT_PACKET_MS || distance > permitted) return this.correct(socket, player);
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
  }

  private correct(socket: WebSocket, player?: PlayerState): void { if (player) this.send(socket, 'player:state', player); }

  private noteActivity(socket: WebSocket, attachment: SocketAttachment): void {
    if (!attachment.player) return;
    attachment.lastActivityAt = Date.now();
    if (attachment.player.s === 'away') {
      attachment.player.s = attachment.player.activeCabinetId ? (attachment.player.interactionState === 'interact' ? 'playing' : 'loading') : 'idle';
      this.broadcast('player:status', { id: attachment.player.id, status: attachment.player.s, at: Date.now() });
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

  private async setJukebox(socket: WebSocket, attachment: SocketAttachment, payload: unknown): Promise<Record<string, unknown>> {
    const player = attachment.player; const request = asObject(payload); const playing = request?.playing; const trackId = request?.trackId;
    if (!player || typeof playing !== 'boolean' || (playing && typeof trackId !== 'string')) return { ok: false, reason: 'invalid' };
    if (playing && !worldConfig.tracks.some((track) => track.id === trackId)) return { ok: false, reason: 'unknown-track' };
    const now = Date.now(); if (now - (this.requestTimes.get(`jukebox:${player.id}`) ?? -Infinity) < 500) return { ok: false, reason: 'rate-limited' };
    this.requestTimes.set(`jukebox:${player.id}`, now);
    this.world.jukebox = { trackId: playing ? trackId as string : this.world.jukebox.trackId, playing, startedAt: playing ? now : null, changedBy: player.n };
    this.world.revision += 1; await this.ctx.storage.put('world', this.world); this.broadcast('world:state-changed', this.world);
    const text = playing ? `${player.n} selected a jukebox track.` : `${player.n} stopped the jukebox.`;
    const announcement = { id: crypto.randomUUID(), roomId: this.roomId, text, kind: 'event', at: now, audioCue: 'jukebox' };
    this.broadcast('world:announcement', announcement); await this.pushChat({ ...announcement, kind: 'announcement', playerId: null, displayName: null });
    return { ok: true, state: this.world.jukebox };
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
    let next = now + 10_000;
    for (const record of this.resumes.values()) next = Math.min(next, record.expiresAt);
    for (const state of this.cabinetStates.values()) if (state.status === 'reserved' && state.reservedAt !== null) next = Math.min(next, state.reservedAt + CABINET_TIMEOUT_MS);
    for (const socket of this.joinedSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment;
      if (attachment.player && !attachment.player.activeCabinetId && attachment.player.s !== 'away') next = Math.min(next, attachment.lastActivityAt + AFK_TIMEOUT_MS);
    }
    await this.ctx.storage.setAlarm(Math.max(now + 250, next));
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
function normalizeRoomId(value: string | null): string { return typeof value === 'string' && /^[a-z0-9-]{1,32}$/.test(value) ? value : ROOM_ID; }
function normalizeAngle(value: number): number { return Math.atan2(Math.sin(value), Math.cos(value)); }
function chooseSpawn(players: PlayerState[]): typeof spawnPoints[number] { return spawnPoints.find((spawn) => players.every((player) => Math.hypot(player.p[0] - spawn[0], player.p[2] - spawn[2]) >= 1.4)) ?? spawnPoints[players.length % spawnPoints.length]; }
function availableCabinet(cabinetId: string): CabinetState { return { cabinetId, occupiedByPlayerId: null, occupiedByDisplayName: null, status: 'available', reservedAt: null, sessionStartedAt: null }; }
function initialWorld(roomId: string): WorldState { return { roomId, themeId: worldConfig.defaultThemeId, weatherId: worldConfig.defaultWeatherId, activityLevel: 'quiet', population: 0, jukebox: { trackId: null, playing: false, startedAt: null, changedBy: null }, revision: 1 }; }
function approved(state: CabinetState, definition: typeof cabinetRegistry[number]): Record<string, unknown> { return { ok: true, state: { ...state }, alignment: { position: [definition.playerPosition.x, definition.playerPosition.y, definition.playerPosition.z], rotationY: definition.playerRotationY } }; }
function alignPlayer(player: PlayerState, definition: typeof cabinetRegistry[number], state: 'reserved' | 'interact', now: number): void { player.activeCabinetId = definition.id; player.interactionState = state; player.movementLocked = true; player.cabinetSessionStartedAt = state === 'interact' ? now : null; player.p = [definition.playerPosition.x, definition.playerPosition.y, definition.playerPosition.z]; player.r = definition.playerRotationY; player.a = state === 'interact' ? 'interact' : 'idle'; player.s = state === 'interact' ? 'playing' : 'loading'; }
function clearCabinetPlayer(player: PlayerState): void { player.activeCabinetId = null; player.interactionState = 'none'; player.movementLocked = false; player.cabinetSessionStartedAt = null; player.a = 'idle'; player.s = 'idle'; }
function json(data: unknown, status = 200): Response { return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } }); }
