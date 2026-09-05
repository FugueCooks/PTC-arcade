import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { PasswordHasher } from '../server/src/auth/password-hasher.js';
import { createSecureToken, hashSecureToken } from '../server/src/auth/secure-token.js';
import { SessionTokenService } from '../server/src/auth/session-token-service.js';
import { loginSchema, normalizeUsername, registrationSchema } from '../server/src/auth/validation.js';

void test('registration validation normalizes identity and resolves only approved avatars', () => {
  const parsed = registrationSchema.parse({
    username: 'Player_One', password: 'correct horse battery staple', avatarId: 'not-approved'
  });
  assert.equal(parsed.normalizedUsername, 'player_one');
  assert.equal(parsed.displayName, 'Player_One');
  assert.equal(parsed.avatarId, 'vled');
  assert.equal(normalizeUsername('USER_Name'), 'user_name');
  assert.equal(loginSchema.parse({ username: ' USER_Name ', password: 'anything' }).normalizedUsername, 'user_name');
});

void test('registration rejects malformed usernames, weak passwords, and extra fields', () => {
  const valid = { username: 'Player_One', password: 'correct horse battery staple', avatarId: 'neon-capsule' };
  assert.equal(registrationSchema.safeParse({ ...valid, username: 'not allowed' }).success, false);
  assert.equal(registrationSchema.safeParse({ ...valid, password: 'short' }).success, false);
  assert.equal(registrationSchema.safeParse({ ...valid, password: 'abcdefgh' }).success, true);
  assert.equal(registrationSchema.safeParse({ ...valid, username: '<admin>' }).success, false);
  assert.equal(registrationSchema.safeParse({ ...valid, isAdmin: true }).success, false);
});

void test('Argon2id hashes are salted, verifiable, and never contain the password', async () => {
  const hasher = new PasswordHasher({ memoryCostKib: 7_168, iterations: 1, parallelism: 1 });
  const password = 'correct horse battery staple';
  const first = await hasher.hash(password);
  const second = await hasher.hash(password);
  assert.match(first, /^\$argon2id\$/);
  assert.notEqual(first, second);
  assert.equal(first.includes(password), false);
  assert.equal(await hasher.verify(first, password), true);
  assert.equal(await hasher.verify(first, 'wrong password'), false);
  assert.equal(await hasher.verify('malformed', password), false);
});

void test('opaque session tokens persist only a SHA-256 digest and obey TTL', () => {
  const issued = new SessionTokenService(60_000).issue(1_000);
  assert.equal(issued.token.length >= 40, true);
  assert.match(issued.hash, /^[a-f0-9]{64}$/);
  assert.equal(issued.hash, hashSecureToken(issued.token));
  assert.equal(issued.expiresAt.getTime(), 61_000);
  const another = createSecureToken();
  assert.notEqual(another.token, issued.token);
  assert.notEqual(another.hash, issued.hash);
});

void test('initial migration enforces durable subjects, hashed tokens, and preference bounds', async () => {
  const migration = await readFile(path.resolve(process.cwd(), 'drizzle', '0000_worried_whirlwind.sql'), 'utf8');
  for (const table of ['users', 'guest_identities', 'sessions', 'user_preferences', 'password_reset_tokens', 'email_verification_tokens']) {
    assert.match(migration, new RegExp(`CREATE TABLE "${table}"`));
  }
  assert.match(migration, /sessions_exactly_one_subject/);
  assert.match(migration, /sessions_token_hash_unique/);
  assert.match(migration, /user_preferences_master_volume_range/);
  assert.doesNotMatch(migration, /plaintext_password|session_token"|reset_token"/);
});

void test('username migration safely backfills existing accounts and enforces uniqueness', async () => {
  const migration = await readFile(path.resolve(process.cwd(), 'drizzle', '0001_loose_dracula.sql'), 'utf8');
  assert.match(migration, /ADD COLUMN "username" varchar\(18\)/);
  assert.match(migration, /ranked_users/);
  assert.match(migration, /ALTER COLUMN "username" SET NOT NULL/);
  assert.match(migration, /users_normalized_username_unique/);
});

void test('wallet migration adds stable public identity and one verified wallet per network', async () => {
  const migration = await readFile(path.resolve(process.cwd(), 'drizzle', '0002_cute_black_queen.sql'), 'utf8');
  assert.match(migration, /public_player_id/);
  assert.match(migration, /CREATE TABLE "wallet_identities"/);
  assert.match(migration, /wallet_identities_chain_network_address_unique/);
  assert.match(migration, /ON DELETE cascade/i);
  assert.doesNotMatch(migration, /private_key|seed_phrase|plaintext_signature/);
});
