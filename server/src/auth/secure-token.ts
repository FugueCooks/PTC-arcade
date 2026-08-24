import { createHash, randomBytes } from 'node:crypto';

export interface SecureToken { token: string; hash: string }

/** Creates 256 bits of entropy. Only the SHA-256 digest may be persisted. */
export function createSecureToken(): SecureToken {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashSecureToken(token) };
}

export function hashSecureToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
