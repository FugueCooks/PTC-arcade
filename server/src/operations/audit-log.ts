import { randomUUID } from 'node:crypto';
import type { SafeJsonValue } from '../domain/json-value.js';

/**
 * Milestone 11.29 — the operations audit log.
 *
 * Every operator action produces a record, including failures: an attempted and
 * refused action is exactly what an audit trail exists to show. Records are
 * bounded in memory with the oldest evicted, so a long-running server cannot
 * grow without limit.
 *
 * Nothing secret is ever recorded. Session tokens, CSRF tokens, and operator
 * credentials are stripped before a record is built, and `assertNoSecrets`
 * makes that a hard failure rather than a convention.
 */
export interface OperationsAuditRecord {
  readonly id: string;
  readonly operatorId: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly reason: string | null;
  readonly previousState: SafeJsonValue | null;
  readonly resultingState: SafeJsonValue | null;
  readonly at: number;
  readonly requestId: string;
  readonly success: boolean;
  readonly failureReason: string | null;
  readonly deploymentVersion: string;
  readonly dryRun: boolean;
}

export interface AuditWriteInput {
  operatorId: string;
  action: string;
  targetType: string;
  targetId?: string | null;
  reason?: string | null;
  previousState?: SafeJsonValue | null;
  resultingState?: SafeJsonValue | null;
  requestId: string;
  success: boolean;
  failureReason?: string | null;
  dryRun?: boolean;
  now?: number;
}

/** Field names that must never appear in an audit record. */
const FORBIDDEN_KEYS = ['token', 'sessiontoken', 'csrf', 'password', 'secret', 'privatekey', 'signature', 'cookie', 'authorization'];

export class AuditSecretLeakError extends Error {
  constructor(key: string) {
    super(`Refusing to write an audit record containing "${key}".`);
    this.name = 'AuditSecretLeakError';
  }
}

/**
 * Depth-bounded scan for secret-looking keys. Called on every write, so a
 * future caller cannot quietly start logging a token.
 */
export function assertNoSecrets(value: SafeJsonValue | null | undefined, depth = 0): void {
  if (value === null || value === undefined || depth > 8) return;
  if (Array.isArray(value)) { for (const entry of value) assertNoSecrets(entry, depth + 1); return; }
  if (typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z]/g, '');
    if (FORBIDDEN_KEYS.some((forbidden) => normalized.includes(forbidden))) throw new AuditSecretLeakError(key);
    assertNoSecrets(nested, depth + 1);
  }
}

export interface AuditLogFilter {
  operatorId?: string;
  action?: string;
  targetType?: string;
  success?: boolean;
  since?: number;
}

const DEFAULT_CAPACITY = 2_000;

export class OperationsAuditLog {
  private readonly records: OperationsAuditRecord[] = [];

  constructor(
    private readonly deploymentVersion: string,
    private readonly capacity: number = DEFAULT_CAPACITY,
    private readonly sink: (record: OperationsAuditRecord) => void = () => undefined
  ) {}

  write(input: AuditWriteInput): OperationsAuditRecord {
    assertNoSecrets(input.previousState ?? null);
    assertNoSecrets(input.resultingState ?? null);
    const record: OperationsAuditRecord = Object.freeze({
      id: randomUUID(),
      operatorId: input.operatorId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      reason: input.reason ?? null,
      previousState: input.previousState ?? null,
      resultingState: input.resultingState ?? null,
      at: input.now ?? Date.now(),
      requestId: input.requestId,
      success: input.success,
      failureReason: input.failureReason ?? null,
      deploymentVersion: this.deploymentVersion,
      dryRun: input.dryRun ?? false
    });
    this.records.push(record);
    // Oldest-first eviction keeps the most recent history, which is what an
    // operator investigating a live incident actually needs.
    if (this.records.length > this.capacity) this.records.splice(0, this.records.length - this.capacity);
    this.sink(record);
    return record;
  }

  get size(): number { return this.records.length; }

  /** Newest first, filtered and bounded. */
  list(filter: AuditLogFilter = {}, limit = 100): readonly OperationsAuditRecord[] {
    const bounded = Math.max(1, Math.min(limit, 500));
    const matches: OperationsAuditRecord[] = [];
    for (let at = this.records.length - 1; at >= 0 && matches.length < bounded; at -= 1) {
      const record = this.records[at];
      if (filter.operatorId !== undefined && record.operatorId !== filter.operatorId) continue;
      if (filter.action !== undefined && record.action !== filter.action) continue;
      if (filter.targetType !== undefined && record.targetType !== filter.targetType) continue;
      if (filter.success !== undefined && record.success !== filter.success) continue;
      if (filter.since !== undefined && record.at < filter.since) continue;
      matches.push(record);
    }
    return matches;
  }
}
