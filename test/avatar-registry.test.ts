import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_AVATAR_ID, isApprovedAvatarId, resolveAvatarId } from '../server/src/avatars/avatar-registry.js';
import { normalizeDisplayName, validateIdentity } from '../server/src/players/player-identity.js';

void test('avatar IDs are limited to the server-approved registry', () => {
  assert.equal(isApprovedAvatarId('neon-capsule'), true);
  assert.equal(isApprovedAvatarId('extreme-gundam'), true);
  assert.equal(isApprovedAvatarId('sora-final'), true);
  assert.equal(isApprovedAvatarId('tung-sahur'), true);
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

void test('Triple T uses its authored walk clip in a compact skinned GLB', async () => {
  const { readFile } = await import('node:fs/promises');
  const registry = JSON.parse(await readFile('assets/avatars/registry.json', 'utf8')) as {
    avatars: Array<{ id: string; name: string; modelUrl: string | null; animations: Record<string, string> }>;
  };
  const avatar = registry.avatars.find((entry) => entry.id === 'tung-sahur');
  assert.equal(avatar?.name, 'Triple T');
  assert.match(avatar?.modelUrl ?? '', /tung-sahur\.optimized\.glb/);
  assert.deepEqual(avatar?.animations, { walk: 'Armature|Walk', run: 'Armature|Walk' });

  const glb = await readFile('assets/avatars/models/tung-sahur.optimized.glb');
  assert.ok(glb.byteLength < 1_000_000, 'the avatar should remain a lightweight lazy-loaded asset');
  assert.equal(glb.readUInt32LE(0), 0x46546c67);
  const jsonLength = glb.readUInt32LE(12);
  const payload = JSON.parse(glb.subarray(20, 20 + jsonLength).toString('utf8').trim()) as {
    animations?: Array<{ name?: string }>;
    skins?: unknown[];
    extensionsRequired?: string[];
  };
  assert.deepEqual(payload.animations?.map((animation) => animation.name), ['Armature|Walk']);
  assert.ok((payload.skins?.length ?? 0) > 0, 'the avatar must retain its skinned rig');
  assert.ok(payload.extensionsRequired?.includes('EXT_texture_webp'), 'the avatar should retain web-optimized textures');

  const selectionUi = await readFile('avatar-selection.js', 'utf8');
  assert.match(selectionUi, /avatar\.id === 'tung-sahur' \? 'Triple T' : avatar\.name/);
  assert.match(selectionUi, /card\.textContent = avatarDisplayName\(avatar\)/);
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
