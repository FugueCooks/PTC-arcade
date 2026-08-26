import { randomUUID } from 'node:crypto';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { ServerConfig } from '../config.js';
import { readSessionCookie } from '../auth/session-cookie.js';
import { roleAllows, type OperatorAuthService, type OperatorSession } from '../operations/operator-auth.js';
import type { OperationsService } from '../operations/operations-service.js';
import type { OperationsActionExecutor, OperationsActionRegistry } from '../operations/operations-actions.js';
import type { OperationsAuditLog } from '../operations/audit-log.js';
import { asBodyParserError } from './api/middleware/api-context.js';

/**
 * Milestones 11.25 and 11.27 — the operations HTTP surface.
 *
 * Authorization is entirely server-side. Every route below the login endpoint
 * passes through `requireOperator`, which resolves the session from an
 * HttpOnly cookie; nothing is trusted from the client, and there is no
 * role field in any request the client can set.
 *
 * State-changing requests additionally require the CSRF token issued with the
 * session, delivered in a header the browser will not attach cross-origin.
 */
export const OPERATIONS_COOKIE = 'arcade_ops_session';
const CSRF_HEADER = 'x-arcade-ops-csrf';

declare module 'express-serve-static-core' {
  interface Request {
    operatorSession?: OperatorSession;
    operationsRequestId?: string;
  }
}

export interface OperationsRouteDependencies {
  auth: OperatorAuthService;
  operations: OperationsService;
  actions: OperationsActionRegistry;
  executor: OperationsActionExecutor;
  audit: OperationsAuditLog;
  metrics?: { increment(name: string, amount?: number): void };
}

export function installOperationsRoutes(
  app: Express,
  config: ServerConfig,
  dependencies: OperationsRouteDependencies,
  projectRoot: string = process.cwd()
): void {
  const { auth, operations, actions, executor, audit, metrics } = dependencies;

  /**
   * The dashboard is served only when operators are configured. With no
   * credentials there is no way to sign in, so publishing the page would just
   * advertise an endpoint; 404 is the honest response.
   */
  if (auth.configured) {
    app.use('/ops', (_request: Request, response: Response, next: NextFunction) => {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Robots-Tag', 'noindex, nofollow');
      next();
    }, express.static(`${projectRoot}/ops-dashboard`, { index: 'index.html', dotfiles: 'deny', redirect: false }));
  }
  const router = express.Router();
  router.use(express.json({ limit: '16kb' }));

  // Operations data must never be cached by a proxy or a browser.
  router.use((_request: Request, response: Response, next: NextFunction) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });

  router.post('/session', (request: Request, response: Response) => {
    const body = request.body as { operatorId?: unknown; token?: unknown } | undefined;
    const result = auth.login(body?.operatorId, body?.token);
    if (!result.ok || !result.session || !result.sessionToken) {
      metrics?.increment('operations_login_failure_total');
      // The reason is deliberately coarse: it never reveals whether the
      // operator ID exists.
      const status = result.reason === 'rate-limited' ? 429 : 401;
      return response.status(status).json({ ok: false, error: result.reason === 'rate-limited' ? 'rate-limited' : 'invalid-credentials' });
    }
    metrics?.increment('operations_login_success_total');
    response.cookie(OPERATIONS_COOKIE, result.sessionToken, {
      httpOnly: true,
      sameSite: 'strict',
      secure: config.authCookieSecure,
      path: '/api/v1/operations',
      maxAge: Math.max(0, result.session.expiresAt - Date.now())
    });
    audit.write({
      operatorId: result.session.operatorId, action: 'operator.login', targetType: 'operator',
      targetId: result.session.operatorId, requestId: randomUUID(), success: true
    });
    return response.json({
      ok: true,
      operatorId: result.session.operatorId,
      role: result.session.role,
      csrfToken: result.session.csrfToken,
      expiresAt: result.session.expiresAt
    });
  });

  const requireOperator = (capability: 'operations:read' | 'operations:act') =>
    (request: Request, response: Response, next: NextFunction): void => {
      const token = readSessionCookie(request.headers.cookie, OPERATIONS_COOKIE);
      const session = auth.authenticate(token);
      if (!session) {
        metrics?.increment('operations_unauthorized_total');
        response.status(401).json({ ok: false, error: 'unauthorized' });
        return;
      }
      if (!roleAllows(session.role, capability)) {
        response.status(403).json({ ok: false, error: 'forbidden' });
        return;
      }
      request.operatorSession = session;
      request.operationsRequestId = randomUUID();
      next();
    };

  /** Milestone 11.27: CSRF protection on every state-changing request. */
  const requireCsrf = (request: Request, response: Response, next: NextFunction): void => {
    const supplied = request.header(CSRF_HEADER);
    if (!supplied || supplied !== request.operatorSession?.csrfToken) {
      metrics?.increment('operations_csrf_rejected_total');
      response.status(403).json({ ok: false, error: 'csrf-failed' });
      return;
    }
    next();
  };

  router.delete('/session', requireOperator('operations:read'), (request: Request, response: Response) => {
    auth.revoke(readSessionCookie(request.headers.cookie, OPERATIONS_COOKIE));
    response.clearCookie(OPERATIONS_COOKIE, { path: '/api/v1/operations' });
    audit.write({
      operatorId: request.operatorSession!.operatorId, action: 'operator.logout', targetType: 'operator',
      targetId: request.operatorSession!.operatorId, requestId: request.operationsRequestId!, success: true
    });
    response.json({ ok: true });
  });

  router.get('/overview', requireOperator('operations:read'), (_request: Request, response: Response) => {
    response.json({ ok: true, data: operations.overview() });
  });

  router.get('/servers', requireOperator('operations:read'), (_request: Request, response: Response) => {
    response.json({ ok: true, data: operations.servers() });
  });

  router.get('/rooms', requireOperator('operations:read'), (_request: Request, response: Response) => {
    response.json({ ok: true, data: operations.rooms() });
  });

  router.get('/cabinets', requireOperator('operations:read'), (request: Request, response: Response) => {
    const roomId = typeof request.query.roomId === 'string' ? request.query.roomId : undefined;
    response.json({ ok: true, data: operations.cabinets(roomId) });
  });

  router.get('/actions', requireOperator('operations:read'), (_request: Request, response: Response) => {
    response.json({ ok: true, data: actions.describe() });
  });

  router.get('/audit', requireOperator('operations:read'), (request: Request, response: Response) => {
    const limit = Number.parseInt(String(request.query.limit ?? '100'), 10);
    response.json({
      ok: true,
      data: audit.list({
        operatorId: typeof request.query.operatorId === 'string' ? request.query.operatorId : undefined,
        action: typeof request.query.action === 'string' ? request.query.action : undefined,
        success: request.query.success === undefined ? undefined : request.query.success === 'true'
      }, Number.isFinite(limit) ? limit : 100)
    });
  });

  router.post('/actions', requireOperator('operations:act'), requireCsrf, (request: Request, response: Response) => {
    const body = request.body as { action?: unknown; targetId?: unknown; value?: unknown; reason?: unknown; dryRun?: unknown } | undefined;
    if (typeof body?.action !== 'string') {
      response.status(400).json({ ok: false, error: 'invalid-request' });
      return;
    }
    void executor.execute(request.operatorSession!, {
      action: body.action,
      targetId: body.targetId,
      value: body.value,
      reason: body.reason,
      dryRun: body.dryRun,
      requestId: request.operationsRequestId!
    }).then((result) => {
      metrics?.increment(result.ok ? 'operations_action_success_total' : 'operations_action_failure_total');
      response.status(result.ok ? 200 : statusFor(result.reason)).json({ ok: result.ok, data: result, requestId: request.operationsRequestId });
    }).catch(() => {
      // Without this the request would hang and the rejection would surface as
      // an unhandled rejection, which terminates the process by default.
      metrics?.increment('operations_action_error_total');
      if (!response.headersSent) {
        response.status(500).json({ ok: false, error: 'internal-error', requestId: request.operationsRequestId ?? null });
      }
    });
  });

  // Milestone 11.31: never return a stack trace. A malformed or oversized body
  // is the caller's error and is reported as such; anything else becomes an
  // opaque failure carrying only the request ID for correlation.
  router.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
    const parsed = asBodyParserError(error);
    if (parsed) {
      response.status(parsed.code === 'payload-too-large' ? 413 : 400)
        .json({ ok: false, error: parsed.code, requestId: request.operationsRequestId ?? null });
      return;
    }
    metrics?.increment('operations_route_error_total');
    response.status(500).json({ ok: false, error: 'internal-error', requestId: request.operationsRequestId ?? null });
  });

  app.use('/api/v1/operations', router);
}

function statusFor(reason: string | undefined): number {
  if (reason === 'forbidden') return 403;
  if (reason === 'unknown-action' || reason === 'not-found') return 404;
  return 400;
}
