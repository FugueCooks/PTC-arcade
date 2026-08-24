import assert from 'node:assert/strict';
import test from 'node:test';
import { AccountService, type AccountStore } from '../server/src/auth/account-service.js';
import type { LoginRecord, SafeIdentity } from '../server/src/auth/auth-repository.js';
import type { PreferenceUpdate, SafeSessionSummary, TokenKind } from '../server/src/auth/account-repository.js';

class MemoryAccounts implements AccountStore {
  user: LoginRecord = { id: 'user-1', type: 'registered', displayName: 'PLAYER', avatarId: 'neon-capsule', status: 'unverified', passwordHash: 'hash:old-password' };
  tokens = new Map<string, { kind: TokenKind; userId: string; used: boolean; expiresAt: Date }>();
  password = this.user.passwordHash; verified = false; deleted = false;
  async updateProfile(_id: string, input: { displayName: string; avatarId: string }): Promise<SafeIdentity> { return { ...this.user, ...input }; }
  async preferences(): Promise<unknown> { return {}; }
  async updatePreferences(_id: string, input: PreferenceUpdate): Promise<unknown> { return input; }
  async sessions(): Promise<SafeSessionSummary[]> { return []; }
  async revokeSession(): Promise<boolean> { return true; }
  async revokeOthers(): Promise<number> { return 0; }
  async loginByEmail(email: string): Promise<LoginRecord | undefined> { return email === 'player@example.com' ? this.user : undefined; }
  async loginById(id: string): Promise<LoginRecord | undefined> { return id === this.user.id ? { ...this.user, passwordHash: this.password } : undefined; }
  async createToken(kind: TokenKind, userId: string, tokenHash: string, expiresAt: Date): Promise<void> { this.tokens.set(tokenHash, { kind, userId, used: false, expiresAt }); }
  async consumeToken(kind: TokenKind, tokenHash: string): Promise<string | undefined> {
    const token = this.tokens.get(tokenHash); if (!token || token.kind !== kind || token.used || token.expiresAt <= new Date()) return undefined;
    token.used = true; return token.userId;
  }
  async verifyEmail(): Promise<void> { this.verified = true; }
  async replacePassword(_id: string, passwordHash: string): Promise<void> { this.password = passwordHash; }
  async deleteAccount(): Promise<void> { this.deleted = true; }
}
const passwords = { async hash(value: string) { return `hash:${value}`; }, async verify(hash: string, value: string) { return hash === `hash:${value}`; } };

void test('password reset tokens are one-time and replace the password', async () => {
  const store = new MemoryAccounts(); const service = new AccountService(store, passwords);
  const token = await service.requestReset('player@example.com'); assert.ok(token);
  assert.equal(await service.completeReset(token, 'new-password'), true);
  assert.equal(store.password, 'hash:new-password');
  assert.equal(await service.completeReset(token, 'another-password'), false);
});

void test('password reset request does not create a token for an unknown account', async () => {
  const store = new MemoryAccounts(); const service = new AccountService(store, passwords);
  assert.equal(await service.requestReset('missing@example.com'), undefined);
});

void test('email verification is idempotently rejected after one use', async () => {
  const store = new MemoryAccounts(); const service = new AccountService(store, passwords);
  const token = await service.requestVerification(store.user.id);
  assert.equal(await service.completeVerification(token), true); assert.equal(store.verified, true);
  assert.equal(await service.completeVerification(token), false);
});

void test('account deletion requires the current password', async () => {
  const store = new MemoryAccounts(); const service = new AccountService(store, passwords);
  assert.equal(await service.deleteAccount(store.user.id, 'wrong'), false); assert.equal(store.deleted, false);
  assert.equal(await service.deleteAccount(store.user.id, 'old-password'), true); assert.equal(store.deleted, true);
});
