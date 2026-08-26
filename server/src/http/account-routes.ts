import type { Express, Request, Response } from 'express';
import type { ServerConfig } from '../config.js';
import type { AuthService } from '../auth/auth-service.js';
import type { AccountService } from '../auth/account-service.js';
import type { SafeIdentity } from '../auth/auth-repository.js';
import { readSessionCookie } from '../auth/session-cookie.js';
import { accountDeletionSchema, preferencesUpdateSchema, profileUpdateSchema } from '../auth/validation.js';
import { RequestRateLimiter } from '../auth/request-rate-limiter.js';
import { entitlementsFor } from '../auth/authorization-policy.js';
import { checkCrossSite, crossSiteMessage } from './cross-site.js';
import type { CrossSiteReporter } from './auth-routes.js';

interface Dependencies {
  auth?: AuthService; accounts?: AccountService; databaseReady: () => boolean;
  identityChanged?: (identity: SafeIdentity) => void; accountDeleted?: (identity: SafeIdentity) => void;
  onCrossSiteRejected?: CrossSiteReporter;
}

export function installAccountRoutes(app: Express, config: ServerConfig, dependencies: Dependencies): void {
  const limiter = new RequestRateLimiter(config.authRequestLimit * 2, 10 * 60_000);
  app.use('/api/account', (request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    if (request.method !== 'GET') {
      const verdict = checkCrossSite(request, config.authAllowedOrigin);
      if (verdict.rejected) {
        dependencies.onCrossSiteRejected?.(request, verdict);
        response.status(403).json(error('origin-rejected', crossSiteMessage(verdict))); return;
      }
      const limit = limiter.consume(`${request.ip || 'unknown'}:${request.path}`);
      if (!limit.allowed) {
        response.setHeader('Retry-After', String(Math.ceil(limit.retryAfterMs / 1_000)));
        response.status(429).json(error('rate-limited', 'Too many requests. Please wait and try again.')); return;
      }
    }
    if (!dependencies.auth || !dependencies.accounts || !dependencies.databaseReady()) {
      response.status(503).json(error('account-unavailable', 'Account services are temporarily unavailable.')); return;
    }
    next();
  });

  app.get('/api/account/profile', async (request, response) => {
    const session = await registeredSession(request, config, dependencies.auth!);
    if (!session) return unauthorized(response);
    response.json({ ok: true, identity: session.identity });
  });
  app.put('/api/account/profile', async (request, response) => {
    const session = await registeredSession(request, config, dependencies.auth!);
    if (!session) return unauthorized(response);
    const parsed = profileUpdateSchema.safeParse(request.body); if (!parsed.success) return invalid(response);
    try {
      if (!entitlementsFor(session.identity).canClaimPersistentDisplayName) return unauthorized(response);
      const updated = await dependencies.accounts!.updateProfile(session.identity.id, parsed.data);
      if (!updated) return unauthorized(response);
      const identity = { ...updated, walletAuthenticated: true, walletAddress: session.identity.walletAddress };
      dependencies.identityChanged?.(identity); response.json({ ok: true, identity });
    } catch { unavailable(response); }
  });
  app.get('/api/account/preferences', async (request, response) => {
    const session = await registeredSession(request, config, dependencies.auth!); if (!session || !entitlementsFor(session.identity).canPersistPreferences) return unauthorized(response);
    try { response.json({ ok: true, preferences: await dependencies.accounts!.preferences(session.identity.id) }); } catch { unavailable(response); }
  });
  app.put('/api/account/preferences', async (request, response) => {
    const session = await registeredSession(request, config, dependencies.auth!); if (!session || !entitlementsFor(session.identity).canPersistPreferences) return unauthorized(response);
    const parsed = preferencesUpdateSchema.safeParse(request.body); if (!parsed.success) return invalid(response);
    try { response.json({ ok: true, preferences: await dependencies.accounts!.updatePreferences(session.identity.id, parsed.data) }); } catch { unavailable(response); }
  });
  app.get('/api/account/sessions', async (request, response) => {
    const session = await registeredSession(request, config, dependencies.auth!); if (!session) return unauthorized(response);
    try {
      const sessions = await dependencies.accounts!.sessions(session.identity.id);
      response.json({ ok: true, sessions: sessions.map((value) => ({ ...value, current: value.id === session.sessionId })) });
    } catch { unavailable(response); }
  });
  app.delete('/api/account/sessions/:sessionId', async (request, response) => {
    const session = await registeredSession(request, config, dependencies.auth!); if (!session) return unauthorized(response);
    if (!/^[0-9a-f-]{36}$/i.test(request.params.sessionId)) return invalid(response);
    try { await dependencies.accounts!.revokeSession(session.identity.id, request.params.sessionId); response.status(204).end(); } catch { unavailable(response); }
  });
  app.post('/api/account/sessions/revoke-others', async (request, response) => {
    const session = await registeredSession(request, config, dependencies.auth!); if (!session) return unauthorized(response);
    const token = readSessionCookie(request.get('Cookie'), config.authCookieName); if (!token) return unauthorized(response);
    try { response.json({ ok: true, revoked: await dependencies.accounts!.revokeOthers(session.identity.id, token) }); } catch { unavailable(response); }
  });
  app.delete('/api/account', async (request, response) => {
    const session = await registeredSession(request, config, dependencies.auth!); if (!session) return unauthorized(response);
    const parsed = accountDeletionSchema.safeParse(request.body); if (!parsed.success) return invalid(response);
    try {
      if ('confirmation' in parsed.data) {
        await dependencies.accounts!.deleteWalletAccount(session.identity.id);
      } else if (!config.legacyPasswordAuthEnabled || !await dependencies.accounts!.deleteAccount(session.identity.id, parsed.data.password)) {
        response.status(403).json(error('authentication-failed', 'Account deletion was not accepted.')); return;
      }
      dependencies.accountDeleted?.(session.identity); clearCookie(response, config); response.status(204).end();
    } catch { unavailable(response); }
  });
}

async function registeredSession(request: Request, config: ServerConfig, auth: AuthService) {
  try {
    const session = await auth.session(readSessionCookie(request.get('Cookie'), config.authCookieName));
    return session?.identity.type === 'registered' && session.identity.walletAuthenticated === true ? session : undefined;
  } catch { return undefined; }
}
function clearCookie(response: Response, config: ServerConfig) {
  response.clearCookie(config.authCookieName, { httpOnly: true, secure: config.authCookieSecure, sameSite: 'strict', path: '/' });
}
function error(code: string, message: string) { return { ok: false, error: { code, message } }; }
function unauthorized(response: Response) { response.status(401).json(error('authentication-required', 'Sign in to manage this account.')); }
function invalid(response: Response) { response.status(400).json(error('invalid-request', 'Check the provided account details.')); }
function invalidToken(response: Response) { response.status(400).json(error('invalid-or-expired-token', 'This link is invalid or expired.')); }
function unavailable(response: Response) { response.status(503).json(error('account-unavailable', 'Account services are temporarily unavailable.')); }
