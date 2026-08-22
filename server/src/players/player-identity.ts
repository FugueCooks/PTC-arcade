import { resolveAvatarId } from '../avatars/avatar-registry.js';

export const DISPLAY_NAME_MAX_LENGTH = 18;
const displayNamePattern = /^[A-Za-z0-9 ._-]+$/;

export interface PlayerIdentityInput {
  displayName?: unknown;
  avatarId?: unknown;
}

export interface PlayerIdentity {
  displayName: string;
  avatarId: string;
}

export function normalizeDisplayName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (normalized.length < 2 || normalized.length > DISPLAY_NAME_MAX_LENGTH || !displayNamePattern.test(normalized)) return undefined;
  return normalized;
}

export function validateIdentity(input: PlayerIdentityInput | undefined): PlayerIdentity | undefined {
  const displayName = normalizeDisplayName(input?.displayName);
  return displayName ? { displayName, avatarId: resolveAvatarId(input?.avatarId) } : undefined;
}
