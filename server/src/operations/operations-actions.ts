import type { SafeJsonValue } from '../domain/json-value.js';
import type { OperationsAuditLog } from './audit-log.js';
import { roleAllows, type OperatorSession } from './operator-auth.js';

/**
 * Milestone 11.28 — carefully scoped operational actions.
 *
 * Every action in this file is enumerated. There is no route that takes a
 * command, a query, or a key to run: no shell, no SQL, no Redis console. An
 * action can only be one of the named handlers registered below, which is what
 * keeps the "no arbitrary execution" requirement true by construction rather
 * than by filtering dangerous input.
 *
 * Each execution validates permission, then current state, then either applies
 * the change or reports why it cannot — and writes an audit record either way,
 * including for refusals.
 */
export type OperationsActionName =
  | 'server.drain'
  | 'server.stop-room-assignment'
  | 'room.close-empty'
  | 'room.set-maintenance'
  | 'cabinet.set-enabled'
  | 'game.set-enabled'
  | 'plugin.set-enabled'
  | 'plugin.restart'
  | 'registry.refresh'
  | 'feature-flag.set';

export interface ActionRequest {
  action: string;
  targetId?: unknown;
  value?: unknown;
  reason?: unknown;
  dryRun?: unknown;
  requestId: string;
}

export type ActionFailure =
  | 'unknown-action' | 'forbidden' | 'invalid-target' | 'invalid-value'
  | 'invalid-state' | 'reason-required' | 'not-found';

export interface ActionResult {
  ok: boolean;
  reason?: ActionFailure;
  message?: string;
  dryRun: boolean;
  /** What the action did, or would do when dryRun is set. */
  previousState?: SafeJsonValue | null;
  resultingState?: SafeJsonValue | null;
  /** True when the action found nothing to change. */
  noop?: boolean;
}

export interface ActionContext {
  targetId: string | null;
  value: SafeJsonValue | null;
  reason: string | null;
  dryRun: boolean;
}

export interface ActionHandler {
  /** Capability the operator's role must grant. */
  readonly capability: 'operations:act' | 'operations:admin';
  /** True when an operator must supply a written reason. */
  readonly requiresReason: boolean;
  readonly targetType: string;
  execute(context: ActionContext): Promise<ActionResult> | ActionResult;
}

export class OperationsActionRegistry {
  private readonly handlers = new Map<string, ActionHandler>();

  register(name: OperationsActionName, handler: ActionHandler): void {
    if (this.handlers.has(name)) throw new Error(`Duplicate operations action: ${name}`);
    this.handlers.set(name, handler);
  }

  names(): readonly string[] { return [...this.handlers.keys()].sort(); }
  get(name: string): ActionHandler | undefined { return this.handlers.get(name); }

  describe(): readonly { action: string; capability: string; requiresReason: boolean; targetType: string }[] {
    return [...this.handlers.entries()]
      .map(([action, handler]) => ({
        action, capability: handler.capability, requiresReason: handler.requiresReason, targetType: handler.targetType
      }))
      .sort((left, right) => left.action.localeCompare(right.action));
  }
}

const MAX_REASON_LENGTH = 500;

export class OperationsActionExecutor {
  constructor(
    private readonly registry: OperationsActionRegistry,
    private readonly audit: OperationsAuditLog,
    private readonly onAuditFailure: (error: unknown) => void = () => undefined
  ) {}

  async execute(session: OperatorSession, request: ActionRequest, now = Date.now()): Promise<ActionResult> {
    const handler = this.registry.get(request.action);
    if (!handler) {
      // Recorded: an attempt to invoke an action that does not exist is exactly
      // the kind of thing an audit trail should show.
      this.record(session, request, 'unknown', null, { ok: false, reason: 'unknown-action', dryRun: false }, now);
      return { ok: false, reason: 'unknown-action', dryRun: false };
    }

    if (!roleAllows(session.role, handler.capability)) {
      const result: ActionResult = { ok: false, reason: 'forbidden', dryRun: false, message: `role ${session.role} may not run ${request.action}` };
      this.record(session, request, handler.targetType, null, result, now);
      return result;
    }

    const targetId = typeof request.targetId === 'string' && request.targetId.length > 0 && request.targetId.length <= 128
      ? request.targetId
      : null;
    const reason = typeof request.reason === 'string' && request.reason.trim().length > 0
      ? request.reason.trim().slice(0, MAX_REASON_LENGTH)
      : null;
    if (handler.requiresReason && reason === null) {
      const result: ActionResult = { ok: false, reason: 'reason-required', dryRun: false };
      this.record(session, request, handler.targetType, null, result, now);
      return result;
    }

    const context: ActionContext = {
      targetId,
      value: isSafeValue(request.value) ? request.value : null,
      reason,
      dryRun: request.dryRun === true
    };

    let result: ActionResult;
    try {
      result = await handler.execute(context);
    } catch (error) {
      // A handler that throws must still produce an audit record and a safe
      // result, never a stack trace on the wire.
      result = { ok: false, reason: 'invalid-state', dryRun: context.dryRun, message: error instanceof Error ? error.message : 'action failed' };
    }
    this.record(session, request, handler.targetType, targetId, result, now, reason);
    return result;
  }

  /**
   * Writes the audit record. The audit log throws when a result carries a
   * secret-shaped field, and that must not become a rejected action promise:
   * the action already ran, and an unhandled rejection here would hang the
   * request. The failure is surfaced through `onAuditFailure` instead, and a
   * marker record is attempted without the offending state.
   */
  private record(
    session: OperatorSession,
    request: ActionRequest,
    targetType: string,
    targetId: string | null,
    result: ActionResult,
    now: number,
    reason: string | null = null
  ): void {
    try {
      this.writeRecord(session, request, targetType, targetId, result, now, reason);
    } catch (error) {
      this.onAuditFailure(error);
      try {
        // Never lose the fact that an action ran: re-record it without the
        // state that could not be written.
        this.writeRecord(session, request, targetType, targetId,
          { ...result, previousState: null, resultingState: null }, now, reason);
      } catch (secondary) {
        this.onAuditFailure(secondary);
      }
    }
  }

  private writeRecord(
    session: OperatorSession,
    request: ActionRequest,
    targetType: string,
    targetId: string | null,
    result: ActionResult,
    now: number,
    reason: string | null = null
  ): void {
    this.audit.write({
      operatorId: session.operatorId,
      action: String(request.action).slice(0, 128),
      targetType,
      targetId,
      reason,
      previousState: result.previousState ?? null,
      resultingState: result.resultingState ?? null,
      requestId: request.requestId,
      success: result.ok,
      failureReason: result.reason ?? null,
      dryRun: result.dryRun,
      now
    });
  }
}

function isSafeValue(value: unknown): value is SafeJsonValue {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

/** Parses an action's boolean payload, refusing anything ambiguous. */
export function requireBoolean(value: SafeJsonValue | null): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}
