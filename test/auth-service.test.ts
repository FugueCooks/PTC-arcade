import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthService } from '../server/src/auth/auth-service.js';
import type {
  AuthRepository, AuthSessionRecord, LoginRecord, NewGuestIdentity, NewRegisteredIdentity, SafeIdentity
} from '../server/src/auth/auth-repository.js';
import { RequestRateLimiter } from '../server/src/auth/request-rate-limiter.js';

class MemoryAuthRepository implements AuthRepository {
  users = new Map<string, LoginRecord>();
  sessions = new Map<string, AuthSessionRecord & { revoked: boolean }>();
  audits: string[] = [];
  nextId = 1;

  async createRegistered(input: NewRegisteredIdentity): Promise<SafeIdentity | undefined> {
    if (this.users.has(input.normalizedEmail)) return undefined;
    const user: LoginRecord = { id: `user-${this.nextId++}`, type: 'registered', displayName: input.displayName,
      avatarId: input.avatarId, status: 'unverified', passwordHash: input.passwordHash };
    this.users.set(input.normalizedEmail, user); return user;
  }
  async findLogin(normalizedEmail: string): Promise<LoginRecord | undefined> { return this.users.get(normalizedEmail); }
  async createGuest(input: NewGuestIdentity): Promise<SafeIdentity> {
    return { id: `guest-${this.nextId++}`, type: 'guest', displayName: input.displayName, avatarId: input.avatarId, status: 'active' };
  }
  async createSession(identity: SafeIdentity, tokenHash: string, expiresAt: Date): Promise<void> {
    this.sessions.set(tokenHash, { identity, expiresAt, revoked: false });
  }
  async findSession(tokenHash: string, now = new Date()): Promise<AuthSessionRecord | undefined> {
    const value = this.sessions.get(tokenHash);
    return value && !value.revoked && value.expiresAt > now ? value : undefined;
  }
  async revokeSession(tokenHash: string): Promise<boolean> {
    const value = this.sessions.get(tokenHash); if (!value || value.revoked) return false; value.revoked = true; return true;
  }
  async recordAudit(eventType: string): Promise<void> { this.audits.push(eventType); }
}

class PredictablePasswords {
  verifyCalls: string[] = [];
  async hash(password: string): Promise<string> { return `hash:${password}`; }
  async verify(encodedHash: string, password: string): Promise<boolean> {
    this.verifyCalls.push(encodedHash); return encodedHash === `hash:${password}`;
  }
}
class PredictableTokens {
  private next = 1;
  constructor(private readonly ttlMs: number) {}
  issue(now = Date.now()) { const token = `token_${this.next++}_abcdefghijklmnopqrstuvwxyz012345`; return { token, hash: `digest:${token}`, expiresAt: new Date(now + this.ttlMs) }; }
  hash(token: string) { return `digest:${token}`; }
}

function fixture() {
  const repository = new MemoryAuthRepository(); const passwords = new PredictablePasswords();
  const service = new AuthService(repository, passwords, new PredictableTokens(10_000), new PredictableTokens(5_000), 'dummy-hash');
  return { repository, passwords, service };
}

void test('registration creates a durable unverified identity and an opaque session', async () => {
  const { repository, service } = fixture();
  const result = await service.register({ email: 'Player@example.com', normalizedEmail: 'player@example.com', password: 'correct horse battery',
    displayName: 'Player One', normalizedDisplayName: 'player one', avatarId: 'neon-capsule' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.identity.status, 'unverified'); assert.equal(repository.sessions.has(`digest:${result.token}`), true);
  assert.deepEqual(repository.audits, ['account-created']);
});

void test('duplicate registration returns a generic failure without another session', async () => {
  const { repository, service } = fixture(); const input = { email: 'a@example.com', normalizedEmail: 'a@example.com', password: 'long enough password',
    displayName: 'Player', normalizedDisplayName: 'player', avatarId: 'neon-capsule' };
  assert.equal((await service.register(input)).ok, true); const count = repository.sessions.size;
  assert.deepEqual(await service.register(input), { ok: false, reason: 'account-exists' });
  assert.equal(repository.sessions.size, count);
});

void test('failed login performs dummy password verification and does not reveal the account', async () => {
  const { passwords, service } = fixture();
  assert.deepEqual(await service.login({ normalizedEmail: 'missing@example.com', password: 'wrong' }), { ok: false, reason: 'invalid-credentials' });
  assert.deepEqual(passwords.verifyCalls, ['dummy-hash']);
});

void test('guest sessions resolve and logout revokes them idempotently', async () => {
  const { service } = fixture();
  const created = await service.createGuest({ displayName: 'Guest', normalizedDisplayName: 'guest', avatarId: 'neon-capsule' });
  assert.equal(created.ok, true); if (!created.ok) return;
  assert.equal((await service.session(created.token))?.identity.type, 'guest');
  await service.logout(created.token); await service.logout(created.token);
  assert.equal(await service.session(created.token), undefined);
});

void test('authentication limiter bounds requests and resets after its window', () => {
  const limiter = new RequestRateLimiter(2, 1_000);
  assert.equal(limiter.consume('client', 0).allowed, true);
  assert.equal(limiter.consume('client', 1).allowed, true);
  assert.equal(limiter.consume('client', 2).allowed, false);
  assert.equal(limiter.consume('client', 1_001).allowed, true);
});
