import type { SafeIdentity } from './auth-repository.js';
import { DEFAULT_AVATAR_ID, isApprovedAvatarId } from '../avatars/avatar-registry.js';

export const DEFAULT_GUEST_AVATAR_ID = DEFAULT_AVATAR_ID;

export interface IdentityEntitlements {
  accountAuthenticated: boolean;
  canChooseCustomAvatar: boolean;
  canClaimPersistentDisplayName: boolean;
  canPersistPreferences: boolean;
  canPersistProgress: boolean;
  canPersistGameSaves: boolean;
}

export function entitlementsFor(identity: Pick<SafeIdentity, 'type' | 'walletAuthenticated'>): IdentityEntitlements {
  // Keeping anything follows having an account, not how the account was
  // proved. This used to require a wallet signature, which was the only proof
  // available while wallets were the only way to make an account; a username
  // and a password prove the same thing. Left as it was, every account made
  // through the new form would have been a registered identity that could save
  // nothing: no name, no preferences, no progress, no game saves.
  const accountAuthenticated = identity.type === 'registered';
  return { accountAuthenticated, canChooseCustomAvatar: true,
    canClaimPersistentDisplayName: accountAuthenticated, canPersistPreferences: accountAuthenticated,
    canPersistProgress: accountAuthenticated, canPersistGameSaves: accountAuthenticated };
}

export function authoritativeAvatarId(identity: Pick<SafeIdentity, 'type' | 'walletAuthenticated'>, requested: unknown): string {
  return entitlementsFor(identity).canChooseCustomAvatar && isApprovedAvatarId(requested) ? requested : DEFAULT_GUEST_AVATAR_ID;
}
