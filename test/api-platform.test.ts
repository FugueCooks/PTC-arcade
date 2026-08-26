import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CABINET_REGISTRY } from '../server/src/cabinets/cabinet-registry.js';
import { CabinetIndex } from '../server/src/cabinets/cabinet-index.js';
import { ZoneRegistry } from '../server/src/cabinets/zone-registry.js';
import { loadGameRegistry } from '../server/src/games/game-registry-service.js';
import { CabinetCatalogService, GameCatalogService } from '../server/src/services/catalog-service.js';
import { installCatalogRoutes } from '../server/src/http/api/v1/catalog-routes.js';
import { asBodyParserError, installApiNotFound, IdempotencyStore, paginate } from '../server/src/http/api/middleware/api-context.js';
import { toCabinetDetailDto, toGameDetailDto } from '../server/src/http/api/dto/catalog-dto.js';
import { loadServerConfig } from '../server/src/config.js';
import { EventBus } from '../server/src/events/event-bus.js';
import { JobQueue, backoffFor } from '../server/src/jobs/job-queue.js';

async function bootApi() {
  const app = express();
  const index = new CabinetIndex(CABINET_REGISTRY);
  const cabinets = new CabinetCatalogService(index, new ZoneRegistry(index));
  const games = new GameCatalogService(loadGameRegistry().registry);

  installCatalogRoutes(app, loadServerConfig({ ...process.env, NODE_ENV: 'test' }), {
    cabinets, games,
    emulatorAdapters: () => [{ adapterId: 'emulatorjs', platforms: ['psx'] }],
    log: () => undefined
  });
  // A second /api/v1 router, to prove the catalogue does not swallow siblings.
  app.get('/api/v1/sibling/ping', (_request, response) => { response.json({ ok: true, data: 'pong' }); });
  installApiNotFound(app, () => undefined);

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}/api/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

void test('the platform endpoint reports honest capability', async () => {
  const api = await bootApi();
  try {
    const response = await fetch(`${api.base}/platform`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-api-version'), 'v1');
    assert.ok(response.headers.get('x-request-id'), 'every response carries a request ID');
    const body = await response.json() as { ok: boolean; data: { cabinetDefinitions: number; replaySupported: boolean } };
    assert.equal(body.ok, true);
    assert.equal(body.data.cabinetDefinitions, 39);
    assert.equal(body.data.replaySupported, false, 'the API must not claim replay support');
  } finally {
    await api.close();
  }
});

void test('a versioned router does not swallow sibling namespaces', async () => {
  // The catalogue previously mounted a catch-all at /api/v1, which hid the
  // operations API entirely. This asserts the fix directly.
  const api = await bootApi();
  try {
    assert.equal((await fetch(`${api.base}/sibling/ping`)).status, 200);
    const missing = await fetch(`${api.base}/definitely-not-a-route`);
    assert.equal(missing.status, 404);
    const body = await missing.json() as { ok: boolean; error: { code: string } };
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'not-found');
  } finally {
    await api.close();
  }
});

void test('request schemas validate and clamp rather than trusting input', async () => {
  // Milestone 11.40 test 42.
  const api = await bootApi();
  try {
    const clamped = await (await fetch(`${api.base}/cabinets?limit=99999`)).json() as { meta: { limit: number } };
    assert.equal(clamped.meta.limit, 200, 'an oversized limit is clamped, never honoured');

    const nonsense = await (await fetch(`${api.base}/cabinets?limit=not-a-number&sort=DROP+TABLE&order=sideways`)).json() as { ok: boolean; meta: { limit: number } };
    assert.equal(nonsense.ok, true, 'garbage query values fall back to defaults');
    assert.equal(nonsense.meta.limit, 50);

    const bad = await fetch(`${api.base}/world/active-zones?x=abc&z=1`);
    assert.equal(bad.status, 400);
    assert.equal(((await bad.json()) as { error: { code: string } }).error.code, 'bad-request');
  } finally {
    await api.close();
  }
});

void test('response DTOs exclude internal fields', async () => {
  // Milestone 11.40 test 43. The DTO is an explicit allowlist, so a field added
  // to a domain type cannot leak; this asserts that for a real definition.
  const definition = { ...CABINET_REGISTRY[0], metadata: { internalNote: 'do not ship' }, pluginId: 'secret-plugin' };
  const dto = toCabinetDetailDto(definition);
  assert.equal(Object.hasOwn(dto, 'metadata'), false);
  assert.equal(Object.hasOwn(dto, 'pluginId'), false);
  assert.equal(Object.hasOwn(dto, 'interactionPolicy'), false, 'the raw policy object is not public');
  assert.equal(dto.interactionDistance, definition.interactionPolicy.interactionDistance);

  // Game DTOs must not advertise ROM file names.
  const game = loadGameRegistry().registry.get('crash-bandicoot');
  assert.ok(game);
  const serialized = JSON.stringify(toGameDetailDto(game));
  assert.ok(!serialized.includes('.chd'), 'asset file names must not be exposed');
  assert.ok(!/assetId/.test(serialized));
});

void test('pagination walks the whole collection exactly once', async () => {
  // Milestone 11.40 test 44.
  const api = await bootApi();
  try {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const url = `${api.base}/cabinets?limit=10${cursor ? `&cursor=${cursor}` : ''}`;
      const page = await (await fetch(url)).json() as { data: Array<{ id: string }>; meta: { total: number; nextCursor: string | null } };
      seen.push(...page.data.map((row) => row.id));
      assert.equal(page.meta.total, 39);
      cursor = page.meta.nextCursor;
    } while (cursor !== null);

    assert.equal(seen.length, 39);
    assert.equal(new Set(seen).size, 39, 'no cabinet may appear twice across pages');
  } finally {
    await api.close();
  }
});

void test('pagination handles an unknown cursor without losing the collection', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const page = paginate(items, { limit: 2, cursor: 'nonexistent', sort: null, order: 'asc' });
  // findIndex returns -1, so the page starts at 0 rather than silently skipping.
  assert.deepEqual(page.items.map((item) => item.id), ['a', 'b']);
  assert.equal(page.meta.nextCursor, 'b');
  assert.equal(paginate(items, { limit: 10, cursor: null, sort: null, order: 'asc' }).meta.nextCursor, null);
});

void test('filtering and sorting narrow through indexes', async () => {
  const api = await bootApi();
  try {
    const zone = await (await fetch(`${api.base}/cabinets?zoneId=megaman-room&limit=200`)).json() as { data: Array<{ zoneId: string }>; meta: { total: number } };
    assert.equal(zone.meta.total, 10);
    assert.ok(zone.data.every((row) => row.zoneId === 'megaman-room'));

    const descending = await (await fetch(`${api.base}/cabinets?sort=id&order=desc&limit=3`)).json() as { data: Array<{ id: string }> };
    const ascending = await (await fetch(`${api.base}/cabinets?sort=id&order=asc&limit=3`)).json() as { data: Array<{ id: string }> };
    assert.notDeepEqual(descending.data.map((r) => r.id), ascending.data.map((r) => r.id));

    const missing = await fetch(`${api.base}/cabinets/no-such-cabinet`);
    assert.equal(missing.status, 404);
  } finally {
    await api.close();
  }
});

void test('idempotency returns the first response instead of repeating work', () => {
  // Milestone 11.40 test 45.
  const store = new IdempotencyStore(1_000);
  assert.equal(store.get('key-1'), undefined);
  store.set('key-1', { created: true }, 0);
  assert.deepEqual(store.get('key-1', 500), { created: true });
  assert.equal(store.get('key-1', 2_000), undefined, 'entries expire');

  const bounded = new IdempotencyStore(60_000, 3);
  for (const key of ['a', 'b', 'c', 'd']) bounded.set(key, key);
  assert.ok(bounded.size <= 3, 'the store must stay bounded');
});

void test('the event bus is typed, ordered, and isolates a failing subscriber', () => {
  // Milestone 11.35.
  const failures: string[] = [];
  const bus = new EventBus((event) => failures.push(event));
  const order: string[] = [];

  bus.on('plugin.started', () => order.push('first'));
  bus.on('plugin.started', () => { throw new Error('subscriber exploded'); });
  bus.on('plugin.started', () => order.push('third'));

  bus.emit('plugin.started', { pluginId: 'p', version: '1.0.0' });
  assert.deepEqual(order, ['first', 'third'], 'a throwing subscriber must not starve later ones');
  assert.deepEqual(failures, ['plugin.started']);
  assert.equal(bus.stats().handlerFailures, 1);
  assert.equal(bus.stats().delivered, 2);

  const unsubscribe = bus.on('room.closed', () => order.push('closed'));
  unsubscribe();
  bus.emit('room.closed', { roomId: 'main', reason: 'idle' });
  assert.ok(!order.includes('closed'), 'unsubscribe must actually detach');
  assert.equal(bus.listenerCount('room.closed'), 0);
});

void test('background jobs retry with backoff, then dead-letter', async () => {
  // Milestone 11.36: no infinite retries.
  // A controlled clock: the queue reads one source of time throughout, so
  // retries can be advanced deterministically.
  let clock = 0;
  const queue = new JobQueue({ now: () => clock });
  let attempts = 0;
  queue.register({
    name: 'always-fails',
    maxAttempts: 3,
    process: () => { attempts += 1; throw new Error('nope'); }
  });

  queue.enqueue('always-fails', { id: 1 });
  for (let tick = 0; tick < 10; tick += 1) {
    await queue.runDue();
    clock += 60_000;
  }
  assert.equal(attempts, 3, 'a job must stop after maxAttempts');
  assert.equal(queue.stats().deadLettered, 1);
  assert.equal(queue.stats().depth, 0);
  assert.match(queue.listDeadLetters()[0].lastError ?? '', /nope/);

  assert.ok(backoffFor(1) < backoffFor(2), 'backoff must grow');
  assert.ok(backoffFor(50) <= 5 * 60 * 1_000, 'backoff must stay capped');
});

void test('background jobs are idempotent by key', async () => {
  // Milestone 11.40 test 50.
  const queue = new JobQueue();
  let processed = 0;
  queue.register({ name: 'count', process: () => { processed += 1; } });

  assert.ok(queue.enqueue('count', {}, { idempotencyKey: 'once' }));
  assert.equal(queue.enqueue('count', {}, { idempotencyKey: 'once' }), undefined, 'a duplicate key must not queue twice');
  await queue.runDue();
  assert.equal(processed, 1);

  assert.equal(queue.enqueue('count', {}, { idempotencyKey: 'once' }), undefined, 'a completed key must not run again');
  await queue.runDue();
  assert.equal(processed, 1);
});

void test('the job queue reports its own limitations and shuts down safely', async () => {
  const queue = new JobQueue();
  queue.register({ name: 'noop', process: () => undefined });
  assert.equal(queue.stats().durable, false, 'a non-durable queue must say so');
  assert.throws(() => queue.register({ name: 'noop', process: () => undefined }), /Duplicate job processor/);
  assert.throws(() => queue.enqueue('unregistered', {}), /No processor registered/);

  queue.enqueue('noop', {});
  const result = await queue.stop();
  assert.equal(result.drained, 1);
  assert.equal(queue.enqueue('noop', {}), undefined, 'a stopped queue accepts no new work');
});

void test('operator visibility into dead letters includes clearing a stuck job', async () => {
  const queue = new JobQueue();
  queue.register({ name: 'fails', maxAttempts: 1, process: () => { throw new Error('stuck'); } });
  queue.enqueue('fails', {});
  await queue.runDue();

  const [job] = queue.listDeadLetters();
  assert.ok(job);
  assert.equal(queue.clearDeadLetter(job.id), true);
  assert.equal(queue.stats().deadLettered, 0);
  assert.equal(queue.clearDeadLetter('nonexistent'), false);
});

void test('body-parser failures map to client errors, not server faults', () => {
  // An oversized or malformed body reported as 500 would tell a caller to retry
  // something that can never succeed. Found by probing the running server.
  assert.deepEqual(asBodyParserError({ type: 'entity.too.large' }), {
    code: 'payload-too-large', message: 'Request body is too large.'
  });
  assert.equal(asBodyParserError({ type: 'entity.parse.failed' })?.code, 'bad-request');
  assert.equal(asBodyParserError({ type: 'encoding.unsupported' })?.code, 'bad-request');
  assert.equal(asBodyParserError(new Error('something else')), null);
  assert.equal(asBodyParserError(null), null);
  assert.equal(asBodyParserError('string'), null);
});
