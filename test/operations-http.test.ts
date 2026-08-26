import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import { installOperationsRoutes, OPERATIONS_COOKIE } from '../server/src/http/operations-routes.js';
import { OperationsAuditLog } from '../server/src/operations/audit-log.js';
import { OperationsActionExecutor, OperationsActionRegistry, type ActionResult } from '../server/src/operations/operations-actions.js';
import { OperationsService } from '../server/src/operations/operations-service.js';
import { OperatorAuthService, parseOperatorCredentials } from '../server/src/operations/operator-auth.js';
import { loadServerConfig } from '../server/src/config.js';

const TOKEN = 'c'.repeat(40);

/** Boots the operations routes on an ephemeral port for real HTTP assertions. */
async function bootServer(operatorSpec: string | null = `admin-1:admin:${TOKEN},looker:viewer:${'d'.repeat(40)}`) {
  const app = express();
  // null means "no operators configured"; undefined would silently pick up the
  // default above and quietly stop testing the unconfigured case.
  const auth = new OperatorAuthService(parseOperatorCredentials(operatorSpec ?? undefined));
  const audit = new OperationsAuditLog('test');
  const actions = new OperationsActionRegistry();
  let drained = false;
  actions.register('server.drain', {
    capability: 'operations:admin', requiresReason: true, targetType: 'server',
    execute: ({ dryRun }): ActionResult => {
      if (!dryRun) drained = true;
      return { ok: true, dryRun, resultingState: { draining: true } };
    }
  });

  const operations = new OperationsService({
    server: () => ({
      serverId: 's-1', region: 'test', version: 'v', uptimeSeconds: 1, roomCount: 0, playerCount: 0,
      capacity: { maxPlayers: 1, maxRooms: 1 }, draining: drained, ready: true, readinessReasons: [],
      eventLoopDelayMs: 0, memoryRssBytes: 1
    }),
    rooms: () => [], cabinets: () => [], dependencies: () => [],
    plugins: () => ({ total: 0, started: 0, failed: 0, disabled: 0, failures: [] }),
    emulatorAdapters: () => [], registry: () => ({ cabinetDefinitions: 0, zones: 0, gameDefinitions: 0 }),
    featureFlags: () => ({}), activeGameSessions: () => 0, queues: () => []
  }, 'test');

  installOperationsRoutes(app, loadServerConfig({ ...process.env, NODE_ENV: 'test' }), {
    auth, operations, actions, executor: new OperationsActionExecutor(actions, audit), audit
  });

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    isDrained: () => drained,
    audit,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

/** Extracts the operations session cookie from a Set-Cookie header. */
function cookieFrom(response: Response): string | undefined {
  const header = response.headers.getSetCookie?.().find((entry) => entry.startsWith(`${OPERATIONS_COOKIE}=`));
  return header?.split(';')[0];
}

void test('every operations endpoint refuses an unauthenticated request', async () => {
  // Milestone 11.27: operations endpoints are never exposed without auth.
  const server = await bootServer();
  try {
    for (const path of ['/overview', '/servers', '/rooms', '/cabinets', '/actions', '/audit']) {
      const response = await fetch(`${server.base}/api/v1/operations${path}`);
      assert.equal(response.status, 401, `${path} must require authentication`);
      assert.deepEqual(await response.json(), { ok: false, error: 'unauthorized' });
    }
    const action = await fetch(`${server.base}/api/v1/operations/actions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'server.drain' })
    });
    assert.equal(action.status, 401);
    assert.equal(server.isDrained(), false);
  } finally {
    await server.close();
  }
});

void test('a forged cookie does not authenticate', async () => {
  const server = await bootServer();
  try {
    const response = await fetch(`${server.base}/api/v1/operations/overview`, {
      headers: { cookie: `${OPERATIONS_COOKIE}=${'f'.repeat(43)}` }
    });
    assert.equal(response.status, 401);
  } finally {
    await server.close();
  }
});

void test('an operator signs in and reads status', async () => {
  const server = await bootServer();
  try {
    const login = await fetch(`${server.base}/api/v1/operations/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operatorId: 'admin-1', token: TOKEN })
    });
    assert.equal(login.status, 200);
    const payload = await login.json() as { ok: boolean; role: string; csrfToken: string };
    assert.equal(payload.ok, true);
    assert.equal(payload.role, 'admin');

    const cookie = cookieFrom(login);
    assert.ok(cookie, 'a session cookie must be issued');
    const setCookie = login.headers.getSetCookie?.().join(';') ?? '';
    assert.match(setCookie, /HttpOnly/i, 'the session cookie must be HttpOnly');
    assert.match(setCookie, /SameSite=Strict/i);

    const overview = await fetch(`${server.base}/api/v1/operations/overview`, { headers: { cookie } });
    assert.equal(overview.status, 200);
    const data = await overview.json() as { ok: boolean; data: { deploymentVersion: string } };
    assert.equal(data.ok, true);
    assert.equal(data.data.deploymentVersion, 'test');
    assert.equal(overview.headers.get('cache-control'), 'no-store');
  } finally {
    await server.close();
  }
});

void test('bad credentials give a coarse failure that does not reveal the operator', async () => {
  const server = await bootServer();
  try {
    const unknownOperator = await fetch(`${server.base}/api/v1/operations/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operatorId: 'nobody', token: TOKEN })
    });
    const wrongToken = await fetch(`${server.base}/api/v1/operations/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operatorId: 'admin-1', token: 'wrong-token-but-long-enough-here' })
    });
    assert.equal(unknownOperator.status, 401);
    assert.equal(wrongToken.status, 401);
    // Identical responses: nothing distinguishes an unknown operator from a bad token.
    assert.deepEqual(await unknownOperator.json(), await wrongToken.json());
  } finally {
    await server.close();
  }
});

void test('a state-changing request without the CSRF token is refused', async () => {
  // Milestone 11.27: CSRF protection where applicable.
  const server = await bootServer();
  try {
    const login = await fetch(`${server.base}/api/v1/operations/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operatorId: 'admin-1', token: TOKEN })
    });
    const { csrfToken } = await login.json() as { csrfToken: string };
    const cookie = cookieFrom(login)!;

    const withoutToken = await fetch(`${server.base}/api/v1/operations/actions`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'server.drain', reason: 'test' })
    });
    assert.equal(withoutToken.status, 403);
    assert.deepEqual(await withoutToken.json(), { ok: false, error: 'csrf-failed' });
    assert.equal(server.isDrained(), false, 'a CSRF failure must change nothing');

    const wrongToken = await fetch(`${server.base}/api/v1/operations/actions`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-arcade-ops-csrf': 'not-the-token' },
      body: JSON.stringify({ action: 'server.drain', reason: 'test' })
    });
    assert.equal(wrongToken.status, 403);

    const accepted = await fetch(`${server.base}/api/v1/operations/actions`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-arcade-ops-csrf': csrfToken },
      body: JSON.stringify({ action: 'server.drain', reason: 'rolling restart' })
    });
    assert.equal(accepted.status, 200);
    assert.equal(server.isDrained(), true);
  } finally {
    await server.close();
  }
});

void test('a viewer cannot run actions even with a valid session and CSRF token', async () => {
  // Authorization is server-side: a viewer holding every client-side artifact
  // still cannot act.
  const server = await bootServer();
  try {
    const login = await fetch(`${server.base}/api/v1/operations/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operatorId: 'looker', token: 'd'.repeat(40) })
    });
    const { csrfToken } = await login.json() as { csrfToken: string };
    const cookie = cookieFrom(login)!;

    const response = await fetch(`${server.base}/api/v1/operations/actions`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-arcade-ops-csrf': csrfToken },
      body: JSON.stringify({ action: 'server.drain', reason: 'nope' })
    });
    assert.equal(response.status, 403);
    assert.equal(server.isDrained(), false);

    // Reading is still allowed for a viewer.
    assert.equal((await fetch(`${server.base}/api/v1/operations/overview`, { headers: { cookie } })).status, 200);
  } finally {
    await server.close();
  }
});

void test('signing out revokes the session immediately', async () => {
  const server = await bootServer();
  try {
    const login = await fetch(`${server.base}/api/v1/operations/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operatorId: 'admin-1', token: TOKEN })
    });
    const cookie = cookieFrom(login)!;
    assert.equal((await fetch(`${server.base}/api/v1/operations/session`, { method: 'DELETE', headers: { cookie } })).status, 200);
    assert.equal((await fetch(`${server.base}/api/v1/operations/overview`, { headers: { cookie } })).status, 401);
  } finally {
    await server.close();
  }
});

void test('the dashboard is not served when no operators are configured', async () => {
  const server = await bootServer(null);
  try {
    assert.equal((await fetch(`${server.base}/ops/`)).status, 404, 'an unusable console must not be published');
    const login = await fetch(`${server.base}/api/v1/operations/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operatorId: 'admin-1', token: TOKEN })
    });
    assert.equal(login.status, 401);
  } finally {
    await server.close();
  }
});

void test('the dashboard is served, uncached and unindexed, when operators exist', async () => {
  const server = await bootServer();
  try {
    const response = await fetch(`${server.base}/ops/`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('x-robots-tag') ?? '', /noindex/);
    const body = await response.text();
    assert.match(body, /ARCADE OPERATIONS/);
    // Comments are stripped first: the source explains that moderation is out of
    // scope, and matching that explanation would be a false positive.
    const rendered = body.replace(/<!--[\s\S]*?-->/g, '');
    for (const forbidden of [/\bchat\b/i, /\bmoderation\b/i, /\bban\b/i, /\bmute\b/i]) {
      assert.ok(!forbidden.test(rendered), `the console must not ship ${forbidden}`);
    }
  } finally {
    await server.close();
  }
});
