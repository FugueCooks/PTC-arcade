import assert from 'node:assert/strict';
import test from 'node:test';
import { importBrowserModule } from './helpers/browser-module.js';

/**
 * The runtime starts native processes on request from a web page, which makes
 * this the most dangerous surface in the project: every site the player visits
 * can reach 127.0.0.1. These tests cover the four things standing between a
 * hostile page and a launched process.
 */
const security = await importBrowserModule<any>('ptc-runtime/src/security.js');
const protocol = await importBrowserModule<any>('emulators/ptc-runtime/protocol.js');

void test('only the arcade origins are served', () => {
  for (const allowed of ['https://ptcarcade.fun', 'https://www.ptcarcade.fun']) {
    assert.equal(security.isAllowedOrigin(allowed), true, allowed);
  }
  for (const refused of [
    'https://ptcarcade.fun.evil.com',      // suffix attack
    'https://evil.com/ptcarcade.fun',
    'http://ptcarcade.fun',                // downgraded
    'https://ptcarcade.fun:8443',          // different port is a different origin
    'null',                                // sandboxed iframe
    '',
    undefined,
    null
  ]) {
    assert.equal(security.isAllowedOrigin(refused as never), false, String(refused));
  }
});

void test('a request from another site is refused before its body matters', () => {
  const refused = security.checkRequest({ headers: { origin: 'https://evil.example' } });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'origin-refused');

  const noOrigin = security.checkRequest({ headers: {} });
  assert.equal(noOrigin.ok, false, 'a request with no Origin is not the page');

  const crossSite = security.checkRequest({
    headers: { origin: 'https://ptcarcade.fun', 'sec-fetch-site': 'cross-site' }
  });
  assert.equal(crossSite.ok, false, 'the browser calling it cross-site outranks a matching Origin');
});

void test('pairing cannot be completed without seeing the runtime window', () => {
  // The code is shown by the runtime's own window. A page can send guesses, and
  // this is what stops it walking the six digits.
  const pairing = security.createPairingCode(1_000);
  assert.match(pairing.code, /^\d{6}$/);

  let current = pairing;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = security.verifyPairingCode(current, '000000' === current.code ? '111111' : '000000', 1_100);
    assert.equal(result.ok, false);
    current = result.pairing;
    if (!current) break;
  }
  assert.equal(current, null, 'pairing must be abandoned after repeated wrong codes');
});

void test('an expired pairing code is refused even when correct', () => {
  const pairing = security.createPairingCode(1_000, 60_000);
  const result = security.verifyPairingCode(pairing, pairing.code, 1_000 + 60_001);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'expired');
});

void test('the right code pairs, once', () => {
  const pairing = security.createPairingCode(1_000);
  const first = security.verifyPairingCode(pairing, pairing.code, 1_100);
  assert.equal(first.ok, true);
  assert.equal(first.pairing, null, 'the code must not remain usable after it succeeds');
});

void test('a token is bound to the origin it was issued to', () => {
  // A token lifted from one site's storage must be useless from another.
  const secret = security.createInstallSecret();
  const token = security.issueToken(secret, 'https://ptcarcade.fun', 1_000);

  assert.equal(security.verifyToken(secret, 'https://ptcarcade.fun', token, 2_000).ok, true);
  assert.equal(security.verifyToken(secret, 'https://evil.example', token, 2_000).ok, false);
});

void test('a token from another install does not verify', () => {
  const token = security.issueToken(security.createInstallSecret(), 'https://ptcarcade.fun', 1_000);
  const otherInstall = security.createInstallSecret();
  const verdict = security.verifyToken(otherInstall, 'https://ptcarcade.fun', token, 2_000);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'bad-signature');
});

void test('forged and malformed tokens are refused', () => {
  const secret = security.createInstallSecret();
  for (const forged of [
    '', 'garbage', 'a.b.c', '1000.notahexnonce.' + 'f'.repeat(64),
    `1000.${'a'.repeat(32)}.${'f'.repeat(64)}`
  ]) {
    assert.equal(security.verifyToken(secret, 'https://ptcarcade.fun', forged, 2_000).ok, false, forged);
  }
});

void test('a token expires, and a backwards clock does not grant immortality', () => {
  const secret = security.createInstallSecret();
  const token = security.issueToken(secret, 'https://ptcarcade.fun', 1_000_000);
  const maxAge = 1_000;
  assert.equal(security.verifyToken(secret, 'https://ptcarcade.fun', token, 1_000_500, maxAge).ok, true);
  assert.equal(security.verifyToken(secret, 'https://ptcarcade.fun', token, 1_002_000, maxAge).ok, false);
  assert.equal(
    security.verifyToken(secret, 'https://ptcarcade.fun', token, 500_000, maxAge).ok, false,
    'a token issued far in the future is not trusted'
  );
});

void test('a launch request may name a game, never a path or a command', () => {
  // The rule the whole design rests on. A page that could name what to run
  // would be naming an executable, and any site could then name one.
  const valid = { protocolVersion: 1, gameId: 'wind-waker', platformId: 'gamecube', cabinetId: 'gamecube-cabinet-01' };
  assert.equal(protocol.isValidLaunchRequest(valid), true);

  for (const smuggled of ['path', 'file', 'filePath', 'executable', 'command', 'args', 'argv', 'exe']) {
    assert.equal(
      protocol.isValidLaunchRequest({ ...valid, [smuggled]: 'C:\\Windows\\System32\\cmd.exe' }),
      false,
      `a request carrying ${smuggled} must be refused outright, not sanitized`
    );
  }
});

void test('game ids cannot traverse or smuggle', () => {
  for (const bad of [
    '../../etc/passwd', 'wind waker', 'Wind-Waker', 'wind_waker', '', 'a',
    'game;rm -rf /', 'game\u0000', '-flag', '..'
  ]) {
    assert.equal(protocol.isValidGameId(bad), false, bad);
  }
  assert.equal(protocol.isValidGameId('wind-waker'), true);
});

void test('a page speaking another protocol version is refused, not guessed at', () => {
  assert.equal(security.checkProtocolVersion(protocol.PROTOCOL_VERSION).ok, true);
  for (const wrong of [0, 2, '1', null, undefined]) {
    assert.equal(security.checkProtocolVersion(wrong as never).ok, false, String(wrong));
  }
});

void test('the allowed origins contain no wildcard and no LAN address', () => {
  for (const origin of protocol.ALLOWED_ORIGINS) {
    assert.doesNotMatch(origin, /\*/, 'a wildcard origin would serve every site on the machine');
    if (origin.startsWith('http://')) {
      assert.match(origin, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/,
        'a plaintext origin is only acceptable on loopback');
    }
  }
});
