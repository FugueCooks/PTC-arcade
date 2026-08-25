import { z } from 'zod';
import { normalizeDisplayName } from '../players/player-identity.js';
import { isApprovedAvatarId, resolveAvatarId } from '../avatars/avatar-registry.js';

const usernameSchema = z.string().trim().min(2).max(18).regex(/^[A-Za-z0-9_.-]+$/);
const passwordSchema = z.string().min(8).max(128);

export const registrationSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  avatarId: z.unknown()
}).strict().transform((input, context) => {
  const displayName = normalizeDisplayName(input.username);
  if (!displayName) {
    context.addIssue({ code: 'custom', path: ['displayName'], message: 'Invalid display name.' });
    return z.NEVER;
  }
  return {
    username: displayName,
    normalizedUsername: normalizeUsername(displayName),
    password: input.password,
    displayName,
    normalizedDisplayName: displayName.toLocaleLowerCase('en-US'),
    avatarId: resolveAvatarId(input.avatarId)
  };
});

export const loginSchema = z.object({ username: usernameSchema, password: z.string().min(1).max(128) }).strict()
  .transform((input) => ({ ...input, normalizedUsername: normalizeUsername(input.username) }));

export const guestIdentitySchema = z.object({}).strict();

export const profileUpdateSchema = z.object({ displayName: z.unknown(), avatarId: z.unknown() }).strict()
  .transform((input, context) => {
    const displayName = normalizeDisplayName(input.displayName);
    if (!displayName) {
      context.addIssue({ code: 'custom', path: ['displayName'], message: 'Invalid display name.' });
      return z.NEVER;
    }
    if (!isApprovedAvatarId(input.avatarId)) {
      context.addIssue({ code: 'custom', path: ['avatarId'], message: 'Avatar is not approved.' });
      return z.NEVER;
    }
    return { displayName, normalizedDisplayName: displayName.toLocaleLowerCase('en-US'), avatarId: input.avatarId };
  });

const volume = z.number().min(0).max(1);
export const preferencesUpdateSchema = z.object({
  masterVolume: volume.optional(), musicVolume: volume.optional(), effectsVolume: volume.optional(),
  mouseSensitivity: z.number().min(0.1).max(4).optional(), reducedMotion: z.boolean().optional(),
  graphicsPreset: z.enum(['low', 'medium', 'high', 'auto']).optional(), showNameplates: z.boolean().optional(),
  chatVisibility: z.enum(['visible', 'hidden']).optional()
}).strict().refine((value) => Object.keys(value).length > 0, 'At least one preference is required.');

export const accountDeletionSchema = z.union([
  z.object({ confirmation: z.literal('DELETE') }).strict(),
  z.object({ password: z.string().min(1).max(128) }).strict()
]);

export const walletChallengeSchema = z.object({ walletAddress: z.string().min(32).max(64) }).strict();
const base64Bytes = z.string().min(1).max(3_000).regex(/^[A-Za-z0-9+/=_-]+$/);
export const walletVerificationSchema = z.object({
  challengeId: z.string().uuid(),
  output: z.object({
    account: z.object({ address: z.string().min(32).max(64), publicKey: base64Bytes }).strict(),
    signedMessage: base64Bytes,
    signature: base64Bytes,
    signatureType: z.literal('ed25519').optional()
  }).strict()
}).strict();

export function normalizeUsername(username: string): string {
  return username.normalize('NFKC').trim().toLocaleLowerCase('en-US');
}
