import type { SafeIdentity } from './auth-repository.js';
import { DEFAULT_AVATAR_ID, isApprovedAvatarId } from '../avatars/avatar-registry.js';

export const DEFAULT_GUEST_AVATAR_ID = DEFAULT_AVATAR_ID;

export interface IdentityEntitlements {
  walletAuthenticated: boolean;
  canChooseCustomAvatar: boolean;
  canClaimPersistentDisplayName: boolean;
  canPersistPreferences: boolean;
  canPersistProgress: boolean;
}

export function entitlementsFor(identity: Pick<SafeIdentity, 'type' | 'walletAuthenticated'>): IdentityEntitlements {
  const walletAuthenticated = identity.type === 'registered' && identity.walletAuthenticated === true;
  return { walletAuthenticated, canChooseCustomAvatar: walletAuthenticated,
    canClaimPersistentDisplayName: walletAuthenticated, canPersistPreferences: walletAuthenticated,
    canPersistProgress: walletAuthenticated };
}

export function authoritativeAvatarId(identity: Pick<SafeIdentity, 'type' | 'walletAuthenticated'>, requested: unknown): string {
  return entitlementsFor(identity).canChooseCustomAvatar && isApprovedAvatarId(requested) ? requested : DEFAULT_GUEST_AVATAR_ID;
}
