import type { Express, Request, Response } from 'express';
import type { ServerConfig } from '../config.js';
import type { WalletChallengeService } from '../auth/wallet-challenge-service.js';
import type { WalletAuthService } from '../auth/wallet-auth-service.js';
import { walletChallengeSchema, walletVerificationSchema } from '../auth/validation.js';
import { InMemoryAsyncRateLimiter, type AsyncRateLimiter } from '../auth/distributed-rate-limiter.js';

interface Dependencies {
  challenges?: WalletChallengeService;
  walletAuth?: WalletAuthService;
  challengeLimiter?: AsyncRateLimiter;
  verificationLimiter?: AsyncRateLimiter;
  ready: () => boolean;
}

export function installWalletAuthRoutes(app: Express, config: ServerConfig, dependencies: Dependencies): void {
  const challenges = dependencies.challengeLimiter
    ?? new InMemoryAsyncRateLimiter(Math.max(5, Math.floor(config.authRequestLimit / 2)), 10 * 60_000);
  const verifications = dependencies.verificationLimiter
    ?? new InMemoryAsyncRateLimiter(config.authRequestLimit, 10 * 60_000);

  app.post('/api/auth/wallet/challenge', async (request, response) => {
    if (!available(response, config, dependencies)) return;
    let limit;
    try { limit = await challenges.consume(`${request.ip || 'unknown'}:challenge`); }
    catch { return unavailable(response); }
    if (!limit.allowed) return rateLimited(response, limit.retryAfterMs);
    const parsed = walletChallengeSchema.safeParse(request.body);
    if (!parsed.success) return invalid(response);
    try {
      const challenge = await dependencies.challenges!.create(parsed.data.walletAddress, requestOrigin(request, config));
      if (!challenge) return invalid(response);
      response.status(201).json({ ok: true, ...challenge });
    } catch { unavailable(response); }
  });

  app.post('/api/auth/wallet/verify', async (request, response) => {
    if (!available(response, config, dependencies)) return;
    let limit;
    try { limit = await verifications.consume(`${request.ip || 'unknown'}:verify`); }
    catch { return unavailable(response); }
    if (!limit.allowed) return rateLimited(response, limit.retryAfterMs);
    const parsed = walletVerificationSchema.safeParse(request.body);
    if (!parsed.success) return invalid(response);
    try {
      const result = await dependencies.walletAuth!.authenticate(parsed.data.challengeId, parsed.data.output,
        requestOrigin(request, config), deviceType(request));
      if (!result.ok) {
        response.status(result.reason === 'account-unavailable' ? 403 : 401)
          .json({ ok: false, error: { code: result.reason, message: 'Wallet authentication was not accepted. Request a new challenge and try again.' } });
        return;
      }
      response.cookie(config.authCookieName, result.token, { httpOnly: true, secure: config.authCookieSecure,
        sameSite: 'strict', path: '/', expires: result.expiresAt });
      response.json({ ok: true, identity: result.identity, created: result.created, expiresAt: result.expiresAt.toISOString() });
    } catch { unavailable(response); }
  });
}

function available(response: Response, config: ServerConfig, dependencies: Dependencies): boolean {
  if (!config.walletAuthEnabled || !dependencies.challenges || !dependencies.walletAuth || !dependencies.ready()) {
    response.status(503).json({ ok: false, error: { code: 'wallet-auth-unavailable', message: 'Wallet sign-in is temporarily unavailable.' } }); return false;
  }
  return true;
}
function requestOrigin(request: Request, config: ServerConfig): string {
  const value = request.get('Origin') ?? config.authAllowedOrigin ?? `${request.protocol}://${request.get('host')}`;
  try { return new URL(value).origin; } catch { return ''; }
}
function deviceType(request: Request): string { return request.get('Sec-CH-UA-Mobile') === '?1' ? 'mobile' : 'browser'; }
function invalid(response: Response): void { response.status(400).json({ ok: false, error: { code: 'invalid-request', message: 'The wallet request was invalid.' } }); }
function unavailable(response: Response): void { response.status(503).json({ ok: false, error: { code: 'wallet-auth-unavailable', message: 'Wallet sign-in is temporarily unavailable.' } }); }
function rateLimited(response: Response, retryAfterMs: number): void {
  response.setHeader('Retry-After', String(Math.ceil(retryAfterMs / 1_000)));
  response.status(429).json({ ok: false, error: { code: 'rate-limited', message: 'Too many wallet requests. Please wait and try again.' } });
}
