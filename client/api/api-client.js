/**
 * Milestone 11.32 — the typed API client.
 *
 * One base URL, one error shape, one place that knows about credentials,
 * request IDs, idempotency, retries, and cancellation. The rule this exists to
 * enforce is Milestone 11.32's last line: no raw `fetch` scattered through the
 * application.
 *
 * Types are expressed as JSDoc so the browser can load this module directly
 * while `tsc --checkJs` and editors still see the shapes.
 *
 * @typedef {Object} ApiErrorBody
 * @property {string} code
 * @property {string} message
 * @property {string[]} [details]
 */

/** Thrown for every non-success response, so callers handle one error type. */
export class ArcadeApiError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ status?: number, requestId?: string|null, details?: string[] }} [context]
   */
  constructor(code, message, context = {}) {
    super(message);
    this.name = 'ArcadeApiError';
    this.code = code;
    this.status = context.status ?? 0;
    this.requestId = context.requestId ?? null;
    this.details = context.details ?? [];
  }

  /** True when retrying the same request could plausibly succeed. */
  get retryable() {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD']);
const DEFAULT_RETRIES = 2;
const DEFAULT_TIMEOUT_MS = 10_000;

export class ArcadeApiClient {
  /**
   * @param {{ baseUrl?: string, fetchImpl?: typeof fetch, onSessionExpired?: () => void,
   *           retries?: number, timeoutMs?: number, now?: () => number }} [options]
   */
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl ?? '/api/v1').replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? ((...args) => globalThis.fetch(...args));
    this.onSessionExpired = options.onSessionExpired ?? null;
    this.retries = options.retries ?? DEFAULT_RETRIES;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    /** In-flight GETs, keyed by URL, so duplicate reads share one request. */
    this.inFlight = new Map();
    this.lastRequestId = null;
  }

  /** @param {string} path @param {Record<string, unknown>} [query] */
  #url(path, query) {
    const url = `${this.baseUrl}/${String(path).replace(/^\/+/, '')}`;
    if (!query) return url;
    const parameters = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      parameters.set(key, String(value));
    }
    const serialized = parameters.toString();
    return serialized ? `${url}?${serialized}` : url;
  }

  /**
   * @param {string} path
   * @param {{ method?: string, query?: Record<string, unknown>, body?: unknown,
   *           signal?: AbortSignal, idempotencyKey?: string, headers?: Record<string,string> }} [options]
   */
  async request(path, options = {}) {
    const method = (options.method ?? 'GET').toUpperCase();
    const url = this.#url(path, options.query);

    // Deduplicate concurrent identical reads. Writes are never deduplicated:
    // two POSTs are two intents unless the caller supplied an idempotency key.
    if (SAFE_METHODS.has(method) && this.inFlight.has(url)) return this.inFlight.get(url);

    const attempt = this.#attempt(url, method, options);
    if (SAFE_METHODS.has(method)) {
      this.inFlight.set(url, attempt);
      try { return await attempt; } finally { this.inFlight.delete(url); }
    }
    return attempt;
  }

  async #attempt(url, method, options) {
    // Retries apply only to safe, idempotent requests, or to a write the caller
    // marked idempotent with a key. Anything else is sent exactly once.
    const retryable = SAFE_METHODS.has(method) || options.idempotencyKey !== undefined;
    const maxAttempts = retryable ? this.retries + 1 : 1;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.#send(url, method, options);
      } catch (error) {
        lastError = error;
        const canRetry = error instanceof ArcadeApiError && error.retryable && attempt < maxAttempts;
        if (!canRetry) throw error;
        await delay(Math.min(2_000, 200 * 2 ** (attempt - 1)));
      }
    }
    throw lastError;
  }

  async #send(url, method, options) {
    const headers = { accept: 'application/json', ...(options.headers ?? {}) };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;

    // A caller's signal and the client timeout are combined, so cancellation
    // works whichever fires first.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), this.timeoutMs);
    const abortFromCaller = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', abortFromCaller, { once: true });
    if (options.signal?.aborted) abortFromCaller();

    let response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        credentials: 'same-origin',
        signal: controller.signal,
        body: options.body === undefined ? undefined : JSON.stringify(options.body)
      });
    } catch (error) {
      // A caller-initiated abort is not an API failure; propagate it as-is.
      if (options.signal?.aborted) throw error;
      throw new ArcadeApiError('network-error', error?.message ?? 'Network request failed.', { status: 0 });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abortFromCaller);
    }

    const requestId = response.headers.get('x-request-id');
    this.lastRequestId = requestId;

    let payload = null;
    try { payload = await response.json(); } catch { /* handled below */ }

    if (response.status === 401) {
      this.onSessionExpired?.();
      throw new ArcadeApiError('unauthorized', 'Session expired.', { status: 401, requestId });
    }
    if (!response.ok || payload?.ok !== true) {
      const error = payload?.error ?? {};
      throw new ArcadeApiError(
        error.code ?? 'internal-error',
        error.message ?? `Request failed (${response.status}).`,
        { status: response.status, requestId, details: error.details ?? [] }
      );
    }
    return { data: payload.data, meta: payload.meta ?? null, requestId };
  }

  // ---- Catalogue -----------------------------------------------------------

  /** @param {AbortSignal} [signal] */
  platform(signal) { return this.request('platform', { signal }); }

  /** @param {{ zoneId?: string, gameId?: string, cabinetType?: string, enabled?: boolean, limit?: number, cursor?: string, sort?: string, order?: string }} [query] */
  cabinets(query = {}, signal) { return this.request('cabinets', { query, signal }); }

  cabinet(cabinetId, signal) { return this.request(`cabinets/${encodeURIComponent(cabinetId)}`, { signal }); }

  zones(query = {}, signal) { return this.request('zones', { query, signal }); }

  zone(zoneId, signal) { return this.request(`zones/${encodeURIComponent(zoneId)}`, { signal }); }

  /** Zone streaming: which zones a player at this position should hold. */
  activeZones(x, z, signal) { return this.request('world/active-zones', { query: { x, z }, signal }); }

  games(query = {}, signal) { return this.request('games', { query, signal }); }

  game(gameId, signal) { return this.request(`games/${encodeURIComponent(gameId)}`, { signal }); }

  /** Walks every page of a paginated endpoint, respecting cancellation. */
  async *paginate(path, query = {}, signal) {
    let cursor = null;
    do {
      const page = await this.request(path, { query: { ...query, cursor: cursor ?? undefined }, signal });
      for (const item of page.data) yield item;
      cursor = page.meta?.nextCursor ?? null;
    } while (cursor !== null);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
