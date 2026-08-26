import assert from 'node:assert/strict';
import test from 'node:test';
import type { ArcadePluginManifest } from '../shared/plugin-contracts.js';
import { createLogger } from '../server/src/logging/logger.js';
import { PluginManager, type ArcadePlugin, type PluginContext, type PluginStopReason } from '../server/src/plugins/plugin-manager.js';
import { InMemoryPluginStorage } from '../server/src/plugins/plugin-storage.js';

const manifest: ArcadePluginManifest = { id: 'test-plugin', name: 'Test', version: '1.0.0', apiVersion: '11.1', entrypoints: {},
  permissions: ['register:dashboard-widget'], capabilities: ['dashboard-widget'] };

class TestPlugin implements ArcadePlugin {
  context?: PluginContext; stopped = false; disposed = false;
  constructor(readonly manifest: ArcadePluginManifest, private readonly permissionFailure = false) {}
  async initialize(context: PluginContext): Promise<void> { this.context = context;context.register(this.permissionFailure ? 'api-route' : 'dashboard-widget', 'widget', {}); }
  async start(): Promise<void> {}
  async stop(_reason: PluginStopReason): Promise<void> { this.stopped = true; }
  async dispose(): Promise<void> { this.disposed = true; }
}

void test('valid approved plugin starts, registers capability, stops, and disposes', async () => {
  const manager = new PluginManager(createLogger({ test: true }));const plugin = new TestPlugin(manifest);
  const record = await manager.install(manifest, () => plugin);
  assert.equal(record.status, 'started');assert.equal(manager.registrationsFor('dashboard-widget').has('widget'), true);
  await manager.disposeAll();assert.equal(plugin.stopped, true);assert.equal(plugin.disposed, true);
});

void test('manifest API versions and duplicate IDs are rejected', async () => {
  const manager = new PluginManager(createLogger({ test: true }));
  await assert.rejects(manager.install({ ...manifest, apiVersion: '99.0' }, (value) => new TestPlugin(value)), /Unsupported/);
  await manager.install(manifest, (value) => new TestPlugin(value));
  await assert.rejects(manager.install(manifest, (value) => new TestPlugin(value)), /Duplicate/);
});

void test('plugin permissions are enforced and noncritical failure does not crash startup', async () => {
  const manager = new PluginManager(createLogger({ test: true }));
  const record = await manager.install(manifest, (value) => new TestPlugin(value, true));
  assert.equal(record.status, 'failed');assert.match(record.error ?? '', /lacks permission/);
});

void test('plugin storage is namespaced, bounded, and validates keys', async () => {
  const left = new InMemoryPluginStorage('left', { maxKeys: 1, maxValueBytes: 32 });
  const right = new InMemoryPluginStorage('right', { maxKeys: 1, maxValueBytes: 32 });
  await left.set('state', { value: 1 });await right.set('state', { value: 2 });
  assert.deepEqual(await left.get('state'), { value: 1 });assert.deepEqual(await right.get('state'), { value: 2 });
  await assert.rejects(left.set('extra', true), /key quota/);await assert.rejects(left.set('../bad', true), /Invalid/);
});
