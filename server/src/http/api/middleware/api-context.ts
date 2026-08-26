import { randomUUID } from 'node:crypto';
import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Milestone 11.31 — consistent errors, request IDs, and idempotency keys.
 *
 * Everything the versioned API returns goes through `ok`/`fail` here, so no
 * handler invents its own envelope and no error path can accidentally return a
 * stack trace. The request ID is echoed on every response, success or failure,
 * so a report from an operator or a client can be correlated with logs.
 */
export const API_VERSION = 'v1';

declare module 'express-serve-static-core' {
  interface Request {
    apiRequestId?: string;
    idempotencyKey?: string;
  }
}

export type ApiErrorCode =
  | 'bad-request' | 'unauthorized' | 'forbidden' | 'not-found'
  | 'conflict' | 'unprocessable' | 'rate-limited' | 'internal-error';

const STATUS_BY_CODE: Readonly<Record<ApiErrorCode, number>> = Object.freeze({
  'bad-request': 400,
  unauthorized: 401,
  forbidden: 403,
  'not-found': 404,
  conflict: 409,
  unprocessable: 422,
  'rate-limited': 429,
  'internal-error': 500
});

export interface ApiSuccess<T> {
  ok: true;
  apiVersion: string;
  requestId: string;
  data: T;
  meta?: Record<string, unknown>;
}

export interface ApiFailure {
  ok: false;
  apiVersion: string;
  requestId: string;
  error: { code: ApiErrorCode; message: string; details?: readonly string[] };
}

export class ApiError extends Error {
  constructor(readonly code: ApiErrorCode, message: string, readonly details?: readonly string[]) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Assigns a request ID, echoes it, and captures a client idempotency key. */
export const withApiContext: RequestHandler = (request: Request, response: Response, next: NextFunction) => {
  const supplied = request.header('x-request-id');
  // A client-supplied ID is honoured only when it looks like an ID, so it
  // cannot be used to inject arbitrary text into logs.
  request.apiRequestId = typeof supplied === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(supplied) ? supplied : randomUUID();
  const key = request.header('idempotency-key');
  request.idempotencyKey = typeof key === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(key) ? key : undefined;
  response.setHeader('x-request-id', request.apiRequestId);
  response.setHeader('x-api-version', API_VERSION);
  next();
};

export function ok<T>(request: Request, response: Response, data: T, meta?: Record<string, unknown>): void {
  const body: ApiSuccess<T> = { ok: true, apiVersion: API_VERSION, requestId: request.apiRequestId ?? 'unknown', data };
  if (meta) body.meta = meta;
  response.json(body);
}

export function fail(request: Request, response: Response, code: ApiErrorCode, message: string, details?: readonly string[]): void {
  const body: ApiFailure = {
    ok: false,
    apiVersion: API_VERSION,
    requestId: request.apiRequestId ?? 'unknown',
    error: { code, message, ...(details && details.length > 0 ? { details } : {}) }
  };
  response.status(STATUS_BY_CODE[code]).json(body);
}

/**
 * Terminal error handler. Milestone 11.31 forbids stack traces in production
 * responses, so an unexpected throw becomes an opaque internal error carrying
 * only the request ID; the detail goes to the log, not the client.
 */
export function apiErrorHandler(log: (event: string, details: Record<string, unknown>) => void) {
  return (error: unknown, request: Request, response: Response, next: NextFunction): void => {
    if (response.headersSent) { next(error); return; }
    if (error instanceof ApiError) {
      fail(request, response, error.code, error.message, error.details);
      return;
    }
    log('api_unhandled_error', {
      requestId: request.apiRequestId ?? null,
      path: request.path,
      error: error instanceof Error ? error.message : String(error)
    });
    fail(request, response, 'internal-error', 'An unexpected error occurred.');
  };
}

/**
 * The terminal /api/v1 handler, installed once after every versioned router.
 *
 * This deliberately does NOT live inside a feature router: a catch-all mounted
 * at /api/v1 swallows every sibling namespace registered after it, which is how
 * the operations API briefly disappeared behind the catalogue. Keeping it
 * app-level and explicit makes the ordering a stated requirement rather than an
 * accident of registration order.
 */
export function installApiNotFound(app: Express, log: (event: string, details: Record<string, unknown>) => void): void {
  app.use('/api/v1', withApiContext, (request: Request, response: Response) => {
    fail(request, response, 'not-found', 'No such endpoint.');
  });
  app.use('/api/v1', apiErrorHandler(log));
}

export interface PageRequest {
  limit: number;
  cursor: string | null;
  sort: string | null;
  order: 'asc' | 'desc';
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Parses pagination, sorting, and ordering. Out-of-range values are clamped
 * rather than rejected: a client asking for 10,000 rows gets the maximum, not
 * an error, but it can never make the server do unbounded work.
 */
export function readPageRequest(request: Request, allowedSorts: readonly string[] = []): PageRequest {
  const rawLimit = Number.parseInt(String(request.query.limit ?? ''), 10);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, MAX_LIMIT)) : DEFAULT_LIMIT;
  const cursor = typeof request.query.cursor === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(request.query.cursor)
    ? request.query.cursor
    : null;
  const requestedSort = typeof request.query.sort === 'string' ? request.query.sort : null;
  const sort = requestedSort !== null && allowedSorts.includes(requestedSort) ? requestedSort : null;
  const order = request.query.order === 'desc' ? 'desc' : 'asc';
  return { limit, cursor, sort, order };
}

export interface Page<T> {
  items: readonly T[];
  meta: { total: number; limit: number; nextCursor: string | null };
}

/**
 * Cursor pagination over an in-memory collection. The cursor is the ID of the
 * last item returned, so a page boundary stays stable when items are added.
 */
export function paginate<T extends { id: string }>(items: readonly T[], page: PageRequest): Page<T> {
  const startAt = page.cursor === null ? 0 : items.findIndex((item) => item.id === page.cursor) + 1;
  const window = items.slice(Math.max(0, startAt), Math.max(0, startAt) + page.limit);
  const consumed = Math.max(0, startAt) + window.length;
  return {
    items: window,
    meta: {
      total: items.length,
      limit: page.limit,
      nextCursor: consumed < items.length && window.length > 0 ? window[window.length - 1].id : null
    }
  };
}

/**
 * Milestone 11.31 — idempotency for critical writes.
 *
 * A repeated request carrying the same key returns the first response rather
 * than performing the work twice. Entries expire so the store cannot grow
 * without bound.
 */
export class IdempotencyStore {
  private readonly entries = new Map<string, { at: number; body: unknown }>();

  constructor(private readonly ttlMs = 10 * 60 * 1_000, private readonly capacity = 5_000) {}

  get(key: string, now = Date.now()): unknown | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (now - entry.at > this.ttlMs) { this.entries.delete(key); return undefined; }
    return entry.body;
  }

  set(key: string, body: unknown, now = Date.now()): void {
    this.entries.set(key, { at: now, body });
    if (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
  }

  get size(): number { return this.entries.size; }
}
