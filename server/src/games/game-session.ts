import { randomUUID } from 'node:crypto';
import type { GameSessionRecord, GameSessionStatus } from '../../../shared/platform-contracts.js';

const transitions: Readonly<Record<GameSessionStatus, readonly GameSessionStatus[]>> = {
  CREATED: ['PREFLIGHT', 'FAILED', 'DISPOSED'],
  PREFLIGHT: ['READY', 'FAILED', 'STOPPING'],
  READY: ['STARTING', 'STOPPING', 'FAILED'],
  STARTING: ['ACTIVE', 'FAILED', 'STOPPING'],
  ACTIVE: ['PAUSED', 'STOPPING', 'COMPLETED', 'FAILED'],
  PAUSED: ['ACTIVE', 'STOPPING', 'FAILED'],
  STOPPING: ['COMPLETED', 'FAILED', 'DISPOSED'],
  COMPLETED: ['DISPOSED'],
  FAILED: ['DISPOSED'],
  DISPOSED: []
};

export interface NewGameSession {
  subjectId: string; playerId: string; roomId: string; cabinetId: string;
  gameId: string; emulatorAdapterId: string; competitiveAttemptId?: string;
}

/** Validated, idempotent lifecycle record shared by launch and observability services. */
export class GameSession {
  readonly record: GameSessionRecord;

  constructor(input: NewGameSession, now = Date.now(), sessionId: string = randomUUID()) {
    this.record = {
      ...input, sessionId, status: 'CREATED', createdAt: now,
      replayCaptureStatus: 'NOT_REQUESTED', scoreSubmissionStatus: 'NOT_REQUESTED'
    };
  }

  transition(next: GameSessionStatus, now = Date.now(), reason?: string): GameSessionRecord {
    if (this.record.status === next) return this.snapshot();
    if (!transitions[this.record.status].includes(next)) {
      throw new Error(`Invalid game session transition: ${this.record.status} -> ${next}`);
    }
    this.record.status = next;
    if (next === 'READY') this.record.preflightCompletedAt = now;
    if (next === 'ACTIVE' && this.record.startedAt === undefined) this.record.startedAt = now;
    if (next === 'PAUSED') this.record.pausedAt = now;
    if (['COMPLETED', 'FAILED', 'DISPOSED'].includes(next)) this.record.endedAt ??= now;
    if (reason) this.record.stopReason = reason;
    return this.snapshot();
  }

  stop(reason: string, now = Date.now()): GameSessionRecord {
    if (['COMPLETED', 'FAILED', 'DISPOSED'].includes(this.record.status)) return this.snapshot();
    if (this.record.status !== 'STOPPING') this.transition('STOPPING', now, reason);
    return this.transition('COMPLETED', now, reason);
  }

  dispose(now = Date.now()): GameSessionRecord {
    if (this.record.status === 'DISPOSED') return this.snapshot();
    if (!['COMPLETED', 'FAILED'].includes(this.record.status)) this.stop('disposed', now);
    return this.transition('DISPOSED', now);
  }

  snapshot(): GameSessionRecord { return structuredClone(this.record); }
}
