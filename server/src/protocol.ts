/**
 * Wire format shared by the real-time server and browser client.
 * Positions use short tuples to keep the high-frequency movement payload small.
 */
export const DEFAULT_ROOM_ID = 'main';

export type AnimationState = 'idle' | 'walk' | 'run' | 'interact';
export type PlayerStatus = 'idle' | 'walking' | 'playing' | 'loading' | 'away' | 'disconnected';
export type ReactionEmoji = '👍' | '😂' | '❤️' | '🔥' | '😮';
export type Position = readonly [x: number, y: number, z: number];

export interface PlayerMoveInput {
  /** Horizontal position only. The server owns the fixed camera height. */
  p: readonly [x: number, z: number];
  /** View yaw in radians. */
  r: number;
}

export interface PlayerState {
  id: string;
  /** Server-normalized display name and approved avatar ID. */
  n: string;
  v: string;
  roomId: string;
  p: Position;
  r: number;
  a: AnimationState;
  /** Compact social presence status. */
  s: PlayerStatus;
  activeCabinetId: string | null;
  interactionState: 'none' | 'reserved' | 'interact';
  movementLocked: boolean;
  cabinetSessionStartedAt: number | null;
}

export interface ChatMessage {
  id: string;
  roomId: string;
  kind: 'chat' | 'system' | 'announcement';
  playerId: string | null;
  displayName: string | null;
  text: string;
  at: number;
}
export interface ChatSendResult { ok: boolean; reason?: 'invalid' | 'too-long' | 'rate-limited' }
export interface ReactionEvent { playerId: string; emoji: ReactionEmoji; at: number; durationMs: number }
export interface SocialActionResult { ok: boolean; reason?: 'invalid' | 'rate-limited' }

export type WorldActivityLevel = 'quiet' | 'active' | 'busy';
export interface JukeboxState { trackId: string | null; playing: boolean; startedAt: number | null; changedBy: string | null }
export interface WorldState {
  roomId: string; themeId: string; weatherId: string; activityLevel: WorldActivityLevel;
  population: number; jukebox: JukeboxState; revision: number;
}
export interface WorldAnnouncement { id: string; roomId: string; text: string; kind: 'welcome' | 'activity' | 'event'; at: number; audioCue?: string }
export interface WorldEvent { id: string; roomId: string; type: 'power-flicker' | 'neon-surge' | 'machine-malfunction' | 'fireworks'; at: number; durationMs: number }
export interface JukeboxResult { ok: boolean; reason?: 'invalid' | 'unknown-track' | 'rate-limited'; state?: JukeboxState }

export type CabinetStatus = 'available' | 'reserved' | 'in-use';
export interface CabinetState {
  cabinetId: string;
  occupiedByPlayerId: string | null;
  occupiedByDisplayName: string | null;
  status: CabinetStatus;
  reservedAt: number | null;
  sessionStartedAt: number | null;
}
export interface CabinetSnapshot { roomId: string; cabinets: CabinetState[] }
/**
 * Milestone 11.14. A snapshot covers only the zones a client needs and carries
 * the revision it was taken at; each later delta carries the revision it
 * produces, so a client can detect a gap and request a targeted resync rather
 * than silently drifting.
 */
export interface CabinetZoneSnapshotPayload {
  roomId: string;
  revision: number;
  zoneIds: string[];
  cabinets: CabinetState[];
}
export interface CabinetDeltaPayload { roomId: string; revision: number; zoneId: string; state: CabinetState }
export interface CabinetResyncResult { ok: boolean; reason?: 'invalid-request' | 'unknown-zone'; snapshot?: CabinetZoneSnapshotPayload }
export type CabinetDenialReason = 'invalid-request' | 'unknown-cabinet' | 'disabled' | 'too-far' | 'already-using' | 'occupied' | 'rate-limited' | 'not-owner';
export interface CabinetUseResult {
  ok: boolean;
  reason?: CabinetDenialReason;
  state?: CabinetState;
  alignment?: { position: Position; rotationY: number };
}

export interface RoomSnapshot {
  roomId: string;
  selfId: string;
  players: PlayerState[];
}

export interface RoomJoinRequest {
  roomId?: string;
  /** Per-browser-tab token used only for a brief reconnect window. */
  resumeToken?: string;
  /** Short-lived capacity reservation issued by the placement endpoint. */
  reservationToken?: string;
  identity?: { displayName?: unknown; avatarId?: unknown };
}

export interface ClientToServerEvents {
  'room:join': (payload: RoomJoinRequest) => void;
  'player:move': (payload: PlayerMoveInput) => void;
  'cabinet:request-use': (payload: { cabinetId?: unknown }, acknowledge: (result: CabinetUseResult) => void) => void;
  'cabinet:activate': (payload: { cabinetId?: unknown }, acknowledge: (result: CabinetUseResult) => void) => void;
  'cabinet:release': (payload: { cabinetId?: unknown }, acknowledge: (result: CabinetUseResult) => void) => void;
  /** Requests a fresh snapshot for the named zones after a detected gap. */
  'cabinet:resync': (payload: { zoneIds?: unknown }, acknowledge: (result: CabinetResyncResult) => void) => void;
  'chat:send': (payload: { text?: unknown }, acknowledge: (result: ChatSendResult) => void) => void;
  'reaction:send': (payload: { emoji?: unknown }, acknowledge: (result: SocialActionResult) => void) => void;
  'presence:activity': () => void;
  'social:ping': (payload: { sentAt?: unknown }, acknowledge: (result: { serverAt: number }) => void) => void;
  'world:jukebox-set': (payload: { trackId?: unknown; playing?: unknown }, acknowledge: (result: JukeboxResult) => void) => void;
}

export interface ServerToClientEvents {
  'server:draining': (payload: { message: string; deadlineAt: number; warningMs: number }) => void;
  'room:snapshot': (payload: RoomSnapshot) => void;
  'room:resume': (payload: { resumeToken: string; resumed: boolean }) => void;
  'room:error': (payload: { message: string; code?: string }) => void;
  /** Server-approved local state. */
  'player:state': (payload: PlayerState) => void;
  'player:joined': (payload: PlayerState) => void;
  'player:moved': (payload: PlayerState) => void;
  'player:left': (payload: { id: string }) => void;
  'player:disconnected': (payload: { id: string }) => void;
  'player:reconnected': (payload: PlayerState) => void;
  'player:status': (payload: { id: string; status: PlayerStatus; at: number }) => void;
  'cabinet:snapshot': (payload: CabinetSnapshot) => void;
  'cabinet:state-changed': (payload: CabinetState) => void;
  'cabinet:zone-snapshot': (payload: CabinetZoneSnapshotPayload) => void;
  'cabinet:delta': (payload: CabinetDeltaPayload) => void;
  'cabinet:forced-release': (payload: { cabinetId: string; reason: string }) => void;
  'chat:snapshot': (payload: { roomId: string; messages: ChatMessage[] }) => void;
  'chat:message': (payload: ChatMessage) => void;
  'reaction:shown': (payload: ReactionEvent) => void;
  'world:snapshot': (payload: WorldState) => void;
  'world:state-changed': (payload: WorldState) => void;
  'world:announcement': (payload: WorldAnnouncement) => void;
  'world:event': (payload: WorldEvent) => void;
}
