import assert from 'node:assert/strict';
import test from 'node:test';
import { AccountService, type AccountStore } from '../server/src/auth/account-service.js';
import type { LoginRecord, SafeIdentity } from '../server/src/auth/auth-repository.js';
import type { PreferenceUpdate, SafeSessionSummary } from '../server/src/auth/account-repository.js';

class MemoryAccounts implements AccountStore {
  user: LoginRecord = { id: 'user-1', type: 'registered', displayName: 'PLAYER', avatarId: 'neon-capsule', status: 'active', passwordHash: 'hash:old-password' };
  password = this.user.passwordHash; deleted = false;
  async updateProfile(_id: string, input: { displayName: string; avatarId: string }): Promise<SafeIdentity> { return { ...this.user, ...input }; }
  async preferences(): Promise<unknown> { return {}; }
  async updatePreferences(_id: string, input: PreferenceUpdate): Promise<unknown> { return input; }
  async sessions(): Promise<SafeSessionSummary[]> { return []; }
  async revokeSession(): Promise<boolean> { return true; }
  async revokeOthers(): Promise<number> { return 0; }
  async loginById(id: string): Promise<LoginRecord | undefined> { return id === this.user.id ? { ...this.user, passwordHash: this.password } : undefined; }
  async deleteAccount(): Promise<void> { this.deleted = true; }
  async recordAudit(): Promise<void> {}
}
const passwords = { async hash(value: string) { return `hash:${value}`; }, async verify(hash: string, value: string) { return hash === `hash:${value}`; } };

void test('account deletion requires the current password', async () => {
  const store = new MemoryAccounts(); const service = new AccountService(store, passwords);
  assert.equal(await service.deleteAccount(store.user.id, 'wrong'), false); assert.equal(store.deleted, false);
  assert.equal(await service.deleteAccount(store.user.id, 'old-password'), true); assert.equal(store.deleted, true);
});
