import type { Express, NextFunction, Request, Response } from 'express';
import type { ServerConfig } from '../config.js';
import type { AuthService } from '../auth/auth-service.js';
import { guestIdentitySchema, loginSchema, registrationSchema } from '../auth/validation.js';
import { RequestRateLimiter } from '../auth/request-rate-limiter.js';

interface RouteDependencies { service?: AuthService; databaseReady: () => boolean }

export function installAuthRoutes(app: Express, config: ServerConfig, dependencies: RouteDependencies): void {
  const limiter = new RequestRateLimiter(config.authRequestLimit, 10 * 60_000);
  app.use('/api/auth', noStore, (request, response, next) => rejectCrossSiteMutation(request, response, next, config.authAllowedOrigin), (request, response, next) => {
    if (!dependencies.service || !dependencies.databaseReady()) {
      response.status(503).json({ ok: false, error: { code: 'auth-unavailable', message: 'Account services are temporarily unavailable.' } });
      return;
    }
    if (request.method !== 'GET') {
      const result = limiter.consume(`${request.ip || 'unknown'}:${request.path}`);
      if (!result.allowed) {
        response.setHeader('Retry-After', String(Math.ceil(result.retryAfterMs / 1_000)));
        response.status(429).json({ ok: false, error: { code: 'rate-limited', message: 'Too many requests. Please wait and try again.' } });
        return;
      }
    }
    next();
  });

  app.post('/api/auth/register', async (request, response) => {
    const parsed = registrationSchema.safeParse(request.body);
    if (!parsed.success) return validationError(response);
    try {
      const result = await dependencies.service!.register({ ...parsed.data, deviceType: deviceType(request) });
      if (!result.ok) {
        response.status(400).json({ ok: false, error: { code: 'unable-to-create-account', message: 'The account could not be created with those details.' } });
        return;
      }
      setSessionCookie(response, request, config, result.token, result.expiresAt);
      response.status(201).json({ ok: true, identity: result.identity, expiresAt: result.expiresAt.toISOString() });
    } catch { unavailable(response); }
  });

  app.post('/api/auth/login', async (request, response) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return validationError(response);
    try {
      const result = await dependencies.service!.login({ ...parsed.data, deviceType: deviceType(request) });
      if (!result.ok) {
        response.status(401).json({ ok: false, error: { code: 'invalid-credentials', message: 'The email or password was not accepted.' } });
        return;
      }
      setSessionCookie(response, request, config, result.token, result.expiresAt);
      response.json({ ok: true, identity: result.identity, expiresAt: result.expiresAt.toISOString() });
    } catch { unavailable(response); }
  });

  app.post('/api/auth/guest', async (request, response) => {
    const parsed = guestIdentitySchema.safeParse(request.body);
    if (!parsed.success) return validationError(response);
    try {
      const result = await dependencies.service!.createGuest({ ...parsed.data, deviceType: deviceType(request) });
      if (!result.ok) return unavailable(response);
      setSessionCookie(response, request, config, result.token, result.expiresAt);
      response.status(201).json({ ok: true, identity: result.identity, expiresAt: result.expiresAt.toISOString() });
    } catch { unavailable(response); }
  });

  app.get('/api/auth/session', async (request, response) => {
    try {
      const session = await dependencies.service!.session(readCookie(request, config.authCookieName));
      if (!session) {
        response.status(401).json({ ok: false, error: { code: 'session-required', message: 'Sign in or continue as a guest.' } });
        return;
      }
      response.json({ ok: true, identity: session.identity, expiresAt: session.expiresAt.toISOString() });
    } catch { unavailable(response); }
  });

  app.post('/api/auth/logout', async (request, response) => {
    try { await dependencies.service!.logout(readCookie(request, config.authCookieName)); } catch { /* Logout remains idempotent. */ }
    clearSessionCookie(response, request, config);
    response.status(204).end();
  });
}

function noStore(_request: Request, response: Response, next: NextFunction): void {
  response.setHeader('Cache-Control', 'no-store'); next();
}
function rejectCrossSiteMutation(request: Request, response: Response, next: NextFunction, allowedOrigin?: string): void {
  if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return next();
  if (request.get('Sec-Fetch-Site') === 'cross-site') {
    response.status(403).json({ ok: false, error: { code: 'origin-rejected', message: 'This request was rejected.' } }); return;
  }
  const origin = request.get('Origin');
  if (origin) {
    try {
      const expected = allowedOrigin ?? `${request.protocol}://${request.get('host')}`;
      if (new URL(origin).origin !== expected) {
        response.status(403).json({ ok: false, error: { code: 'origin-rejected', message: 'This request was rejected.' } }); return;
      }
    } catch {
      response.status(403).json({ ok: false, error: { code: 'origin-rejected', message: 'This request was rejected.' } }); return;
    }
  }
  next();
}
function setSessionCookie(response: Response, request: Request, config: ServerConfig, token: string, expiresAt: Date): void {
  response.cookie(config.authCookieName, token, cookieOptions(request, config, expiresAt));
}
function clearSessionCookie(response: Response, request: Request, config: ServerConfig): void {
  response.clearCookie(config.authCookieName, { ...cookieOptions(request, config), expires: new Date(0), maxAge: 0 });
}
function cookieOptions(_request: Request, config: ServerConfig, expires?: Date) {
  return { httpOnly: true, secure: config.authCookieSecure, sameSite: 'strict' as const, path: '/', expires };
}
function readCookie(request: Request, name: string): string | undefined {
  const header = request.get('Cookie');
  if (!header || header.length > 8_192) return undefined;
  for (const item of header.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
    const value = item.slice(separator + 1).trim();
    return /^[A-Za-z0-9_-]{32,256}$/.test(value) ? value : undefined;
  }
  return undefined;
}
function deviceType(request: Request): string {
  const value = request.get('Sec-CH-UA-Mobile');
  if (value === '?1') return 'mobile';
  return 'browser';
}
function validationError(response: Response): void {
  response.status(400).json({ ok: false, error: { code: 'invalid-request', message: 'Check the provided account details.' } });
}
function unavailable(response: Response): void {
  response.status(503).json({ ok: false, error: { code: 'auth-unavailable', message: 'Account services are temporarily unavailable.' } });
}
