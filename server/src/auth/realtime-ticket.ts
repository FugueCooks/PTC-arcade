import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { SafeIdentity } from './auth-repository.js';
import { DEFAULT_GUEST_AVATAR_ID, entitlementsFor } from './authorization-policy.js';

export interface RealtimeTicketPayload {
  v: 2;
  pid: string;
  n: string;
  a: string;
  mode: 'guest' | 'wallet';
  exp: number;
  nonce: string;
}

export class RealtimeTicketService {
  constructor(private readonly secret: string, private readonly ttlMs = 30_000) {
    if (secret.length < 32) throw new Error('MULTIPLAYER_TICKET_SECRET must contain at least 32 characters.');
  }

  issue(identity: SafeIdentity, now = Date.now()): { ticket: string; expiresAt: Date } {
    const expiresAt = new Date(now + this.ttlMs);
    const walletAuthenticated = entitlementsFor(identity).walletAuthenticated;
    const payload: RealtimeTicketPayload = {
      v: 2,
      pid: stablePublicPlayerId(identity),
      n: identity.displayName,
      a: walletAuthenticated ? identity.avatarId : DEFAULT_GUEST_AVATAR_ID,
      mode: walletAuthenticated ? 'wallet' : 'guest',
      exp: expiresAt.getTime(),
      nonce: randomUUID()
    };
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const signature = createHmac('sha256', this.secret).update(encoded).digest('base64url');
    return { ticket: `${encoded}.${signature}`, expiresAt };
  }
}

export function stablePublicPlayerId(identity: SafeIdentity): string {
  if (identity.publicPlayerId) return `player-${identity.publicPlayerId.replaceAll('-', '').slice(0, 32)}`;
  return `player-${createHash('sha256').update(`${identity.type}:${identity.id}`).digest('hex').slice(0, 32)}`;
}
