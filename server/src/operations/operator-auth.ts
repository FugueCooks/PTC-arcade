import { timingSafeEqual } from 'node:crypto';
import { createSecureToken, hashSecureToken } from '../auth/secure-token.js';

/**
 * Milestone 11.27 — operations access uses an authorization boundary entirely
 * separate from player accounts.
 *
 * This is a separate credential store, not a role bolted onto `users`. That is
 * deliberate: with no shared table there is no code path, present or future, by
 * which authenticating as a player can produce an operator session. The brief's
 * requirement that "a connected Solana player wallet must not automatically
 * grant operations access" is therefore structural rather than a check someone
 * could forget to write.
 *
 * Operator credentials come from the environment and are never stored in the
 * application database.
 */
export type OperatorRole = 'viewer' | 'operator' | 'admin';

export interface OperatorSession {
  readonly sessionId: string;
  readonly operatorId: string;
  readonly role: OperatorRole;
  readonly issuedAt: number;
  readonly expiresAt: number;
  /** Paired with the session; required on every state-changing request. */
  readonly csrfToken: string;
}

/** What each role may do. Viewers can look and nothing else. */
const ROLE_CAPABILITIES: Readonly<Record<OperatorRole, readonly string[]>> = Object.freeze({
  viewer: ['operations:read'],
  operator: ['operations:read', 'operations:act'],
  admin: ['operations:read', 'operations:act', 'operations:admin']
});

export function roleAllows(role: OperatorRole, capability: string): boolean {
  return ROLE_CAPABILITIES[role]?.includes(capability) ?? false;
}

export interface OperatorCredential {
  readonly operatorId: string;
  readonly role: OperatorRole;
  /** SHA-256 of the operator's access token. The token itself is never stored. */
  readonly tokenHash: string;
}

/**
 * Parses `OPERATIONS_OPERATORS`, formatted as `id:role:token` entries separated
 * by commas. Any malformed entry is dropped rather than loosening access.
 */
export function parseOperatorCredentials(value: string | undefined): readonly OperatorCredential[] {
  if (typeof value !== 'string' || value.trim() === '') return Object.freeze([]);
  const credentials: OperatorCredential[] = [];
  const seen = new Set<string>();
  for (const entry of value.split(',')) {
    const parts = entry.trim().split(':');
    if (parts.length !== 3) continue;
    const [operatorId, role, token] = parts.map((part) => part.trim());
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(operatorId) || seen.has(operatorId)) continue;
    if (role !== 'viewer' && role !== 'operator' && role !== 'admin') continue;
    // A short token is a weak token; refuse rather than accept it.
    if (token.length < 24) continue;
    seen.add(operatorId);
    credentials.push(Object.freeze({ operatorId, role, tokenHash: hashSecureToken(token) }));
  }
  return Object.freeze(credentials);
}

export type OperatorLoginFailure = 'invalid-credentials' | 'not-configured' | 'rate-limited';

export interface OperatorLoginResult {
  ok: boolean;
  reason?: OperatorLoginFailure;
  session?: OperatorSession;
  /** Returned once, at login. Only its hash is retained. */
  sessionToken?: string;
}

const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1_000;
const MAX_ATTEMPTS_PER_WINDOW = 10;
const ATTEMPT_WINDOW_MS = 10 * 60 * 1_000;
/** Stand-in hash so an unknown operator costs the same work as a known one. */
const ABSENT_OPERATOR_HASH = hashSecureToken('operator-does-not-exist');

/**
 * Issues, validates, and revokes operator sessions. Sessions live in memory:
 * they are short-lived, and a restart forcing operators to sign in again is the
 * safer failure mode.
 */
export class OperatorAuthService {
  private readonly sessions = new Map<string, OperatorSession>();
  private readonly attempts: number[] = [];

  constructor(
    private readonly credentials: readonly OperatorCredential[],
    private readonly sessionTtlMs: number = DEFAULT_SESSION_TTL_MS
  ) {}

  get configured(): boolean { return this.credentials.length > 0; }

  login(operatorId: unknown, token: unknown, now = Date.now()): OperatorLoginResult {
    // Milestone 11.27: never expose operations without authentication. With no
    // operators configured the endpoint exists but can never succeed.
    if (!this.configured) return { ok: false, reason: 'not-configured' };
    this.pruneAttempts(now);
    if (this.attempts.length >= MAX_ATTEMPTS_PER_WINDOW) return { ok: false, reason: 'rate-limited' };
    this.attempts.push(now);

    if (typeof operatorId !== 'string' || typeof token !== 'string' || token.length > 512) {
      return { ok: false, reason: 'invalid-credentials' };
    }
    const credential = this.credentials.find((entry) => entry.operatorId === operatorId);
    // Hash and compare in constant time whether or not the operator exists, so
    // neither path reveals which half of the credential was wrong.
    const suppliedHash = hashSecureToken(token);
    const expectedHash = credential?.tokenHash ?? ABSENT_OPERATOR_HASH;
    const matches = constantTimeEquals(suppliedHash, expectedHash);
    if (!matches || credential === undefined) return { ok: false, reason: 'invalid-credentials' };

    const secure = createSecureToken();
    const csrf = createSecureToken();
    const session: OperatorSession = {
      sessionId: secure.hash.slice(0, 32),
      operatorId: credential.operatorId,
      role: credential.role,
      issuedAt: now,
      expiresAt: now + this.sessionTtlMs,
      csrfToken: csrf.token
    };
    this.sessions.set(secure.hash, session);
    return { ok: true, session, sessionToken: secure.token };
  }

  /** Resolves a session token, dropping it if expired. */
  authenticate(sessionToken: string | undefined, now = Date.now()): OperatorSession | undefined {
    if (typeof sessionToken !== 'string' || sessionToken.length === 0) return undefined;
    const hash = hashSecureToken(sessionToken);
    const session = this.sessions.get(hash);
    if (!session) return undefined;
    if (session.expiresAt <= now) { this.sessions.delete(hash); return undefined; }
    return session;
  }

  /** Milestone 11.27: session revocation. */
  revoke(sessionToken: string | undefined): boolean {
    if (typeof sessionToken !== 'string') return false;
    return this.sessions.delete(hashSecureToken(sessionToken));
  }

  revokeAllFor(operatorId: string): number {
    let revoked = 0;
    for (const [hash, session] of this.sessions) {
      if (session.operatorId === operatorId) { this.sessions.delete(hash); revoked += 1; }
    }
    return revoked;
  }

  sweep(now = Date.now()): void {
    for (const [hash, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(hash);
  }

  get activeSessionCount(): number { return this.sessions.size; }

  private pruneAttempts(now: number): void {
    while (this.attempts.length > 0 && now - this.attempts[0] > ATTEMPT_WINDOW_MS) this.attempts.shift();
  }
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
