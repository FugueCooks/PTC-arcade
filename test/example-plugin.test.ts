import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PLUGIN_API_VERSION, validateManifest } from '../server/src/plugins/plugin-manifest.js';
import { InMemoryPluginStorageBackend, PluginStorage } from '../server/src/plugins/plugin-storage.js';
import { PluginHost } from '../server/src/plugins/plugin-host.js';
import type { PluginHostServices } from '../server/src/plugins/plugin-context.js';
import { importBrowserModule } from './helpers/browser-module.js';

const { createInfoKioskPlugin } = await importBrowserModule<any>('plugins/example-info-kiosk/server.js');
const { createInfoKioskClient } = await importBrowserModule<any>('plugins/example-info-kiosk/client.js');

let population = 3;
const services: PluginHostServices = {
  safeProfile: (id) => ({ publicPlayerId: id, displayName: 'PLAYER', avatarId: 'neon-capsule' }),
  roomState: (roomId) => ({ roomId, population, activeCabinetIds: [] }),
  emitRoomEvent: () => undefined
};

void test('the example plugin manifest is valid against the shipped API version', async () => {
  const raw: unknown = JSON.parse(await readFile(path.resolve(process.cwd(), 'plugins/example-info-kiosk/manifest.json'), 'utf8'));
  const result = validateManifest(raw, PLUGIN_API_VERSION);
  assert.deepEqual(result.problems, []);
  assert.equal(result.manifest?.id, 'example-info-kiosk');
  assert.equal(result.manifest?.critical, undefined, 'the example must not be critical');
});

void test('the example plugin asks for no more than it uses', async () => {
  // Milestone 11.12 exists to validate the architecture, so the reference
  // plugin must model least privilege rather than requesting everything.
  const raw = JSON.parse(await readFile(path.resolve(process.cwd(), 'plugins/example-info-kiosk/manifest.json'), 'utf8')) as { permissions: string[] };
  assert.deepEqual([...raw.permissions].sort(), [
    'read:room-state', 'register:dashboard-widget', 'register:world-interaction', 'write:plugin-storage'
  ]);
  const source = await readFile(path.resolve(process.cwd(), 'plugins/example-info-kiosk/server.js'), 'utf8');
  // The reference plugin must demonstrate that a plugin needs none of this.
  for (const forbidden of ['process.env', 'require(', 'node:fs', 'node:child_process', 'fetch(', 'eval(']) {
    assert.ok(!source.includes(forbidden), `the example plugin must not use ${forbidden}`);
  }
});

void test('the example plugin runs its whole lifecycle and counts views', async () => {
  const backend = new InMemoryPluginStorageBackend();
  const host = new PluginHost({ services, storageBackend: backend });
  const plugin = createInfoKioskPlugin();
  assert.deepEqual(host.install({ plugin, configuration: { greeting: 'HELLO ARCADE' } }), { ok: true, problems: [] });

  await host.startAll();
  assert.equal(host.statusOf('example-info-kiosk'), 'started');

  const first = await plugin.view('main');
  assert.equal(first.greeting, 'HELLO ARCADE');
  assert.equal(first.population, 3);
  assert.equal(first.views, 1);

  population = 7;
  const second = await plugin.view('main');
  assert.equal(second.views, 2, 'the counter must persist across views');
  assert.equal(second.population, 7, 'room state must be read live, not cached at start');

  const registrations = host.get('example-info-kiosk')?.context?.registrations;
  assert.deepEqual(registrations?.worldInteractions, ['info-kiosk']);
  assert.deepEqual(registrations?.dashboardWidgets, ['info-kiosk-views']);

  await host.stopAll();
  assert.equal(host.statusOf('example-info-kiosk'), 'disposed');
});

void test('the example plugin honours its configuration schema defaults', async () => {
  const host = new PluginHost({ services });
  const plugin = createInfoKioskPlugin();
  host.install({ plugin });
  await host.startAll();
  const view = await plugin.view('main');
  assert.equal(view.greeting, 'WELCOME TO THE PTC ARCADE', 'the declared default must apply');
  await host.stopAll();
});

void test('showPopulation false stops the plugin reading room state at all', async () => {
  const host = new PluginHost({ services });
  const plugin = createInfoKioskPlugin();
  host.install({ plugin, configuration: { showPopulation: false } });
  await host.startAll();
  assert.equal((await plugin.view('main')).population, null);
  await host.stopAll();
});

void test('bad configuration is refused before the plugin ever initializes', async () => {
  const host = new PluginHost({ services });
  const plugin = createInfoKioskPlugin();
  const result = host.install({ plugin, configuration: { refreshSeconds: 9_999 } });
  assert.equal(result.ok, false);
  assert.match(result.problems[0], /above its maximum/);
  assert.equal(host.size, 0);
});

void test('the example plugin stores only inside its own namespace', async () => {
  const backend = new InMemoryPluginStorageBackend();
  const host = new PluginHost({ services, storageBackend: backend });
  const plugin = createInfoKioskPlugin();
  host.install({ plugin });
  await host.startAll();
  await plugin.view('main');

  const own = new PluginStorage('example-info-kiosk', backend);
  assert.deepEqual(await own.keys(), ['view-count']);
  const neighbour = new PluginStorage('some-other-plugin', backend);
  assert.deepEqual(await neighbour.keys(), [], 'no key may land outside the plugin namespace');

  await host.uninstall('example-info-kiosk');
  assert.deepEqual(await own.keys(), []);
});

void test('the example client renders without touching the DOM when unmounted', () => {
  const client = createInfoKioskClient();
  const text = client.render({ greeting: 'HI', population: 4, views: 2 });
  assert.match(text, /HI/);
  assert.match(text, /4 PLAYER\(S\)/);
  assert.match(text, /VIEWED 2 TIME\(S\)/);
  assert.ok(!client.render({ greeting: 'HI', population: null, views: 1 }).includes('PLAYER(S)'));
});
