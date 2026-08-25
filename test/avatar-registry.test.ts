import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_AVATAR_ID, isApprovedAvatarId, resolveAvatarId } from '../server/src/avatars/avatar-registry.js';
import { normalizeDisplayName, validateIdentity } from '../server/src/players/player-identity.js';

void test('avatar IDs are limited to the server-approved registry', () => {
  assert.equal(isApprovedAvatarId('neon-capsule'), true);
  assert.equal(isApprovedAvatarId('extreme-gundam'), true);
  assert.equal(isApprovedAvatarId('sora-final'), true);
  assert.equal(isApprovedAvatarId('origin-gundam'), false);
  assert.equal(isApprovedAvatarId('../../untrusted.glb'), false);
  assert.equal(resolveAvatarId('../../untrusted.glb'), DEFAULT_AVATAR_ID);
  assert.equal(resolveAvatarId('origin-gundam'), DEFAULT_AVATAR_ID);
});

void test('Sora Final uses only the approved authored idle and movement clips', async () => {
  const { readFile } = await import('node:fs/promises');
  const registry = JSON.parse(await readFile('assets/avatars/registry.json', 'utf8')) as {
    avatars: Array<{ id: string; name: string; modelUrl: string | null; heightOffset: number; animations: Record<string, string> }>;
  };
  const sora = registry.avatars.find((avatar) => avatar.id === 'sora-final');
  assert.equal(sora?.name, 'Sora (Final)');
  assert.match(sora?.modelUrl ?? '', /sora-final\.optimized\.glb/);
  assert.ok((sora?.heightOffset ?? 0) >= 0.7, 'Sora must remain raised above the floor during authored poses');
  assert.deepEqual(sora?.animations, { idle: 'Idle 3', walk: 'Glide', run: 'Glide' });

  const glb = await readFile('assets/avatars/models/sora-final.optimized.glb');
  assert.ok(glb.byteLength < 8_000_000, 'the production avatar must remain a reasonably small lazy-loaded asset');
  assert.equal(glb.readUInt32LE(0), 0x46546c67);
  const jsonLength = glb.readUInt32LE(12);
  const payload = JSON.parse(glb.subarray(20, 20 + jsonLength).toString('utf8').trim()) as {
    animations?: Array<{ name?: string }>;
    skins?: unknown[];
  };
  assert.deepEqual(payload.animations?.map((animation) => animation.name), ['Glide', 'Idle 3']);
  assert.equal(payload.skins?.length, 1);
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
