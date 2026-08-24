import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { RealtimeTicketService, stablePublicPlayerId } from '../server/src/auth/realtime-ticket.js';
import type { SafeIdentity } from '../server/src/auth/auth-repository.js';

const identity: SafeIdentity = {
  id: '5fcd8b4d-335f-48b0-9515-a7383515d9be', type: 'registered', displayName: 'Player One',
  avatarId: 'neon-capsule', status: 'active'
};

void test('realtime tickets carry only signed public identity and expire quickly', () => {
  const secret = 'test-secret-that-is-long-enough-for-hmac-signing';
  const issued = new RealtimeTicketService(secret, 30_000).issue(identity, 1_000);
  const [encoded, signature] = issued.ticket.split('.');
  assert.equal(signature, createHmac('sha256', secret).update(encoded).digest('base64url'));
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>;
  assert.equal(payload.pid, stablePublicPlayerId(identity));
  assert.equal(payload.n, 'Player One');
  assert.equal(payload.a, 'neon-capsule');
  assert.equal(payload.exp, 31_000);
  assert.equal(payload.id, undefined);
  assert.equal(payload.email, undefined);
});

void test('realtime ticket secrets must have sufficient entropy length', () => {
  assert.throws(() => new RealtimeTicketService('short'), /at least 32 characters/);
});
