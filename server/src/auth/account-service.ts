import { hashSecureToken } from './secure-token.js';
import type { PreferenceUpdate, SafeSessionSummary } from './account-repository.js';
import type { LoginRecord, SafeIdentity } from './auth-repository.js';

interface PasswordService { hash(password: string): Promise<string>; verify(encodedHash: string, password: string): Promise<boolean> }
export interface AccountStore {
  updateProfile(userId: string, input: { displayName: string; normalizedDisplayName: string; avatarId: string }): Promise<SafeIdentity | undefined>;
  preferences(userId: string): Promise<unknown>; updatePreferences(userId: string, input: PreferenceUpdate): Promise<unknown>;
  sessions(userId: string): Promise<SafeSessionSummary[]>; revokeSession(userId: string, sessionId: string): Promise<boolean>;
  revokeOthers(userId: string, currentTokenHash: string): Promise<number>;
  loginById(userId: string): Promise<LoginRecord | undefined>; deleteAccount(userId: string): Promise<void>;
  recordAudit(eventType: string, userId?: string): Promise<void>;
}

export class AccountService {
  constructor(private readonly repository: AccountStore, private readonly passwords: PasswordService) {}

  async updateProfile(userId: string, input: { displayName: string; normalizedDisplayName: string; avatarId: string }): Promise<SafeIdentity | undefined> {
    const identity = await this.repository.updateProfile(userId, input);
    if (identity) await this.safeAudit('profile-identity-changed', userId);
    return identity;
  }
  preferences(userId: string) { return this.repository.preferences(userId); }
  updatePreferences(userId: string, input: PreferenceUpdate) { return this.repository.updatePreferences(userId, input); }
  sessions(userId: string): Promise<SafeSessionSummary[]> { return this.repository.sessions(userId); }
  async revokeSession(userId: string, sessionId: string) { const result = await this.repository.revokeSession(userId, sessionId); if (result) await this.safeAudit('session-revoked', userId); return result; }
  async revokeOthers(userId: string, currentToken: string) { const result = await this.repository.revokeOthers(userId, hashSecureToken(currentToken)); if (result) await this.safeAudit('sessions-revoked', userId); return result; }

  async deleteAccount(userId: string, password: string): Promise<boolean> {
    const user = await this.repository.loginById(userId);
    if (!user || !await this.passwords.verify(user.passwordHash, password)) return false;
    await this.safeAudit('account-deletion-requested', userId); await this.repository.deleteAccount(userId); return true;
  }
  private async safeAudit(eventType: string, userId?: string): Promise<void> {
    try { await this.repository.recordAudit(eventType, userId); } catch { /* Audit storage must not expose or block account operations. */ }
  }
}
