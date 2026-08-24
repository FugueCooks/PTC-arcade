import type { AuthRepository, SafeIdentity } from './auth-repository.js';

interface PasswordService { hash(password: string): Promise<string>; verify(encodedHash: string, password: string): Promise<boolean> }
interface TokenService { issue(now?: number): { token: string; hash: string; expiresAt: Date }; hash(token: string): string }

export type AuthFailure = 'invalid-credentials' | 'account-unavailable' | 'account-exists' | 'temporarily-unavailable';
export type AuthResult = { ok: true; identity: SafeIdentity; token: string; expiresAt: Date } | { ok: false; reason: AuthFailure };

export class AuthService {
  constructor(
    private readonly repository: AuthRepository,
    private readonly passwords: PasswordService,
    private readonly sessions: TokenService,
    private readonly guestSessions: TokenService,
    private readonly dummyPasswordHash: string
  ) {}

  async register(input: {
    email: string; normalizedEmail: string; password: string; displayName: string;
    normalizedDisplayName: string; avatarId: string; deviceType?: string;
  }): Promise<AuthResult> {
    const passwordHash = await this.passwords.hash(input.password);
    const identity = await this.repository.createRegistered({ ...input, passwordHash });
    if (!identity) return { ok: false, reason: 'account-exists' };
    const issued = this.sessions.issue();
    await this.repository.createSession(identity, issued.hash, issued.expiresAt, input.deviceType);
    await this.safeAudit('account-created', identity.id);
    return { ok: true, identity, token: issued.token, expiresAt: issued.expiresAt };
  }

  async login(input: { normalizedEmail: string; password: string; deviceType?: string }): Promise<AuthResult> {
    const login = await this.repository.findLogin(input.normalizedEmail);
    const passwordMatches = await this.passwords.verify(login?.passwordHash ?? this.dummyPasswordHash, input.password);
    if (!login || !passwordMatches) {
      await this.safeAudit('login-failed');
      return { ok: false, reason: 'invalid-credentials' };
    }
    if (login.status !== 'active' && login.status !== 'unverified') return { ok: false, reason: 'account-unavailable' };
    const issued = this.sessions.issue();
    await this.repository.createSession(login, issued.hash, issued.expiresAt, input.deviceType);
    await this.safeAudit('login-succeeded', login.id);
    return { ok: true, identity: withoutPassword(login), token: issued.token, expiresAt: issued.expiresAt };
  }

  async createGuest(input: { displayName: string; normalizedDisplayName: string; avatarId: string; deviceType?: string }): Promise<AuthResult> {
    const issued = this.guestSessions.issue();
    const identity = await this.repository.createGuest({ ...input, expiresAt: issued.expiresAt });
    await this.repository.createSession(identity, issued.hash, issued.expiresAt, input.deviceType);
    return { ok: true, identity, token: issued.token, expiresAt: issued.expiresAt };
  }

  async session(token: string | undefined): Promise<{ identity: SafeIdentity; expiresAt: Date } | undefined> {
    if (!token) return undefined;
    const session = await this.repository.findSession(this.sessions.hash(token));
    if (!session || (session.identity.status !== 'active' && session.identity.status !== 'unverified')) return undefined;
    return session;
  }

  async logout(token: string | undefined): Promise<void> {
    if (!token) return;
    await this.repository.revokeSession(this.sessions.hash(token));
  }

  private async safeAudit(eventType: string, userId?: string): Promise<void> {
    try { await this.repository.recordAudit(eventType, userId); } catch { /* Audit failure must not disclose or block authentication. */ }
  }
}

function withoutPassword(identity: SafeIdentity & { passwordHash?: string }): SafeIdentity {
  return { id: identity.id, type: identity.type, displayName: identity.displayName, avatarId: identity.avatarId, status: identity.status };
}
