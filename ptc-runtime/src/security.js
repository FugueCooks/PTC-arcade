import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ALLOWED_ORIGINS, PROTOCOL_VERSION } from '../../emulators/ptc-runtime/protocol.js';

/**
 * The runtime's gatekeeping.
 *
 * A local service that starts native processes on request is the sharpest edge
 * in this project. Every web page the player visits can reach 127.0.0.1, so
 * "only our site talks to it" has to be enforced here rather than assumed. Four
 * things stand between a hostile page and a launched process:
 *
 *   1. The socket binds loopback only, so nothing off-machine can reach it.
 *   2. The Origin must be one this runtime serves. A page from anywhere else is
 *      refused before its body is read.
 *   3. Pairing requires a code displayed by the runtime's own window and typed
 *      into the page, so a background page cannot pair silently.
 *   4. Every launch carries the paired token, compared in constant time.
 *
 * None of these is sufficient alone. A browser can be made to send any Origin
 * from a non-browser client, which is what the token covers; a token can leak
 * from site storage, which is what the origin check narrows.
 */

/** Refuses any origin not explicitly served. No wildcards, no suffix matching. */
export function isAllowedOrigin(origin, allowed = ALLOWED_ORIGINS) {
  if (typeof origin !== 'string' || origin === '') return false;
  return allowed.includes(origin);
}

/**
 * A request the runtime will consider. Returns a reason rather than a boolean
 * so the caller can answer 403 with something the player can act on.
 */
export function checkRequest(request, { allowedOrigins = ALLOWED_ORIGINS } = {}) {
  const origin = request.headers?.origin;
  if (!isAllowedOrigin(origin, allowedOrigins)) return { ok: false, reason: 'origin-refused' };
  // A browser fetch from our own page always sends this; its absence means the
  // caller is not the page it claims to be.
  if (request.headers?.['sec-fetch-site'] === 'cross-site') return { ok: false, reason: 'cross-site' };
  return { ok: true, origin };
}

/**
 * Pairing code shown in the runtime's own window.
 *
 * Digits only and short enough to retype, because a player reads it off one
 * window and types it into another. The security does not rest on its entropy:
 * it rests on the code being visible only to someone at the machine, and on it
 * expiring. A hostile page cannot see the runtime's window.
 */
export function createPairingCode(now = Date.now(), ttlMs = 120_000) {
  const digits = randomBytes(4).readUInt32BE(0) % 1_000_000;
  return {
    code: String(digits).padStart(6, '0'),
    expiresAt: now + ttlMs,
    attemptsRemaining: 5
  };
}

/**
 * One pairing attempt. Wrong codes burn an attempt so the six digits cannot be
 * walked through, and an expired code is refused regardless.
 */
export function verifyPairingCode(pairing, submitted, now = Date.now()) {
  if (!pairing) return { ok: false, reason: 'no-pairing-in-progress', pairing };
  if (now >= pairing.expiresAt) return { ok: false, reason: 'expired', pairing: null };
  if (pairing.attemptsRemaining <= 0) return { ok: false, reason: 'too-many-attempts', pairing: null };

  const expected = Buffer.from(pairing.code, 'utf8');
  const actual = Buffer.from(typeof submitted === 'string' ? submitted : '', 'utf8');
  const matched = expected.length === actual.length && timingSafeEqual(expected, actual);
  if (!matched) {
    const remaining = pairing.attemptsRemaining - 1;
    return {
      ok: false,
      reason: remaining > 0 ? 'code-mismatch' : 'too-many-attempts',
      pairing: remaining > 0 ? { ...pairing, attemptsRemaining: remaining } : null
    };
  }
  return { ok: true, pairing: null };
}

/**
 * The token a paired page presents afterwards. Derived from a per-install
 * secret so the stored token is verifiable without keeping a list, and bound to
 * the origin so a token leaked from one site is useless from another.
 */
export function issueToken(installSecret, origin, now = Date.now()) {
  const issuedAt = String(now);
  const nonce = randomBytes(16).toString('hex');
  const signature = sign(installSecret, `${origin}.${issuedAt}.${nonce}`);
  return `${issuedAt}.${nonce}.${signature}`;
}

export function verifyToken(installSecret, origin, token, now = Date.now(), maxAgeMs = 180 * 24 * 60 * 60 * 1_000) {
  if (typeof token !== 'string') return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [issuedAt, nonce, signature] = parts;
  if (!/^\d{1,15}$/.test(issuedAt) || !/^[0-9a-f]{32}$/.test(nonce)) return { ok: false, reason: 'malformed' };

  const expected = sign(installSecret, `${origin}.${issuedAt}.${nonce}`);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'bad-signature' };

  const age = now - Number(issuedAt);
  // A clock that moved backwards is not a reason to accept a token forever.
  if (age < -60_000) return { ok: false, reason: 'issued-in-future' };
  if (age > maxAgeMs) return { ok: false, reason: 'expired' };
  return { ok: true };
}

function sign(secret, payload) {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/** Per-install secret. Generated once and kept with the runtime's own config. */
export function createInstallSecret() {
  return randomBytes(32).toString('hex');
}

/**
 * The version check. A page speaking a different major version is refused
 * rather than served on a best guess: the disagreement would surface as a
 * native process started with arguments the page did not intend.
 */
export function checkProtocolVersion(claimed) {
  if (claimed === PROTOCOL_VERSION) return { ok: true };
  return { ok: false, reason: 'protocol-mismatch', expected: PROTOCOL_VERSION, claimed: claimed ?? null };
}
