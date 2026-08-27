import {
  FAILURE_REASONS, PROTOCOL_VERSION, RUNTIME_PORTS, SESSION_STATES,
  isValidLaunchRequest, isValidSessionId
} from './protocol.js';

const TOKEN_STORAGE_KEY = 'ptc-runtime-token';

/**
 * The page's side of the PTC Arcade Runtime.
 *
 * Detection has to be cheap and quiet: most players will not have the runtime
 * installed, and every one of them loads this page. So the probe is a short,
 * parallel, aborted-on-first-answer sweep of the loopback ports, and its result
 * is cached for the page's lifetime. A player without the runtime pays a few
 * milliseconds of failed connections once.
 *
 * Nothing here decides what to launch. The page names a game id; the runtime
 * resolves it. That asymmetry is the reason this is safe to expose to a web
 * page at all, so the client offers no way to name a file.
 */
export class RuntimeClient {
  #fetchImpl;
  #storage;
  #ports;
  #detection = null;
  #base = null;

  constructor({ fetchImpl, storage, ports = RUNTIME_PORTS, probeTimeoutMs = 600 } = {}) {
    this.#fetchImpl = fetchImpl ?? ((...args) => globalThis.fetch(...args));
    this.#storage = storage ?? safeLocalStorage();
    this.#ports = ports;
    this.probeTimeoutMs = probeTimeoutMs;
  }

  /** Cached so a page that asks twice does not sweep the ports twice. */
  async detect() {
    this.#detection ??= this.#probe();
    return this.#detection;
  }

  /** Forgets the cached probe, for a player who installs without reloading. */
  reset() {
    this.#detection = null;
    this.#base = null;
  }

  async #probe() {
    const attempts = this.#ports.map(async (port) => {
      const base = `http://127.0.0.1:${port}`;
      const status = await this.#status(base);
      if (!status) throw new Error('no runtime');
      return { base, status };
    });

    let found;
    try {
      found = await Promise.any(attempts);
    } catch {
      return { present: false, reason: FAILURE_REASONS.RUNTIME_ABSENT };
    }

    this.#base = found.base;
    if (found.status.protocolVersion !== PROTOCOL_VERSION) {
      // An installed-but-old runtime is a different problem from an absent one,
      // and the player fixes it a different way.
      return {
        present: true, usable: false, reason: FAILURE_REASONS.PROTOCOL_MISMATCH,
        runtimeVersion: found.status.version ?? null, expected: PROTOCOL_VERSION, found: found.status.protocolVersion ?? null
      };
    }
    return {
      present: true,
      usable: true,
      base: found.base,
      version: found.status.version ?? null,
      platforms: found.status.platforms ?? [],
      dolphinPresent: found.status.dolphin?.present === true,
      paired: found.status.paired === true && Boolean(this.token)
    };
  }

  async #status(base) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.probeTimeoutMs);
    try {
      const response = await this.#fetchImpl(`${base}/v1/status`, { signal: controller.signal, mode: 'cors' });
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  get token() {
    try { return this.#storage?.getItem(TOKEN_STORAGE_KEY) ?? null; } catch { return null; }
  }

  set token(value) {
    try {
      if (value) this.#storage?.setItem(TOKEN_STORAGE_KEY, value);
      else this.#storage?.removeItem(TOKEN_STORAGE_KEY);
    } catch { /* A browser refusing storage costs pairing, not correctness. */ }
  }

  /**
   * Asks the runtime to show a pairing code in its own window. The code is not
   * returned here — that is the point of it. It is displayed where only someone
   * at the machine can read it, so a page cannot pair itself in the background.
   */
  async beginPairing() {
    const response = await this.#post('/v1/pair/begin', {});
    return { ok: response.ok === true, expiresInMs: response.expiresInMs ?? null };
  }

  /** Completes pairing with the code the player read off the runtime's window. */
  async completePairing(code) {
    const response = await this.#post('/v1/pair/complete', { code: String(code ?? '').trim() });
    if (response.ok !== true || typeof response.token !== 'string') {
      return { ok: false, reason: response.reason ?? 'pairing-failed', attemptsRemaining: response.attemptsRemaining ?? null };
    }
    this.token = response.token;
    return { ok: true };
  }

  /**
   * Starts a game. The request names an id and a platform, and the protocol
   * module refuses anything carrying a path or an argument before it is sent —
   * a caller that tries has misunderstood the contract, and finding that out
   * here is better than finding it out in the runtime's logs.
   */
  async launch({ gameId, platformId, cabinetId }) {
    const request = { protocolVersion: PROTOCOL_VERSION, gameId, platformId, cabinetId };
    if (!isValidLaunchRequest(request)) return { ok: false, reason: FAILURE_REASONS.UNKNOWN_GAME };
    if (!this.token) return { ok: false, reason: FAILURE_REASONS.NOT_PAIRED };

    const response = await this.#post('/v1/sessions', request);
    if (response.ok !== true || !isValidSessionId(response.sessionId)) {
      return { ok: false, reason: response.reason ?? FAILURE_REASONS.LAUNCH_FAILED };
    }
    return { ok: true, sessionId: response.sessionId };
  }

  /**
   * Follows one session to its end.
   *
   * Polled rather than streamed: a first launch downloads a gigabyte and the
   * interesting events are a percentage and an ending, which a one-second poll
   * carries perfectly well without a second connection to keep alive.
   */
  async *follow(sessionId, { intervalMs = 1_000, signal } = {}) {
    if (!isValidSessionId(sessionId)) return;
    let last = null;
    while (!signal?.aborted) {
      const state = await this.#get(`/v1/sessions/${sessionId}`);
      if (!state?.ok) {
        yield { state: SESSION_STATES.FAILED, reason: state?.reason ?? FAILURE_REASONS.LAUNCH_FAILED };
        return;
      }
      const changed = state.state !== last?.state || state.percent !== last?.percent;
      if (changed) yield state;
      last = state;
      if (state.state === SESSION_STATES.EXITED || state.state === SESSION_STATES.FAILED) return;
      await delay(intervalMs, signal);
    }
  }

  /** Asks the runtime to stop the session, for a player who closed the cabinet. */
  async stop(sessionId) {
    if (!isValidSessionId(sessionId)) return { ok: false };
    return this.#post(`/v1/sessions/${sessionId}/stop`, {});
  }

  async #post(path, body) {
    if (!this.#base) return { ok: false, reason: FAILURE_REASONS.RUNTIME_ABSENT };
    try {
      const response = await this.#fetchImpl(`${this.#base}${path}`, {
        method: 'POST',
        mode: 'cors',
        headers: { 'content-type': 'application/json', ...(this.token ? { 'x-ptc-runtime-token': this.token } : {}) },
        body: JSON.stringify(body)
      });
      return await response.json();
    } catch {
      return { ok: false, reason: FAILURE_REASONS.RUNTIME_ABSENT };
    }
  }

  async #get(path) {
    if (!this.#base) return { ok: false, reason: FAILURE_REASONS.RUNTIME_ABSENT };
    try {
      const response = await this.#fetchImpl(`${this.#base}${path}`, {
        mode: 'cors',
        headers: this.token ? { 'x-ptc-runtime-token': this.token } : {}
      });
      return await response.json();
    } catch {
      return { ok: false, reason: FAILURE_REASONS.RUNTIME_ABSENT };
    }
  }
}

function delay(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

function safeLocalStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}
