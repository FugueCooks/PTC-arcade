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

export function normalizeEmail(email: string): string {
  return email.normalize('NFKC').trim().toLocaleLowerCase('en-US');
}
