import { z } from 'zod';
import { normalizeDisplayName } from '../players/player-identity.js';
import { resolveAvatarId } from '../avatars/avatar-registry.js';

const emailSchema = z.string().trim().max(320).email();
const passwordSchema = z.string().min(12).max(128).refine((password) => new Set(password).size >= 6, 'Password is too repetitive.');

export const registrationSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: z.unknown(),
  avatarId: z.unknown()
}).strict().transform((input, context) => {
  const displayName = normalizeDisplayName(input.displayName);
  if (!displayName) {
    context.addIssue({ code: 'custom', path: ['displayName'], message: 'Invalid display name.' });
    return z.NEVER;
  }
  return {
    email: input.email,
    normalizedEmail: normalizeEmail(input.email),
    password: input.password,
    displayName,
    normalizedDisplayName: displayName.toLocaleLowerCase('en-US'),
    avatarId: resolveAvatarId(input.avatarId)
  };
});

export const loginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(128) }).strict()
  .transform((input) => ({ ...input, normalizedEmail: normalizeEmail(input.email) }));

export const guestIdentitySchema = z.object({
  displayName: z.unknown(),
  avatarId: z.unknown()
}).strict().transform((input, context) => {
  const displayName = normalizeDisplayName(input.displayName);
  if (!displayName) {
    context.addIssue({ code: 'custom', path: ['displayName'], message: 'Invalid display name.' });
    return z.NEVER;
  }
  return {
    displayName,
    normalizedDisplayName: displayName.toLocaleLowerCase('en-US'),
    avatarId: resolveAvatarId(input.avatarId)
  };
});

export const profileUpdateSchema = z.object({ displayName: z.unknown(), avatarId: z.unknown() }).strict()
  .transform((input, context) => {
    const displayName = normalizeDisplayName(input.displayName);
    if (!displayName) {
      context.addIssue({ code: 'custom', path: ['displayName'], message: 'Invalid display name.' });
      return z.NEVER;
    }
    return { displayName, normalizedDisplayName: displayName.toLocaleLowerCase('en-US'), avatarId: resolveAvatarId(input.avatarId) };
  });

const volume = z.number().min(0).max(1);
export const preferencesUpdateSchema = z.object({
  masterVolume: volume.optional(), musicVolume: volume.optional(), effectsVolume: volume.optional(),
  mouseSensitivity: z.number().min(0.1).max(4).optional(), reducedMotion: z.boolean().optional(),
  graphicsPreset: z.enum(['low', 'medium', 'high', 'auto']).optional(), showNameplates: z.boolean().optional(),
  chatVisibility: z.enum(['visible', 'hidden']).optional()
}).strict().refine((value) => Object.keys(value).length > 0, 'At least one preference is required.');

export const resetRequestSchema = z.object({ email: emailSchema }).strict()
  .transform((input) => ({ normalizedEmail: normalizeEmail(input.email) }));
export const resetCompleteSchema = z.object({ token: z.string().min(32).max(256), password: passwordSchema }).strict();
export const verificationCompleteSchema = z.object({ token: z.string().min(32).max(256) }).strict();
export const accountDeletionSchema = z.object({ password: z.string().min(1).max(128) }).strict();

export function normalizeEmail(email: string): string {
  return email.normalize('NFKC').trim().toLocaleLowerCase('en-US');
}
