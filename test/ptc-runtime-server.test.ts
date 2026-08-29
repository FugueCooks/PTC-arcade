import assert from 'node:assert/strict';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import { importBrowserModule } from './helpers/browser-module.js';

const { createRuntimeServer } = await importBrowserModule<any>('ptc-runtime/src/server.js');
const { createInstallSecret } = await importBrowserModule<any>('ptc-runtime/src/security.js');
const { PROTOCOL_VERSION } = await importBrowserModule<any>('emulators/ptc-runtime/protocol.js');

const ORIGIN = 'https://ptcarcade.fun';

/** Boots the real server on an ephemeral port, so these are real HTTP assertions. */
async function boot({ dolphin = true }: { dolphin?: boolean } = {}) {
  const started: any[] = [];
  const codes: string[] = [];
  const sessions = {
    start(request: any) {
      started.push(request);
      return { ok: true, sessionId: 'a'.repeat(32) };
    },
    get: (id: string) => (id === 'a'.repeat(32)
      ? { ok: true, sessionId: id, state: 'running', percent: null }
      : { ok: false, reason: 'unknown-session' }),
    stop: async () => ({ ok: true })
  };

  const installSecret = createInstallSecret();
  const runtime = createRuntimeServer({
    sessions, installSecret, version: '0.0.0-test',
    dolphinAvailable: () => dolphin,
    onPairingCode: (code: string) => codes.push(code)
  });

  await new Promise<void>((resolve) => runtime.server.listen(0, '127.0.0.1', resolve));
  const { port } = runtime.server.address() as AddressInfo;

  const call = (path: string, init: any = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    // What a same-origin fetch from the arcade page actually sends.
    headers: { origin: ORIGIN, 'sec-fetch-site': 'same-site', ...(init.headers ?? {}) }
  });

  /** Pairs the way a player does: read the code off the runtime, type it in. */
  async function pair() {
    await call('/v1/pair/begin', { method: 'POST', body: '{}' });
    const response = await call('/v1/pair/complete', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: codes.at(-1) })
    });
    return (await response.json()).token as string;
  }

  return { call, pair, codes, started, close: () => runtime.close() };
}

const LAUNCH = { protocolVersion: PROTOCOL_VERSION, gameId: 'wind-waker', platformId: 'gamecube', cabinetId: 'gamecube-cabinet-01' };

void test('status is readable without pairing, and says nothing about the machine', async () => {
  // The page must be able to tell "not installed" from "not paired" before it
  // can ask the player to fix either.
  const runtime = await boot();
  try {
    const response = await runtime.call('/v1/status');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.runtime, 'ptc-arcade-runtime');
    assert.equal(body.protocolVersion, PROTOCOL_VERSION);
    // PS2 joined GameCube on the native path: the browser core holds 40 f/s
    // on the demanding titles and no caching changes that.
    assert.deepEqual(body.platforms, ['gamecube', 'ps2', 'nds', 'gb', 'gbc', 'gba']);
    assert.equal(body.dolphin.present, true);

    const serialized = JSON.stringify(body);
    for (const leak of ['home', 'Users', 'library', 'path', 'secret', 'token']) {
      assert.ok(!serialized.toLowerCase().includes(leak.toLowerCase()), `status must not disclose ${leak}`);
    }
  } finally { await runtime.close(); }
});

void test('another site is refused on every route, including the preflight', async () => {
  // A permissive preflight is how a browser gets talked into sending the real
  // request, so it has to be refused too.
  const runtime = await boot();
  try {
    const evil = { origin: 'https://evil.example' };
    const status = await runtime.call('/v1/status', { headers: evil });
    assert.equal(status.status, 403);

    const preflight = await runtime.call('/v1/sessions', { method: 'OPTIONS', headers: evil });
    assert.equal(preflight.status, 403);
    assert.equal(preflight.headers.get('access-control-allow-origin'), null,
      'no CORS header may be echoed to an origin we do not serve');
  } finally { await runtime.close(); }
});

void test('a launch without a token is refused', async () => {
  const runtime = await boot();
  try {
    const response = await runtime.call('/v1/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(LAUNCH)
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).reason, 'not-paired');
    assert.equal(runtime.started.length, 0, 'nothing may be started for an unpaired caller');
  } finally { await runtime.close(); }
});

void test('the pairing code is never in a response body', async () => {
  // It is shown in the runtime's own window precisely so a page cannot read it.
  const runtime = await boot();
  try {
    const response = await runtime.call('/v1/pair/begin', { method: 'POST', body: '{}' });
    const body = await response.text();
    assert.equal(runtime.codes.length, 1, 'the runtime must have displayed a code');
    assert.ok(!body.includes(runtime.codes[0]), 'the code must not travel back to the page');
  } finally { await runtime.close(); }
});

void test('pairing then launching works, and the request reaches the session manager intact', async () => {
  const runtime = await boot();
  try {
    const token = await runtime.pair();
    assert.ok(token, 'pairing must issue a token');

    const response = await runtime.call('/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ptc-runtime-token': token },
      body: JSON.stringify(LAUNCH)
    });
    assert.equal(response.status, 202);
    assert.deepEqual(runtime.started, [{ gameId: 'wind-waker', platformId: 'gamecube', cabinetId: 'gamecube-cabinet-01' }]);
  } finally { await runtime.close(); }
});

void test('a launch naming a path or a command is refused, not cleaned up', async () => {
  // The rule the design rests on, enforced at the edge.
  const runtime = await boot();
  try {
    const token = await runtime.pair();
    for (const smuggled of ['path', 'exe', 'command', 'args', 'argv', 'file']) {
      const response = await runtime.call('/v1/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ptc-runtime-token': token },
        body: JSON.stringify({ ...LAUNCH, [smuggled]: 'C:\\Windows\\System32\\cmd.exe' })
      });
      assert.equal(response.status, 400, smuggled);
    }
    assert.equal(runtime.started.length, 0, 'no smuggled request may reach the session manager');
  } finally { await runtime.close(); }
});

void test('a token from one origin does not work from another', async () => {
  const runtime = await boot();
  try {
    const token = await runtime.pair();
    const response = await runtime.call('/v1/sessions', {
      method: 'POST',
      headers: {
        origin: 'https://www.ptcarcade.fun',   // allowed origin, different one
        'content-type': 'application/json', 'x-ptc-runtime-token': token
      },
      body: JSON.stringify(LAUNCH)
    });
    assert.equal(response.status, 401, 'a token is bound to the origin it was issued to');
  } finally { await runtime.close(); }
});

void test('a page speaking another protocol version is refused', async () => {
  const runtime = await boot();
  try {
    const token = await runtime.pair();
    const response = await runtime.call('/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ptc-runtime-token': token },
      body: JSON.stringify({ ...LAUNCH, protocolVersion: 99 })
    });
    assert.equal(response.status, 409);
    assert.equal(runtime.started.length, 0);
  } finally { await runtime.close(); }
});

void test('an oversized body is dropped rather than buffered', async () => {
  const runtime = await boot();
  try {
    const token = await runtime.pair();
    const response = await runtime.call('/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ptc-runtime-token': token },
      body: JSON.stringify({ ...LAUNCH, padding: 'x'.repeat(64 * 1024) })
    }).catch(() => null);
    // Either a 400 or a dropped connection is acceptable; a started session is not.
    if (response) assert.notEqual(response.status, 202);
    assert.equal(runtime.started.length, 0);
  } finally { await runtime.close(); }
});

void test('session routes reject an id that is not a session id', async () => {
  const runtime = await boot();
  try {
    const token = await runtime.pair();
    for (const bad of ['../../etc/passwd', 'not-a-session', 'A'.repeat(32), '']) {
      const response = await runtime.call(`/v1/sessions/${encodeURIComponent(bad)}`, {
        headers: { 'x-ptc-runtime-token': token }
      });
      assert.equal(response.status, 404, bad);
    }
    const good = await runtime.call(`/v1/sessions/${'a'.repeat(32)}`, { headers: { 'x-ptc-runtime-token': token } });
    assert.equal(good.status, 200);
    assert.equal((await good.json()).state, 'running');
  } finally { await runtime.close(); }
});

void test('an installed runtime with no Dolphin says so rather than failing at launch', async () => {
  const runtime = await boot({ dolphin: false });
  try {
    assert.equal((await (await runtime.call('/v1/status')).json()).dolphin.present, false);
  } finally { await runtime.close(); }
});

void test('a preflight from the arcade to loopback is allowed through', async () => {
  // Chrome treats an https page reaching 127.0.0.1 as a private-network request
  // and blocks it unless the preflight says otherwise. Without this the probe
  // never leaves the browser, the runtime looks absent, and the player is
  // quietly handed the browser core with nothing saying why — which is exactly
  // what happened: the cabinet offered no pairing at all.
  const runtime = await boot();
  try {
    const response = await runtime.call('/v1/status', {
      method: 'OPTIONS',
      // The helper already sends the arcade's origin; setting it again here
      // produces a doubled header value that matches no allow-list entry.
      headers: {
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Private-Network': 'true'
      }
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-private-network'), 'true');
  } finally {
    await runtime.close();
  }
});
