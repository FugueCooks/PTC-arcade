export type SafeJson = null | boolean | number | string | SafeJson[] | { [key: string]: SafeJson };

export interface Vector3Data { x: number; y: number; z: number }
export interface CabinetScreenConfiguration { aspectRatio?: number; attractMode?: boolean }
export type CabinetInteractionPolicy = 'standard' | 'disabled' | 'competitive';

/** Static data only. Runtime render, network, DOM, and emulator objects are forbidden here. */
export interface CabinetDefinition {
  id: string;
  displayName: string;
  cabinetType: string;
  gameId: string;
  zoneId: string;
  enabled: boolean;
  interactionPosition: Vector3Data;
  playerPosition: Vector3Data;
  playerRotationY: number;
  sceneKey: string;
  modelAssetId?: string;
  marqueeAssetId?: string;
  screenConfiguration?: CabinetScreenConfiguration;
  interactionPolicy: CabinetInteractionPolicy;
  competitivePolicyId?: string;
  pluginId?: string;
  metadata?: Record<string, SafeJson>;
}

export type ReplayCapability = 'NONE' | 'INPUT_LOG' | 'INPUT_AND_SEED' | 'SAVE_STATE_AND_INPUT'
  | 'DETERMINISTIC_REPLAY' | 'VIDEO_ONLY' | 'CUSTOM';

export interface GameAssetRequirement {
  id: string;
  kind: 'game' | 'disc' | 'bios' | 'dsp' | 'support';
  file?: string;
  sizeBytes?: number;
  required: boolean;
}

export interface GameDefinition {
  id: string;
  displayName: string;
  platformId: string;
  launcherAdapterId: string;
  emulatorAdapterId?: string;
  assetRequirements: GameAssetRequirement[];
  inputProfileId: string;
  replayCapability: ReplayCapability;
  leaderboardIds?: string[];
  enabled: boolean;
  metadata?: Record<string, SafeJson>;
}

export type GameSessionStatus = 'CREATED' | 'PREFLIGHT' | 'READY' | 'STARTING' | 'ACTIVE'
  | 'PAUSED' | 'STOPPING' | 'COMPLETED' | 'FAILED' | 'DISPOSED';

export interface GameSessionRecord {
  sessionId: string;
  subjectId: string;
  playerId: string;
  roomId: string;
  cabinetId: string;
  gameId: string;
  emulatorAdapterId: string;
  competitiveAttemptId?: string;
  status: GameSessionStatus;
  createdAt: number;
  preflightCompletedAt?: number;
  startedAt?: number;
  pausedAt?: number;
  endedAt?: number;
  stopReason?: string;
  replayCaptureStatus: 'NOT_REQUESTED' | 'PENDING' | 'RECORDED' | 'FAILED' | 'UNSUPPORTED';
  scoreSubmissionStatus: 'NOT_REQUESTED' | 'PENDING' | 'SUBMITTED' | 'REJECTED' | 'UNSUPPORTED';
}

export interface CabinetStateDelta<TState> {
  roomId: string;
  zoneId: string;
  revision: number;
  previousRevision: number;
  changes: TState[];
}

export interface CabinetStateSnapshot<TState> {
  roomId: string;
  zoneId: string;
  revision: number;
  cabinets: TState[];
}

export const PLATFORM_API_VERSION = '11.1';
export const SOCKET_PROTOCOL_VERSION = 3;
