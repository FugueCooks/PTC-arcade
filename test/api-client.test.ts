import assert from 'node:assert/strict';
import test from 'node:test';
import { importBrowserModule } from './helpers/browser-module.js';

const { ArcadeApiClient, ArcadeApiError } = await importBrowserModule<any>('client/api/api-client.js');

/** Scriptable fetch stand-in that records every call it receives. */
function stubFetch(responses: Array<{ status?: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; init: any }> = [];
  let at = 0;
  const impl = async (url: string, init: any) => {
    calls.push({ url, init });
    const spec = responses[Math.min(at, responses.length - 1)];
    at += 1;
    const status = spec.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers({ 'x-request-id': 'req-1', ...(spec.headers ?? {}) }),
      json: async () => spec.body ?? { ok: true, data: null }
    };
  };
  return { impl, calls, get count() { return at; } };
}

const success = (data: unknown, meta?: unknown) => ({ ok: true, apiVersion: 'v1', requestId: 'req-1', data, meta });

void test('the client centralizes base URL, credentials, and query building', async () => {
  const stub = stubFetch([{ body: success([{ id: 'a' }]) }]);
  const client = new ArcadeApiClient({ baseUrl: '/api/v1', fetchImpl: stub.impl });

  const result = await client.cabinets({ zoneId: 'megaman-room', limit: 10, cursor: undefined });
  assert.deepEqual(result.data, [{ id: 'a' }]);
  assert.equal(result.requestId, 'req-1');

  const [call] = stub.calls;
  assert.equal(call.url, '/api/v1/cabinets?zoneId=megaman-room&limit=10', 'empty values must be dropped from the query');
  assert.equal(call.init.credentials, 'same-origin');
});

void test('errors normalize to one type carrying the request ID', async () => {
  const stub = stubFetch([{
    status: 404,
    body: { ok: false, error: { code: 'not-found', message: 'No such cabinet.', details: ['id'] } }
  }]);
  const client = new ArcadeApiClient({ fetchImpl: stub.impl, retries: 0 });

  await assert.rejects(() => client.cabinet('ghost'), (error: any) => {
    assert.ok(error instanceof ArcadeApiError);
    assert.equal(error.code, 'not-found');
    assert.equal(error.status, 404);
    assert.equal(error.requestId, 'req-1');
    assert.deepEqual(error.details, ['id']);
    assert.equal(error.retryable, false, 'a 404 must not be retried');
    return true;
  });
});

void test('session expiry is reported once, through the client', async () => {
  // Milestone 11.40 test 48.
  const stub = stubFetch([{ status: 401, body: { ok: false, error: { code: 'unauthorized', message: 'gone' } } }]);
  let expiries = 0;
  const client = new ArcadeApiClient({ fetchImpl: stub.impl, retries: 0, onSessionExpired: () => { expiries += 1; } });

  await assert.rejects(() => client.platform(), /Session expired/);
  assert.equal(expiries, 1, 'the client must surface expiry rather than each caller detecting 401');
});

void test('only safe or keyed requests are retried', async () => {
  const readStub = stubFetch([
    { status: 503, body: { ok: false, error: { code: 'internal-error', message: 'down' } } },
    { body: success('recovered') }
  ]);
  const client = new ArcadeApiClient({ fetchImpl: readStub.impl, retries: 2 });
  assert.equal((await client.platform()).data, 'recovered');
  assert.equal(readStub.count, 2, 'a failed GET is retried');

  // An unkeyed write is sent exactly once, even on a retryable status.
  const writeStub = stubFetch([{ status: 503, body: { ok: false, error: { code: 'internal-error', message: 'down' } } }]);
  const writeClient = new ArcadeApiClient({ fetchImpl: writeStub.impl, retries: 3 });
  await assert.rejects(() => writeClient.request('things', { method: 'POST', body: {} }));
  assert.equal(writeStub.count, 1, 'a non-idempotent write must never be retried');

  // A write the caller marked idempotent may be retried.
  const keyedStub = stubFetch([
    { status: 500, body: { ok: false, error: { code: 'internal-error', message: 'down' } } },
    { body: success('done') }
  ]);
  const keyedClient = new ArcadeApiClient({ fetchImpl: keyedStub.impl, retries: 2 });
  assert.equal((await keyedClient.request('things', { method: 'POST', body: {}, idempotencyKey: 'abcdefgh' })).data, 'done');
  assert.equal(keyedStub.calls[0].init.headers['idempotency-key'], 'abcdefgh');
});

void test('a 4xx is never retried', async () => {
  const stub = stubFetch([{ status: 400, body: { ok: false, error: { code: 'bad-request', message: 'nope' } } }]);
  const client = new ArcadeApiClient({ fetchImpl: stub.impl, retries: 3 });
  await assert.rejects(() => client.platform());
  assert.equal(stub.count, 1);
});

void test('concurrent identical reads share one request', async () => {
  let resolveRequest: (value: unknown) => void = () => undefined;
  const pending = new Promise((resolve) => { resolveRequest = resolve; });
  let calls = 0;
  const client = new ArcadeApiClient({
    fetchImpl: async () => {
      calls += 1;
      await pending;
      return { ok: true, status: 200, headers: new Headers({ 'x-request-id': 'r' }), json: async () => success('shared') };
    }
  });

  const both = Promise.all([client.platform(), client.platform()]);
  resolveRequest(null);
  const [first, second] = await both;
  assert.equal(calls, 1, 'duplicate in-flight reads must be deduplicated');
  assert.equal(first.data, 'shared');
  assert.equal(second.data, 'shared');

  // Once settled, a later read issues a fresh request.
  await client.platform();
  assert.equal(calls, 2);
});

void test('cancellation propagates and is not reported as an API failure', async () => {
  const controller = new AbortController();
  const client = new ArcadeApiClient({
    fetchImpl: (_url: string, init: any) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    })
  });
  const pending = client.platform(controller.signal);
  controller.abort();
  await assert.rejects(() => pending, (error: any) => {
    assert.ok(!(error instanceof ArcadeApiError), 'a caller abort is not an API error');
    return true;
  });
});

void test('a network failure becomes a retryable client error', async () => {
  const client = new ArcadeApiClient({
    fetchImpl: async () => { throw new Error('connection refused'); },
    retries: 0
  });
  await assert.rejects(() => client.platform(), (error: any) => {
    assert.ok(error instanceof ArcadeApiError);
    assert.equal(error.code, 'network-error');
    assert.equal(error.retryable, true);
    return true;
  });
});

void test('paginate walks every page', async () => {
  const pages = [
    { body: success([{ id: 'a' }, { id: 'b' }], { nextCursor: 'b' }) },
    { body: success([{ id: 'c' }], { nextCursor: null }) }
  ];
  const stub = stubFetch(pages);
  const client = new ArcadeApiClient({ fetchImpl: stub.impl });

  const seen: string[] = [];
  for await (const item of client.paginate('cabinets', { limit: 2 })) seen.push(item.id);
  assert.deepEqual(seen, ['a', 'b', 'c']);
  assert.match(stub.calls[1].url, /cursor=b/);
});

void test('the client is the only place the app talks to the API', async () => {
  // Milestone 11.32: no raw fetch scattered through the application. Asserted
  // against the client's own source so the rule cannot quietly erode.
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const source = await readFile(path.resolve(process.cwd(), 'client/api/api-client.js'), 'utf8');
  // Exactly one call site, held behind the injectable fetchImpl.
  assert.equal((source.match(/globalThis\.fetch/g) ?? []).length, 1);
  assert.ok(!/fetch\('\/api/.test(source), 'the client must not hardcode an API path');
});
