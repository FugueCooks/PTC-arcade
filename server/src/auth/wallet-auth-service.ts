import type { SafeIdentity } from './auth-repository.js';
import type { WalletChallengeService } from './wallet-challenge-service.js';
import type { SerializedSignInOutput } from './wallet-signature-verifier.js';
import type { WalletAccountStore } from './wallet-account-repository.js';

interface SessionIssuer {
  issue(now?: number): { token: string; hash: string; expiresAt: Date };
}
interface SessionStore {
  createSession(identity: SafeIdentity, tokenHash: string, expiresAt: Date, deviceType?: string): Promise<void>;
  recordAudit(eventType: string, userId?: string): Promise<void>;
}

export type WalletAuthResult = { ok: true; identity: SafeIdentity; token: string; expiresAt: Date; created: boolean }
  | { ok: false; reason: 'invalid-or-expired-challenge' | 'account-unavailable' };

export class WalletAuthService {
  constructor(private readonly challenges: WalletChallengeService, private readonly accounts: WalletAccountStore,
    private readonly sessions: SessionIssuer, private readonly sessionStore: SessionStore, private readonly network: string) {}

  async authenticate(challengeId: string, output: SerializedSignInOutput, origin: string, deviceType?: string): Promise<WalletAuthResult> {
    const challenge = await this.challenges.verify(challengeId, output, origin);
    if (!challenge) return { ok: false, reason: 'invalid-or-expired-challenge' };
    const account = await this.accounts.findOrCreate(this.network, challenge.walletAddress);
    if (!['active', 'unverified'].includes(account.identity.status)) return { ok: false, reason: 'account-unavailable' };
    const issued = this.sessions.issue();
    await this.sessionStore.createSession(account.identity, issued.hash, issued.expiresAt, deviceType);
    try { await this.sessionStore.recordAudit(account.created ? 'wallet-account-created' : 'wallet-login-succeeded', account.identity.id); } catch { /* bounded audit failure */ }
    return { ok: true, identity: account.identity, token: issued.token, expiresAt: issued.expiresAt, created: account.created };
  }
}
