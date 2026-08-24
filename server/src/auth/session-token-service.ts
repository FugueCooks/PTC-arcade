import { createSecureToken, hashSecureToken, type SecureToken } from './secure-token.js';

export interface IssuedSessionToken extends SecureToken { expiresAt: Date }

export class SessionTokenService {
  constructor(private readonly ttlMs: number) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error('Session TTL must be a positive integer.');
  }

  issue(now = Date.now()): IssuedSessionToken {
    return { ...createSecureToken(), expiresAt: new Date(now + this.ttlMs) };
  }

  hash(token: string): string { return hashSecureToken(token); }
}
