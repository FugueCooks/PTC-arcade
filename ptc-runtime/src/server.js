import { createServer } from 'node:http';
import {
  ALLOWED_ORIGINS, PROTOCOL_VERSION, RUNTIME_PLATFORMS, RUNTIME_PORTS,
  isValidLaunchRequest, isValidSessionId
} from '../../emulators/ptc-runtime/protocol.js';
import { checkProtocolVersion, checkRequest, createPairingCode, issueToken, verifyPairingCode, verifyToken } from './security.js';

/** Small on purpose: no request this accepts is larger than a few hundred bytes. */
const MAX_BODY_BYTES = 4 * 1024;

/**
 * The loopback HTTP surface.
 *
 * Bound to 127.0.0.1 and nothing else. Every route except `/v1/status` requires
 * a paired token, and every route requires an allowed Origin — including the
 * preflight, because a permissive preflight is how a browser is talked into
 * sending the real request.
 *
 * `/v1/status` is deliberately readable by any allowed origin without a token:
 * the page has to be able to tell "not installed" from "installed but not
 * paired" before it can ask the player to do anything about either. It answers
 * with versions and capabilities, never with anything about the player, the
 * library, or the machine.
 */
export function createRuntimeServer({
  sessions, pairing, onPairingCode, allowedOrigins = ALLOWED_ORIGINS,
  installSecret, version, dolphinAvailable, pcsx2Available = () => false, melondsAvailable = () => false, vbaAvailable = () => false, now = () => Date.now(), log = () => {}
}) {
  let pendingPairing = null;
  const paired = pairing ?? { tokens: new Set() };

  const server = createServer((request, response) => {
    void handle(request, response).catch(() => sendJson(response, 500, { ok: false, reason: 'internal-error' }));
  });

  async function handle(request, response) {
    const origin = request.headers.origin;
    const originAllowed = typeof origin === 'string' && allowedOrigins.includes(origin);

    // CORS headers are set only for an allowed origin. Echoing an arbitrary
    // origin here would let any page read this runtime's answers.
    if (originAllowed) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Headers', 'content-type, x-ptc-runtime-token');
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      response.setHeader('Access-Control-Max-Age', '600');
      // Chrome treats a page on the public internet reaching 127.0.0.1 as a
      // private-network request and blocks it unless the preflight is answered
      // with this. Without it the arcade probe fails before it is even sent,
      // the runtime looks absent, and the player is quietly given the browser
      // core with nothing anywhere saying why. Only ever sent to an origin
      // already on the allow-list.
      if (request.headers['access-control-request-private-network'] === 'true') {
        response.setHeader('Access-Control-Allow-Private-Network', 'true');
      }
    }
    // Never: a credentialed cross-origin request would carry the browser's
    // cookies into a local process, and the token already identifies the page.
    response.setHeader('Access-Control-Allow-Credentials', 'false');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');

    if (request.method === 'OPTIONS') {
      response.writeHead(originAllowed ? 204 : 403).end();
      return;
    }

    const gate = checkRequest(request, { allowedOrigins });
    if (!gate.ok) {
      log('request_refused', { reason: gate.reason, path: request.url, origin: origin ?? null });
      sendJson(response, 403, { ok: false, reason: gate.reason });
      return;
    }

    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const route = `${request.method} ${url.pathname}`;

    if (route === 'GET /v1/status') {
      sendJson(response, 200, {
        ok: true,
        runtime: 'ptc-arcade-runtime',
        version,
        protocolVersion: PROTOCOL_VERSION,
        platforms: RUNTIME_PLATFORMS,
        paired: paired.tokens.size > 0,
        dolphin: { present: dolphinAvailable() },
        // Named separately so a player missing one emulator is told which:
        // "install the runtime" is not useful advice to somebody who has it.
        pcsx2: { present: pcsx2Available() },
        melonds: { present: melondsAvailable() },
        vba: { present: vbaAvailable() }
      });
      return;
    }

    if (route === 'POST /v1/pair/begin') {
      pendingPairing = createPairingCode(now());
      // Displayed by the runtime's own window. Deliberately not in the
      // response: a page that could read the code could pair itself.
      onPairingCode(pendingPairing.code);
      log('pairing_started', {});
      sendJson(response, 200, { ok: true, expiresInMs: pendingPairing.expiresAt - now() });
      return;
    }

    if (route === 'POST /v1/pair/complete') {
      const body = await readJson(request);
      if (!body.ok) { sendJson(response, 400, { ok: false, reason: 'malformed-body' }); return; }

      const result = verifyPairingCode(pendingPairing, body.value?.code, now());
      pendingPairing = result.pairing;
      if (!result.ok) {
        log('pairing_failed', { reason: result.reason });
        sendJson(response, 403, {
          ok: false, reason: result.reason,
          attemptsRemaining: result.pairing?.attemptsRemaining ?? 0
        });
        return;
      }
      const token = issueToken(installSecret, gate.origin, now());
      paired.tokens.add(token);
      log('pairing_succeeded', { origin: gate.origin });
      sendJson(response, 200, { ok: true, token });
      return;
    }

    // Everything past this point starts or inspects a native process.
    const token = request.headers['x-ptc-runtime-token'];
    const verdict = verifyToken(installSecret, gate.origin, typeof token === 'string' ? token : '', now());
    if (!verdict.ok) {
      log('token_refused', { reason: verdict.reason, path: url.pathname });
      sendJson(response, 401, { ok: false, reason: 'not-paired' });
      return;
    }

    if (route === 'POST /v1/sessions') {
      const body = await readJson(request);
      if (!body.ok) { sendJson(response, 400, { ok: false, reason: 'malformed-body' }); return; }

      const versionCheck = checkProtocolVersion(body.value?.protocolVersion);
      if (!versionCheck.ok) { sendJson(response, 409, { ok: false, reason: 'protocol-mismatch' }); return; }

      // The whole security posture, enforced in one place: a request naming a
      // path, a URL, or a command is refused rather than cleaned up.
      if (!isValidLaunchRequest(body.value)) {
        log('launch_refused', { reason: 'invalid-request' });
        sendJson(response, 400, { ok: false, reason: 'invalid-request' });
        return;
      }

      const started = sessions.start({
        gameId: body.value.gameId, platformId: body.value.platformId, cabinetId: body.value.cabinetId
      });
      sendJson(response, started.ok ? 202 : 409, started);
      return;
    }

    const sessionMatch = /^\/v1\/sessions\/([0-9a-f]{32})(\/stop)?$/.exec(url.pathname);
    if (sessionMatch && isValidSessionId(sessionMatch[1])) {
      const sessionId = sessionMatch[1];
      if (request.method === 'GET' && !sessionMatch[2]) {
        const state = sessions.get(sessionId);
        sendJson(response, state.ok ? 200 : 404, state);
        return;
      }
      if (request.method === 'POST' && sessionMatch[2]) {
        sendJson(response, 200, await sessions.stop(sessionId));
        return;
      }
    }

    sendJson(response, 404, { ok: false, reason: 'unknown-route' });
  }

  return {
    server,
    /**
     * Loopback only, and never a routable address. Ports are tried in order so
     * a second runtime, or an unrelated service, does not silently prevent the
     * one the page will find.
     */
    async listen(ports = RUNTIME_PORTS) {
      for (const port of ports) {
        const bound = await tryListen(server, port);
        if (bound) return { ok: true, port };
      }
      return { ok: false, reason: 'no-free-port' };
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    }
  };
}

function tryListen(server, port) {
  return new Promise((resolve) => {
    const onError = () => { server.removeListener('listening', onListening); resolve(false); };
    const onListening = () => { server.removeListener('error', onError); resolve(true); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(payload);
}

/** Bounded, so a hostile local process cannot exhaust memory with one request. */
function readJson(request) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { request.destroy(); resolve({ ok: false }); return; }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try { resolve({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }); }
      catch { resolve({ ok: false }); }
    });
    request.on('error', () => resolve({ ok: false }));
  });
}
