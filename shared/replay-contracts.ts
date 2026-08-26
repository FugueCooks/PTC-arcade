import type { ReplayCapability } from './platform-contracts.js';

export type LogicalControl = 'UP' | 'DOWN' | 'LEFT' | 'RIGHT' | 'ACTION_1' | 'ACTION_2' | 'START' | 'SELECT';
export interface ReplayInputEvent { control: LogicalControl; pressed: boolean; tick: number; playerIndex: number }
export interface ReplayEnvelope {
  replayFormatVersion: number;
  gameId: string;
  gameVersion?: string;
  romFingerprint?: string;
  emulatorAdapterId: string;
  emulatorAdapterVersion: string;
  rulesVersion?: string;
  playerPublicId: string;
  attemptId?: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  inputTickRate: number;
  capability: ReplayCapability;
  initialSeed?: string;
  initialStateHash?: string;
  finalStateHash?: string;
  inputEvents: ReplayInputEvent[];
  checkpoints?: Array<{ tick: number; stateHash: string }>;
  score?: number;
  verificationPolicy: 'UNVERIFIED' | 'DETERMINISTIC';
  compression: 'none' | 'gzip';
  checksum: string;
}

export type ReplayVerificationStatus = 'NOT_AVAILABLE' | 'RECORDED' | 'PROCESSING'
  | 'VERIFIED' | 'DIVERGED' | 'UNSUPPORTED' | 'INVALID';
