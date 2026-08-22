import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_AVATAR_ID, isApprovedAvatarId, resolveAvatarId } from '../server/src/avatars/avatar-registry.js';
import { normalizeDisplayName, validateIdentity } from '../server/src/players/player-identity.js';

void test('avatar IDs are limited to the server-approved registry', () => {
  assert.equal(isApprovedAvatarId('neon-capsule'), true);
  assert.equal(isApprovedAvatarId('extreme-gundam'), true);
  assert.equal(isApprovedAvatarId('origin-gundam'), false);
  assert.equal(isApprovedAvatarId('../../untrusted.glb'), false);
  assert.equal(resolveAvatarId('../../untrusted.glb'), DEFAULT_AVATAR_ID);
  assert.equal(resolveAvatarId('origin-gundam'), DEFAULT_AVATAR_ID);
});

void test('display names are normalized and malformed identities are rejected', () => {
  assert.equal(normalizeDisplayName('  PIXEL   KID  '), 'PIXEL KID');
  assert.equal(normalizeDisplayName('<script>'), undefined);
  assert.equal(normalizeDisplayName('X'), undefined);
  assert.deepEqual(validateIdentity({ displayName: 'Arcade Kid', avatarId: 'not-approved' }), {
    displayName: 'Arcade Kid', avatarId: DEFAULT_AVATAR_ID
  });
  assert.equal(validateIdentity({ displayName: '<bad>', avatarId: 'neon-capsule' }), undefined);
});
