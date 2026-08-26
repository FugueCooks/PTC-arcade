import assert from 'node:assert/strict';
import test from 'node:test';
import { AuditSecretLeakError, OperationsAuditLog, assertNoSecrets } from '../server/src/operations/audit-log.js';
import {
  OperationsActionExecutor, OperationsActionRegistry, requireBoolean, type ActionResult
} from '../server/src/operations/operations-actions.js';
import { OperationsService } from '../server/src/operations/operations-service.js';
import {
  OperatorAuthService, parseOperatorCredentials, roleAllows, type OperatorSession
} from '../server/src/operations/operator-auth.js';

const TOKEN = 'a'.repeat(40);
const OTHER_TOKEN = 'b'.repeat(40);

function authService(spec = `admin-1:admin:${TOKEN},viewer-1:viewer:${OTHER_TOKEN}`) {
  return new OperatorAuthService(parseOperatorCredentials(spec));
}

function sessionFor(role: 'viewer' | 'operator' | 'admin'): OperatorSession {
  return { sessionId: 's', operatorId: `${role}-1`, role, issuedAt: 0, expiresAt: Number.MAX_SAFE_INTEGER, csrfToken: 'csrf' };
}

void test('operator credentials parse strictly and drop anything malformed', () => {
  const credentials = parseOperatorCredentials([
    `good:admin:${TOKEN}`,
    'missing-token:admin',
    'bad-role:superuser:' + TOKEN,
    'short-token:admin:abc',
    'bad id!:admin:' + TOKEN,
    `good:operator:${OTHER_TOKEN}`
  ].join(','));
  assert.equal(credentials.length, 1, 'only the first well-formed, unique entry survives');
  assert.equal(credentials[0].operatorId, 'good');
  assert.equal(credentials[0].role, 'admin');
  // The token itself is never retained.
  assert.ok(!JSON.stringify(credentials).includes(TOKEN));
  assert.deepEqual(parseOperatorCredentials(undefined), []);
  assert.deepEqual(parseOperatorCredentials(''), []);
});

void test('operations cannot be reached without operator credentials at all', () => {
  // Milestone 11.27: never expose operations endpoints without authentication.
  const auth = new OperatorAuthService(parseOperatorCredentials(undefined));
  assert.equal(auth.configured, false);
  const result = auth.login('anyone', TOKEN);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not-configured');
});

void test('a player account or wallet cannot produce an operator session', () => {
  // Milestone 11.40 test 36, and the brief's requirement that a connected
  // Solana wallet grants no operations access. The operator store shares no
  // table, token format, or code path with player auth, so the only way in is
  // an operator credential — asserted here by exhausting the alternatives.
  const auth = authService();
  for (const impostor of [
    ['player-1', TOKEN],
    ['admin-1', 'player-session-token-that-is-long-enough'],
    ['admin-1', OTHER_TOKEN],
    ['', ''],
    ['admin-1', ''],
    ['viewer-1', TOKEN]
  ] as Array<[string, string]>) {
    const result = auth.login(impostor[0], impostor[1]);
    assert.equal(result.ok, false, `${impostor[0]} must not authenticate`);
    assert.equal(result.reason, 'invalid-credentials');
  }
  // A wallet-shaped identifier is not special-cased; it is simply unknown.
  assert.equal(auth.login('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', TOKEN).ok, false);
});

void test('a valid operator receives a session and a distinct CSRF token', () => {
  // Milestone 11.40 test 37.
  const auth = authService();
  const result = auth.login('admin-1', TOKEN);
  assert.equal(result.ok, true);
  assert.equal(result.session?.role, 'admin');
  assert.ok(result.sessionToken);
  assert.ok(result.session?.csrfToken);
  assert.notEqual(result.sessionToken, result.session?.csrfToken, 'CSRF must not equal the session token');

  assert.equal(auth.authenticate(result.sessionToken)?.operatorId, 'admin-1');
  assert.equal(auth.authenticate('not-a-session'), undefined);
  assert.equal(auth.authenticate(undefined), undefined);
});

void test('sessions expire and can be revoked', () => {
  const auth = new OperatorAuthService(parseOperatorCredentials(`admin-1:admin:${TOKEN}`), 1_000);
  const first = auth.login('admin-1', TOKEN, 0);
  assert.ok(first.sessionToken);
  assert.ok(auth.authenticate(first.sessionToken, 500));
  assert.equal(auth.authenticate(first.sessionToken, 1_001), undefined, 'an expired session must not resolve');

  const second = auth.login('admin-1', TOKEN, 2_000);
  assert.equal(auth.revoke(second.sessionToken), true);
  assert.equal(auth.authenticate(second.sessionToken, 2_100), undefined);

  const third = auth.login('admin-1', TOKEN, 3_000);
  assert.equal(auth.revokeAllFor('admin-1'), 1);
  assert.equal(auth.authenticate(third.sessionToken, 3_100), undefined);
});

void test('repeated failed logins are rate limited', () => {
  const auth = authService();
  for (let attempt = 0; attempt < 10; attempt += 1) auth.login('admin-1', 'wrong-token-value-here', 1_000);
  assert.equal(auth.login('admin-1', TOKEN, 1_000).reason, 'rate-limited', 'brute force must be throttled');
  // The window rolls: a later attempt is allowed again.
  assert.equal(auth.login('admin-1', TOKEN, 1_000 + 11 * 60 * 1_000).ok, true);
});

void test('roles gate what an operator may do', () => {
  assert.equal(roleAllows('viewer', 'operations:read'), true);
  assert.equal(roleAllows('viewer', 'operations:act'), false);
  assert.equal(roleAllows('operator', 'operations:act'), true);
  assert.equal(roleAllows('operator', 'operations:admin'), false);
  assert.equal(roleAllows('admin', 'operations:admin'), true);
});

/** Registry with one act-level and one admin-level action, for executor tests. */
function actionSetup() {
  const audit = new OperationsAuditLog('test-version');
  const registry = new OperationsActionRegistry();
  let enabled = true;
  registry.register('cabinet.set-enabled', {
    capability: 'operations:act', requiresReason: false, targetType: 'cabinet',
    execute: ({ targetId, value, dryRun }): ActionResult => {
      if (targetId !== 'known-cabinet') return { ok: false, reason: 'not-found', dryRun };
      const next = requireBoolean(value);
      if (next === undefined) return { ok: false, reason: 'invalid-value', dryRun };
      const previous = enabled;
      if (previous === next) return { ok: true, dryRun, noop: true, previousState: { enabled: previous }, resultingState: { enabled: next } };
      if (!dryRun) enabled = next;
      return { ok: true, dryRun, previousState: { enabled: previous }, resultingState: { enabled: next } };
    }
  });
  registry.register('server.drain', {
    capability: 'operations:admin', requiresReason: true, targetType: 'server',
    execute: ({ dryRun }): ActionResult => ({ ok: true, dryRun, resultingState: { draining: true } })
  });
  return { audit, registry, executor: new OperationsActionExecutor(registry, audit), isEnabled: () => enabled };
}

void test('operational actions require the right capability', async () => {
  // Milestone 11.40 test 38.
  const { executor, isEnabled } = actionSetup();
  const refused = await executor.execute(sessionFor('viewer'), { action: 'cabinet.set-enabled', targetId: 'known-cabinet', value: false, requestId: 'r-1' });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'forbidden');
  assert.equal(isEnabled(), true, 'a refused action must change nothing');

  const allowed = await executor.execute(sessionFor('operator'), { action: 'cabinet.set-enabled', targetId: 'known-cabinet', value: false, requestId: 'r-2' });
  assert.equal(allowed.ok, true);
  assert.equal(isEnabled(), false);

  // An operator may act but not administer.
  const adminOnly = await executor.execute(sessionFor('operator'), { action: 'server.drain', reason: 'rollout', requestId: 'r-3' });
  assert.equal(adminOnly.reason, 'forbidden');
  assert.equal((await executor.execute(sessionFor('admin'), { action: 'server.drain', reason: 'rollout', requestId: 'r-4' })).ok, true);
});

void test('every action attempt creates an audit record, including refusals', async () => {
  // Milestone 11.40 test 39.
  const { executor, audit } = actionSetup();
  await executor.execute(sessionFor('viewer'), { action: 'cabinet.set-enabled', targetId: 'known-cabinet', value: false, requestId: 'r-1' });
  await executor.execute(sessionFor('operator'), { action: 'cabinet.set-enabled', targetId: 'known-cabinet', value: false, requestId: 'r-2' });
  await executor.execute(sessionFor('admin'), { action: 'no.such.action', requestId: 'r-3' });

  const records = audit.list();
  assert.equal(records.length, 3);
  assert.equal(records.filter((record) => record.success).length, 1);
  assert.equal(records.filter((record) => !record.success).length, 2);
  const refusal = records.find((record) => record.failureReason === 'forbidden');
  assert.equal(refusal?.operatorId, 'viewer-1');
  assert.equal(refusal?.deploymentVersion, 'test-version');
  assert.ok(records.some((record) => record.failureReason === 'unknown-action'));
});

void test('invalid state changes are rejected', async () => {
  // Milestone 11.40 test 40.
  const { executor } = actionSetup();
  assert.equal((await executor.execute(sessionFor('operator'), { action: 'cabinet.set-enabled', targetId: 'ghost', value: false, requestId: 'r-1' })).reason, 'not-found');
  assert.equal((await executor.execute(sessionFor('operator'), { action: 'cabinet.set-enabled', targetId: 'known-cabinet', value: 'yes', requestId: 'r-2' })).reason, 'invalid-value');
  assert.equal((await executor.execute(sessionFor('admin'), { action: 'server.drain', requestId: 'r-3' })).reason, 'reason-required');
});

void test('arbitrary commands cannot be executed', async () => {
  // Milestone 11.40 test 41. The action set is enumerated: anything not
  // registered is refused by name, so there is no shell, SQL, or Redis path.
  const { executor, registry } = actionSetup();
  for (const attempt of ['exec', 'sh', 'eval', 'sql', 'redis.command', 'DROP TABLE users', '../../etc/passwd', '__proto__', 'constructor']) {
    const result = await executor.execute(sessionFor('admin'), { action: attempt, requestId: 'r-x' });
    assert.equal(result.ok, false, `${attempt} must not run`);
    assert.equal(result.reason, 'unknown-action');
  }
  assert.deepEqual(registry.names(), ['cabinet.set-enabled', 'server.drain']);
  assert.throws(() => registry.register('server.drain', registry.get('server.drain')!), /Duplicate operations action/);
});

void test('dry run reports the outcome without applying it', async () => {
  const { executor, isEnabled, audit } = actionSetup();
  const result = await executor.execute(sessionFor('operator'), { action: 'cabinet.set-enabled', targetId: 'known-cabinet', value: false, dryRun: true, requestId: 'r-1' });
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.resultingState, { enabled: false });
  assert.equal(isEnabled(), true, 'a dry run must not change state');
  assert.equal(audit.list()[0].dryRun, true, 'a dry run is still audited');
});

void test('actions are idempotent and report a no-op', async () => {
  const { executor } = actionSetup();
  const first = await executor.execute(sessionFor('operator'), { action: 'cabinet.set-enabled', targetId: 'known-cabinet', value: false, requestId: 'r-1' });
  const second = await executor.execute(sessionFor('operator'), { action: 'cabinet.set-enabled', targetId: 'known-cabinet', value: false, requestId: 'r-2' });
  assert.equal(first.noop, undefined);
  assert.equal(second.ok, true);
  assert.equal(second.noop, true, 'repeating an action must be harmless and reported as a no-op');
});

void test('a handler that throws yields a safe result, never a stack trace', async () => {
  const audit = new OperationsAuditLog('v');
  const registry = new OperationsActionRegistry();
  registry.register('registry.refresh', {
    capability: 'operations:admin', requiresReason: false, targetType: 'registry',
    execute: () => { throw new Error('internal detail that must not leak upward as a crash'); }
  });
  const result = await new OperationsActionExecutor(registry, audit).execute(sessionFor('admin'), { action: 'registry.refresh', requestId: 'r-1' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid-state');
  assert.equal(audit.list()[0].success, false);
});

void test('the audit log refuses to record anything secret-shaped', () => {
  const audit = new OperationsAuditLog('v');
  assert.throws(() => audit.write({
    operatorId: 'admin-1', action: 'x', targetType: 'y', requestId: 'r', success: true,
    resultingState: { sessionToken: 'leaked' }
  }), AuditSecretLeakError);

  for (const shape of [{ password: 'x' }, { csrfToken: 'x' }, { nested: { privateKey: 'x' } }, { Authorization: 'Bearer x' }, { cookie: 'a=b' }]) {
    assert.throws(() => assertNoSecrets(shape as never), AuditSecretLeakError);
  }
  assert.doesNotThrow(() => assertNoSecrets({ enabled: true, count: 2, nested: { roomId: 'main' } }));
});

void test('the audit log is bounded and filterable, newest first', () => {
  const audit = new OperationsAuditLog('v', 5);
  for (let n = 0; n < 12; n += 1) {
    audit.write({ operatorId: n % 2 === 0 ? 'a' : 'b', action: `act-${n}`, targetType: 't', requestId: `r-${n}`, success: n % 3 === 0, now: n });
  }
  assert.equal(audit.size, 5, 'the oldest records are evicted');
  const all = audit.list();
  assert.equal(all[0].action, 'act-11', 'newest first');
  assert.ok(audit.list({ operatorId: 'a' }).every((record) => record.operatorId === 'a'));
  assert.ok(audit.list({ success: true }).every((record) => record.success));
  assert.equal(audit.list({}, 2).length, 2);
  assert.equal(audit.list({}, 10_000).length, 5, 'the limit is clamped');
});

void test('the overview exposes operator-safe data only', () => {
  // Milestone 11.25: no private player data, and no moderation surface.
  const service = new OperationsService({
    server: () => ({
      serverId: 's-1', region: 'lax', version: 'v1', uptimeSeconds: 10, roomCount: 1, playerCount: 2,
      capacity: { maxPlayers: 250, maxRooms: 10 }, draining: false, ready: true, readinessReasons: [],
      eventLoopDelayMs: 1.5, memoryRssBytes: 1024
    }),
    rooms: () => [{ roomId: 'main', population: 2, owningServerId: 's-1', status: 'active', activeCabinetCount: 1, createdAt: 5 }],
    cabinets: () => [
      { cabinetId: 'c-1', zoneId: 'z', gameId: 'g', state: 'in-use', occupantPublicId: 'public-1', enabled: true, maintenance: false, failureCount: 0, lastSuccessfulSessionAt: null },
      { cabinetId: 'c-2', zoneId: 'z', gameId: null, state: 'available', occupantPublicId: null, enabled: true, maintenance: false, failureCount: 0, lastSuccessfulSessionAt: null }
    ],
    dependencies: () => [{ name: 'redis', required: false, ready: true, detail: null }],
    plugins: () => ({ total: 1, started: 1, failed: 0, disabled: 0, failures: [] }),
    emulatorAdapters: () => [{ adapterId: 'emulatorjs', platforms: ['psx'] }],
    registry: () => ({ cabinetDefinitions: 39, zones: 6, gameDefinitions: 29 }),
    featureFlags: () => ({ 'new-thing': true }),
    activeGameSessions: () => 1,
    queues: () => []
  }, 'deploy-1');

  const overview = service.overview(1_000);
  assert.equal(overview.totals.activeCabinets, 1);
  assert.equal(overview.deploymentVersion, 'deploy-1');
  assert.equal(overview.replay.supported, false, 'replay must not claim support it does not have');
  assert.equal(overview.totals.pendingCompetitiveVerifications, 0);

  // No chat, message, or moderation field may exist anywhere in the payload.
  const serialized = JSON.stringify(overview).toLowerCase();
  for (const forbidden of ['chat', 'message', 'moderation', 'ban', 'report', 'email', 'wallet', 'password', 'token']) {
    assert.ok(!serialized.includes(forbidden), `overview must not contain "${forbidden}"`);
  }
});
