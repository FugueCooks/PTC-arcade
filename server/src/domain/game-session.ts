/**
 * Milestone 11.6 — one normalized session model with validated transitions.
 * Stop and dispose are idempotent: calling either twice is defined behaviour,
 * not an error, because a cabinet release, a socket disconnect, and an emulator
 * error can all race to end the same session.
 */
export type GameSessionStatus =
  | 'CREATED' | 'PREFLIGHT' | 'READY' | 'STARTING' | 'ACTIVE'
  | 'PAUSED' | 'STOPPING' | 'COMPLETED' | 'FAILED' | 'DISPOSED';

export type SessionStopReason =
  | 'player-exit' | 'cabinet-released' | 'disconnect' | 'emulator-error'
  | 'preflight-failed' | 'server-drain' | 'operator-action' | 'timeout';

export interface GameSession {
  readonly sessionId: string;
  readonly userId: string | null;
  readonly guestId: string | null;
  readonly playerId: string;
  readonly roomId: string;
  readonly cabinetId: string;
  readonly gameId: string;
  readonly emulatorAdapterId: string;
  /** Declared seam for the deferred competitive layer; always null in Phase 11. */
  readonly competitiveAttemptId: string | null;
  readonly status: GameSessionStatus;
  readonly createdAt: number;
  readonly preflightCompletedAt: number | null;
  readonly startedAt: number | null;
  readonly pausedAt: number | null;
  readonly endedAt: number | null;
  readonly stopReason: SessionStopReason | null;
  /** Phase 12 seams. Phase 11 never advances either past its initial value. */
  readonly replayCaptureStatus: 'NOT_APPLICABLE' | 'PENDING' | 'CAPTURED' | 'FAILED';
  readonly scoreSubmissionStatus: 'NOT_APPLICABLE' | 'PENDING' | 'SUBMITTED' | 'FAILED';
}

const TRANSITIONS: Readonly<Record<GameSessionStatus, readonly GameSessionStatus[]>> = Object.freeze({
  CREATED: ['PREFLIGHT', 'STOPPING', 'FAILED'],
  PREFLIGHT: ['READY', 'STOPPING', 'FAILED'],
  READY: ['STARTING', 'STOPPING', 'FAILED'],
  STARTING: ['ACTIVE', 'STOPPING', 'FAILED'],
  ACTIVE: ['PAUSED', 'STOPPING', 'FAILED'],
  PAUSED: ['ACTIVE', 'STOPPING', 'FAILED'],
  STOPPING: ['COMPLETED', 'FAILED'],
  COMPLETED: ['DISPOSED'],
  FAILED: ['DISPOSED'],
  DISPOSED: []
});

/** True terminal states: a session here will never run again. */
export const TERMINAL_STATUSES: readonly GameSessionStatus[] = Object.freeze(['COMPLETED', 'FAILED', 'DISPOSED']);

export function canTransition(from: GameSessionStatus, to: GameSessionStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: GameSessionStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export interface CreateGameSessionInput {
  sessionId: string;
  playerId: string;
  roomId: string;
  cabinetId: string;
  gameId: string;
  emulatorAdapterId: string;
  userId?: string | null;
  guestId?: string | null;
  now?: number;
}

export function createGameSession(input: CreateGameSessionInput): GameSession {
  const createdAt = input.now ?? Date.now();
  return Object.freeze({
    sessionId: input.sessionId,
    userId: input.userId ?? null,
    guestId: input.guestId ?? null,
    playerId: input.playerId,
    roomId: input.roomId,
    cabinetId: input.cabinetId,
    gameId: input.gameId,
    emulatorAdapterId: input.emulatorAdapterId,
    competitiveAttemptId: null,
    status: 'CREATED' as const,
    createdAt,
    preflightCompletedAt: null,
    startedAt: null,
    pausedAt: null,
    endedAt: null,
    stopReason: null,
    replayCaptureStatus: 'NOT_APPLICABLE' as const,
    scoreSubmissionStatus: 'NOT_APPLICABLE' as const
  });
}

export class InvalidSessionTransitionError extends Error {
  constructor(readonly sessionId: string, readonly from: GameSessionStatus, readonly to: GameSessionStatus) {
    super(`Session ${sessionId} cannot move from ${from} to ${to}.`);
    this.name = 'InvalidSessionTransitionError';
  }
}

/**
 * Applies a transition, stamping the timestamp that belongs to the target state.
 * Rejects any edge not in the table rather than silently coercing, so a bug in a
 * caller surfaces here instead of as a session stuck in an impossible state.
 */
export function transition(
  session: GameSession,
  to: GameSessionStatus,
  options: { now?: number; stopReason?: SessionStopReason } = {}
): GameSession {
  if (!canTransition(session.status, to)) throw new InvalidSessionTransitionError(session.sessionId, session.status, to);
  const now = options.now ?? Date.now();
  return Object.freeze({
    ...session,
    status: to,
    preflightCompletedAt: to === 'READY' ? now : session.preflightCompletedAt,
    startedAt: to === 'ACTIVE' && session.startedAt === null ? now : session.startedAt,
    pausedAt: to === 'PAUSED' ? now : (to === 'ACTIVE' ? null : session.pausedAt),
    endedAt: to === 'COMPLETED' || to === 'FAILED' ? now : session.endedAt,
    stopReason: options.stopReason ?? session.stopReason
  });
}

/**
 * Idempotent stop. A session already stopping or terminal is returned unchanged,
 * so the cabinet-release path, the disconnect path, and an emulator error may all
 * call this for the same session without racing or throwing.
 */
export function stop(session: GameSession, reason: SessionStopReason, now = Date.now()): GameSession {
  if (session.status === 'STOPPING' || isTerminal(session.status)) return session;
  return transition(session, 'STOPPING', { now, stopReason: reason });
}

/** Idempotent dispose. Drives any non-disposed session to DISPOSED in one call. */
export function dispose(session: GameSession, now = Date.now()): GameSession {
  if (session.status === 'DISPOSED') return session;
  const settled = session.status === 'COMPLETED' || session.status === 'FAILED'
    ? session
    : transition(stop(session, session.stopReason ?? 'player-exit', now), 'COMPLETED', { now });
  return transition(settled, 'DISPOSED', { now });
}
