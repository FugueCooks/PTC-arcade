import { createSecureToken, hashSecureToken } from './secure-token.js';
import type { PreferenceUpdate, SafeSessionSummary, TokenKind } from './account-repository.js';
import type { LoginRecord, SafeIdentity } from './auth-repository.js';

interface PasswordService { hash(password: string): Promise<string>; verify(encodedHash: string, password: string): Promise<boolean> }
export interface AccountStore {
  updateProfile(userId: string, input: { displayName: string; normalizedDisplayName: string; avatarId: string }): Promise<SafeIdentity | undefined>;
  preferences(userId: string): Promise<unknown>; updatePreferences(userId: string, input: PreferenceUpdate): Promise<unknown>;
  sessions(userId: string): Promise<SafeSessionSummary[]>; revokeSession(userId: string, sessionId: string): Promise<boolean>;
  revokeOthers(userId: string, currentTokenHash: string): Promise<number>; loginByEmail(email: string): Promise<LoginRecord | undefined>;
  loginById(userId: string): Promise<LoginRecord | undefined>; createToken(kind: TokenKind, userId: string, tokenHash: string, expiresAt: Date): Promise<void>;
  consumeToken(kind: TokenKind, tokenHash: string): Promise<string | undefined>; verifyEmail(userId: string): Promise<void>;
  replacePassword(userId: string, passwordHash: string): Promise<void>; deleteAccount(userId: string): Promise<void>;
}

export class AccountService {
  constructor(private readonly repository: AccountStore, private readonly passwords: PasswordService,
    private readonly resetTtlMs = 30 * 60_000, private readonly verificationTtlMs = 24 * 60 * 60_000) {}

  updateProfile(userId: string, input: { displayName: string; normalizedDisplayName: string; avatarId: string }): Promise<SafeIdentity | undefined> {
    return this.repository.updateProfile(userId, input);
  }
  preferences(userId: string) { return this.repository.preferences(userId); }
  updatePreferences(userId: string, input: PreferenceUpdate) { return this.repository.updatePreferences(userId, input); }
  sessions(userId: string): Promise<SafeSessionSummary[]> { return this.repository.sessions(userId); }
  revokeSession(userId: string, sessionId: string) { return this.repository.revokeSession(userId, sessionId); }
  revokeOthers(userId: string, currentToken: string) { return this.repository.revokeOthers(userId, hashSecureToken(currentToken)); }

  async requestReset(normalizedEmail: string): Promise<string | undefined> {
    const user = await this.repository.loginByEmail(normalizedEmail);
    if (!user || user.status === 'deleted' || user.status === 'disabled') return undefined;
    return this.issueToken('reset', user.id, this.resetTtlMs);
  }
  async completeReset(token: string, password: string): Promise<boolean> {
    const userId = await this.repository.consumeToken('reset', hashSecureToken(token));
    if (!userId) return false;
    await this.repository.replacePassword(userId, await this.passwords.hash(password));
    return true;
  }
  async requestVerification(userId: string): Promise<string> { return this.issueToken('verification', userId, this.verificationTtlMs); }
  async completeVerification(token: string): Promise<boolean> {
    const userId = await this.repository.consumeToken('verification', hashSecureToken(token));
    if (!userId) return false;
    await this.repository.verifyEmail(userId); return true;
  }
  async deleteAccount(userId: string, password: string): Promise<boolean> {
    const user = await this.repository.loginById(userId);
    if (!user || !await this.passwords.verify(user.passwordHash, password)) return false;
    await this.repository.deleteAccount(userId); return true;
  }
  private async issueToken(kind: TokenKind, userId: string, ttlMs: number): Promise<string> {
    const token = createSecureToken();
    await this.repository.createToken(kind, userId, token.hash, new Date(Date.now() + ttlMs));
    return token.token;
  }
}
