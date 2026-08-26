import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PLUGIN_API_VERSION, isApiVersionCompatible, satisfiesDependency, validateConfiguration, validateManifest } from '../server/src/plugins/plugin-manifest.js';
import { PLUGIN_PERMISSIONS, PluginPermissionError, PluginPermissionSet } from '../server/src/plugins/plugin-permissions.js';
import { DEFAULT_PLUGIN_QUOTA, InMemoryPluginStorageBackend, PluginQuotaError, PluginStorage } from '../server/src/plugins/plugin-storage.js';
import { FilesystemPluginStorageBackend } from '../server/src/plugins/filesystem-plugin-storage.js';
import { CriticalPluginError, PluginHost, type ArcadePlugin } from '../server/src/plugins/plugin-host.js';
import type { PluginContext, PluginHostServices } from '../server/src/plugins/plugin-context.js';

const services: PluginHostServices = {
  safeProfile: (id) => ({ publicPlayerId: id, displayName: 'PLAYER', avatarId: 'neon-capsule' }),
  roomState: (roomId) => ({ roomId, population: 3, activeCabinetIds: ['crash-bandicoot'] }),
  emitRoomEvent: () => undefined
};

const baseManifest = {
  id: 'test-plugin', name: 'Test Plugin', version: '1.0.0', apiVersion: PLUGIN_API_VERSION,
  entrypoints: { server: 'server.js' },
  permissions: ['read:room-state', 'write:plugin-storage'],
  capabilities: ['world-interaction']
};

/** Minimal plugin whose lifecycle calls are recorded, with optional failures. */
function fakePlugin(manifest: unknown, failures: Partial<Record<'initialize' | 'start' | 'stop' | 'dispose', boolean>> = {}) {
  const calls: string[] = [];
  const plugin: ArcadePlugin & { calls: string[] } = {
    manifest,
    calls,
    initialize() { calls.push('initialize'); if (failures.initialize) throw new Error('initialize exploded'); },
    start() { calls.push('start'); if (failures.start) throw new Error('start exploded'); },
    stop() { calls.push('stop'); if (failures.stop) throw new Error('stop exploded'); },
    dispose() { calls.push('dispose'); if (failures.dispose) throw new Error('dispose exploded'); }
  };
  return plugin;
}

void test('a valid plugin loads through the full lifecycle', async () => {
  // Milestone 11.40 test 9.
  const host = new PluginHost({ services });
  const plugin = fakePlugin(baseManifest);
  assert.deepEqual(host.install({ plugin }), { ok: true, problems: [] });
  assert.equal(host.statusOf('test-plugin'), 'validated');

  await host.startAll();
  assert.equal(host.statusOf('test-plugin'), 'started');
  assert.deepEqual(plugin.calls, ['initialize', 'start']);

  await host.stopAll();
  assert.equal(host.statusOf('test-plugin'), 'disposed');
  assert.deepEqual(plugin.calls, ['initialize', 'start', 'stop', 'dispose']);
});

void test('an invalid manifest is rejected with reasons', () => {
  // Milestone 11.40 test 10.
  for (const [overrides, expected] of [
    [{ id: 'Bad Id' }, /id must match/],
    [{ version: 'one-point-oh' }, /semantic versioning/],
    [{ permissions: ['do:anything'] }, /known permissions/],
    [{ capabilities: [] }, /non-empty array/],
    [{ entrypoints: {} }, /client or server/],
    [{ name: '' }, /name must be/]
  ] as Array<[Record<string, unknown>, RegExp]>) {
    const result = validateManifest({ ...baseManifest, ...overrides });
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((problem) => expected.test(problem)), `${expected} not in ${result.problems.join('; ')}`);
  }
  assert.equal(validateManifest(null).ok, false);
  assert.equal(validateManifest([]).ok, false);
});

void test('an entrypoint cannot escape the plugin directory or name a URL', () => {
  // This is the check that keeps plugin installation from meaning arbitrary
  // remote code execution.
  for (const server of ['../../../etc/passwd', '/etc/passwd.js', 'https://evil.example/payload.js',
    'file:///tmp/x.js', './relative.js', 'sub/../../escape.js', 'payload.txt', 'payload.js.exe']) {
    const result = validateManifest({ ...baseManifest, entrypoints: { server } });
    assert.equal(result.ok, false, `${server} must be refused`);
    assert.ok(result.problems.some((problem) => /entrypoints\.server/.test(problem)));
  }
  assert.equal(validateManifest({ ...baseManifest, entrypoints: { server: 'nested/dir/server.mjs' } }).ok, true);
});

void test('an unsupported API version is rejected', () => {
  // Milestone 11.40 test 11.
  assert.equal(validateManifest({ ...baseManifest, apiVersion: '2.0.0' }, '1.0.0').ok, false);
  assert.equal(validateManifest({ ...baseManifest, apiVersion: '1.5.0' }, '1.0.0').ok, false, 'a plugin cannot need a newer minor');
  assert.equal(validateManifest({ ...baseManifest, apiVersion: '1.0.0' }, '1.4.0').ok, true, 'an older plugin still loads');

  assert.equal(isApiVersionCompatible('1.0.0', '1.0.0'), true);
  assert.equal(isApiVersionCompatible('1.2.3', '1.2.4'), true);
  assert.equal(isApiVersionCompatible('1.2.5', '1.2.4'), false);
  assert.equal(isApiVersionCompatible('0.9.0', '1.0.0'), false);
});

void test('a missing or unsatisfied dependency is rejected', () => {
  // Milestone 11.40 test 12.
  const host = new PluginHost({ services });
  const dependent = { ...baseManifest, id: 'dependent', dependencies: [{ id: 'base-plugin', version: '^1.2.0' }] };
  assert.match(host.install({ plugin: fakePlugin(dependent) }).problems[0], /missing dependency base-plugin/);

  host.install({ plugin: fakePlugin({ ...baseManifest, id: 'base-plugin', version: '1.1.0' }) });
  assert.match(host.install({ plugin: fakePlugin(dependent) }).problems[0], /does not satisfy/);

  const satisfied = new PluginHost({ services });
  satisfied.install({ plugin: fakePlugin({ ...baseManifest, id: 'base-plugin', version: '1.3.0' }) });
  assert.equal(satisfied.install({ plugin: fakePlugin(dependent) }).ok, true);

  assert.equal(satisfiesDependency('1.3.0', '^1.2.0'), true);
  assert.equal(satisfiesDependency('2.0.0', '^1.2.0'), false);
  assert.equal(satisfiesDependency('1.2.0', '1.2.0'), true);
  assert.equal(satisfiesDependency('1.2.1', '1.2.0'), false);
});

void test('plugin permissions are enforced at the point of use', async () => {
  // Milestone 11.40 test 13.
  const host = new PluginHost({ services });
  let captured: PluginContext | undefined;
  host.install({
    plugin: {
      manifest: { ...baseManifest, permissions: ['read:room-state'] },
      initialize(context) { captured = context; },
      start() { /* nothing */ }, stop() { /* nothing */ }, dispose() { /* nothing */ }
    }
  });
  await host.startAll();
  assert.ok(captured);

  // Granted.
  assert.equal(captured.readRoomState('main')?.population, 3);
  // Not granted: every one of these must throw rather than silently no-op.
  assert.throws(() => captured!.requireStorage(), PluginPermissionError);
  assert.throws(() => captured!.readSafeProfile('p-1'), PluginPermissionError);
  assert.throws(() => captured!.registerApiRoute('thing'), PluginPermissionError);
  assert.throws(() => captured!.registerSocketEvent('thing'), PluginPermissionError);
  assert.throws(() => captured!.emitRoomEvent('main', { type: 'x', payload: {} }), PluginPermissionError);
  assert.throws(() => captured!.registerCabinetType('x'), PluginPermissionError);
});

void test('the permission list grants nothing dangerous', () => {
  // Milestone 11.10: no permission may exist for a database or Redis client,
  // the filesystem, cookies, wallet signatures, keys, secrets, ROMs, or tokens.
  // Compared as whole words: "profile" legitimately contains "file", and a
  // naive substring check would flag read:player-safe-profile.
  const tokensOf = (permission: string): string[] => permission.toLowerCase().split(/[:\-]/);
  for (const forbidden of ['database', 'db', 'redis', 'sql', 'filesystem', 'file', 'fs', 'cookie', 'wallet',
    'signature', 'key', 'keys', 'secret', 'secrets', 'env', 'rom', 'roms', 'token', 'tokens', 'exec', 'shell', 'eval']) {
    const offender = PLUGIN_PERMISSIONS.find((permission) => tokensOf(permission).includes(forbidden));
    assert.equal(offender, undefined, `no permission may grant "${forbidden}" (found ${offender ?? ''})`);
  }
  const set = new PluginPermissionSet('p', ['read:room-state']);
  assert.equal(set.has('read:room-state'), true);
  assert.equal(set.has('register:api-route'), false);
});

void test('plugin storage is namespaced and cannot address another plugin', async () => {
  // Milestone 11.40 test 14.
  const backend = new InMemoryPluginStorageBackend();
  const first = new PluginStorage('plugin-one', backend);
  const second = new PluginStorage('plugin-two', backend);

  await first.set('shared-key', 'from-one');
  await second.set('shared-key', 'from-two');
  assert.equal(await first.get('shared-key'), 'from-one', 'identical key names must not collide');
  assert.equal(await second.get('shared-key'), 'from-two');
  assert.deepEqual(await first.keys(), ['shared-key']);

  // The prefix is applied by the storage layer, so there is no key a plugin can
  // craft that reaches another namespace.
  for (const hostile of ['../plugin-two/shared-key', 'arcade:plugin:plugin-two:shared-key', 'a:b', '']) {
    await assert.rejects(() => first.set(hostile, 'x'), /invalid storage key/);
  }

  await first.clear();
  assert.deepEqual(await first.keys(), []);
  assert.equal(await second.get('shared-key'), 'from-two', 'clearing one namespace must not touch another');
});

void test('plugin storage enforces its quotas', async () => {
  const storage = new PluginStorage('quota-plugin', new InMemoryPluginStorageBackend(), { maxKeys: 3, maxValueBytes: 64, maxTotalBytes: 128 });
  await storage.set('a', 'x');
  await storage.set('b', 'y');
  await storage.set('c', 'z');
  await assert.rejects(() => storage.set('d', 'w'), PluginQuotaError);
  // Replacing an existing key stays within the key quota.
  await storage.set('a', 'updated');
  await assert.rejects(() => storage.set('a', 'x'.repeat(200)), PluginQuotaError);

  const total = new PluginStorage('total-plugin', new InMemoryPluginStorageBackend(), { maxKeys: 100, maxValueBytes: 1_000, maxTotalBytes: 60 });
  await total.set('one', 'x'.repeat(20));
  await assert.rejects(() => total.set('two', 'y'.repeat(50)), PluginQuotaError);
  assert.ok(DEFAULT_PLUGIN_QUOTA.maxTotalBytes > 0);
});

void test('plugin storage rejects values that are not plain JSON', async () => {
  const storage = new PluginStorage('json-plugin', new InMemoryPluginStorageBackend());
  await assert.rejects(() => storage.set('fn', (() => undefined) as never), /plain JSON/);
  await storage.set('ok', { nested: [1, true, null] });
  assert.deepEqual(await storage.get('ok'), { nested: [1, true, null] });
  assert.equal(await storage.get('absent'), undefined);
});

void test('the filesystem backend keeps keys inside its root', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'plugin-storage-'));
  try {
    const storage = new PluginStorage('fs-plugin', new FilesystemPluginStorageBackend(root));
    await storage.set('greeting', 'hello');
    assert.equal(await storage.get('greeting'), 'hello');
    assert.deepEqual(await storage.keys(), ['greeting']);
    assert.equal((await storage.usage()).keys, 1);

    await storage.delete('greeting');
    assert.equal(await storage.get('greeting'), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('a noncritical plugin failure does not stop the others', async () => {
  // Milestone 11.40 test 15.
  const host = new PluginHost({ services });
  const broken = fakePlugin({ ...baseManifest, id: 'broken-plugin' }, { start: true });
  const healthy = fakePlugin({ ...baseManifest, id: 'healthy-plugin' });
  host.install({ plugin: broken });
  host.install({ plugin: healthy });

  await host.startAll();
  assert.equal(host.statusOf('broken-plugin'), 'failed');
  assert.equal(host.statusOf('healthy-plugin'), 'started', 'one failure must not stop the next plugin');

  const health = host.health();
  assert.equal(health.failed, 1);
  assert.equal(health.started, 1);
  assert.match(health.failures[0].error, /start exploded/);
});

void test('a critical plugin failure is raised so startup can refuse', async () => {
  const host = new PluginHost({ services });
  host.install({ plugin: fakePlugin({ ...baseManifest, id: 'critical-plugin', critical: true }, { initialize: true }) });
  await assert.rejects(() => host.startAll(), CriticalPluginError);
  assert.equal(host.statusOf('critical-plugin'), 'failed');
});

void test('plugin cleanup runs, and uninstall erases the namespace', async () => {
  // Milestone 11.40 test 16.
  const backend = new InMemoryPluginStorageBackend();
  const host = new PluginHost({ services, storageBackend: backend });
  const plugin = fakePlugin({ ...baseManifest, id: 'cleanup-plugin', permissions: ['write:plugin-storage'] });
  host.install({ plugin });
  await host.startAll();

  const storage = new PluginStorage('cleanup-plugin', backend);
  await storage.set('scratch', 'value');
  assert.deepEqual(await storage.keys(), ['scratch']);

  assert.equal(await host.uninstall('cleanup-plugin'), true);
  assert.deepEqual(plugin.calls, ['initialize', 'start', 'stop', 'dispose']);
  assert.deepEqual(await storage.keys(), [], 'uninstall must erase plugin storage');
  assert.equal(host.get('cleanup-plugin'), undefined);
});

void test('duplicate registrations are rejected', () => {
  // Milestone 11.40 test 17.
  const host = new PluginHost({ services });
  assert.equal(host.install({ plugin: fakePlugin(baseManifest) }).ok, true);
  const second = host.install({ plugin: fakePlugin(baseManifest) });
  assert.equal(second.ok, false);
  assert.match(second.problems[0], /already installed/);
  assert.equal(host.size, 1);
});

void test('an unapproved plugin is never initialized', async () => {
  // Milestone 11.7: plugins must be installed AND approved by the operator.
  const host = new PluginHost({ services });
  const plugin = fakePlugin({ ...baseManifest, id: 'unapproved' });
  host.install({ plugin, approved: false });
  assert.equal(host.statusOf('unapproved'), 'disabled');
  await host.startAll();
  assert.deepEqual(plugin.calls, [], 'unapproved plugin code must never run');
});

void test('configuration is validated against the declared schema', () => {
  const schema = {
    type: 'object' as const,
    properties: {
      greeting: { type: 'string' as const, maxLength: 10, default: 'HI' },
      count: { type: 'number' as const, minimum: 1, maximum: 5 },
      mode: { type: 'string' as const, enum: ['a', 'b'] }
    },
    required: ['count']
  };
  assert.deepEqual(validateConfiguration(schema, { count: 3 }).configuration, { greeting: 'HI', count: 3 });
  assert.equal(validateConfiguration(schema, {}).ok, false, 'a missing required key must fail');
  assert.equal(validateConfiguration(schema, { count: 9 }).ok, false, 'above maximum');
  assert.equal(validateConfiguration(schema, { count: 1, greeting: 'far too long' }).ok, false);
  assert.equal(validateConfiguration(schema, { count: 1, mode: 'c' }).ok, false, 'outside enum');
  assert.equal(validateConfiguration(schema, { count: 1, typo: true }).ok, false, 'unknown keys must be reported');
  assert.equal(validateConfiguration(undefined, { anything: 1 }).ok, true);
});

void test('operator restart and disable act on one plugin only', async () => {
  const host = new PluginHost({ services });
  const first = fakePlugin({ ...baseManifest, id: 'first' });
  const second = fakePlugin({ ...baseManifest, id: 'second' });
  host.install({ plugin: first });
  host.install({ plugin: second });
  await host.startAll();

  assert.equal(await host.disable('first'), true);
  assert.equal(host.statusOf('first'), 'disabled');
  assert.equal(host.statusOf('second'), 'started');

  assert.equal(await host.restart('second'), true);
  assert.equal(host.statusOf('second'), 'started');
  assert.deepEqual(second.calls, ['initialize', 'start', 'stop', 'dispose', 'initialize', 'start']);
  assert.equal(await host.restart('nonexistent'), false);
});

void test('plugin routes and socket events are namespaced so core cannot be shadowed', async () => {
  const host = new PluginHost({ services });
  let captured: PluginContext | undefined;
  host.install({
    plugin: {
      manifest: { ...baseManifest, id: 'router', permissions: ['register:api-route', 'register:socket-event'] },
      initialize(context) { captured = context; },
      start() { /* nothing */ }, stop() { /* nothing */ }, dispose() { /* nothing */ }
    }
  });
  await host.startAll();
  assert.equal(captured!.registerApiRoute('status'), '/api/v1/plugins/router/status');
  // A leading slash cannot be used to climb out of the plugin's namespace.
  assert.equal(captured!.registerApiRoute('/api/auth/login'), '/api/v1/plugins/router/api/auth/login');
  assert.equal(captured!.registerSocketEvent('ping'), 'plugin:router:ping');
});
