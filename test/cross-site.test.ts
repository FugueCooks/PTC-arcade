import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request } from 'express';
import { checkCrossSite, crossSiteMessage } from '../server/src/http/cross-site.js';

/** Minimal stand-in for the parts of a request the check reads. */
function request(overrides: {
  method?: string; origin?: string; secFetchSite?: string; protocol?: string; host?: string;
} = {}): Request {
  const headers: Record<string, string | undefined> = {
    Origin: overrides.origin,
    'Sec-Fetch-Site': overrides.secFetchSite,
    host: overrides.host ?? 'ptcarcade.fun'
  };
  return {
    method: overrides.method ?? 'POST',
    protocol: overrides.protocol ?? 'https',
    get: (name: string) => headers[name] ?? headers[name.toLowerCase()]
  } as unknown as Request;
}

const ALLOWED = 'https://ptcarcade.fun';

void test('safe methods are never treated as cross-site', () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    assert.equal(checkCrossSite(request({ method, origin: 'https://evil.example' }), ALLOWED).rejected, false);
  }
});

void test('a same-origin mutation passes', () => {
  const verdict = checkCrossSite(request({ origin: ALLOWED, secFetchSite: 'same-origin' }), ALLOWED);
  assert.equal(verdict.rejected, false);
});

void test('a mutation from another origin is refused', () => {
  const verdict = checkCrossSite(request({ origin: 'https://evil.example' }), ALLOWED);
  assert.equal(verdict.rejected, true);
  assert.equal(verdict.reason, 'origin-mismatch');
});

void test('the browser calling it cross-site is enough on its own', () => {
  const verdict = checkCrossSite(request({ origin: ALLOWED, secFetchSite: 'cross-site' }), ALLOWED);
  assert.equal(verdict.rejected, true, 'Sec-Fetch-Site outranks a matching Origin header');
});

void test('the www host is a different origin, and says so', () => {
  // The likeliest real misconfiguration: PUBLIC_APP_ORIGIN names the apex while
  // the player is on www, or the reverse.
  const verdict = checkCrossSite(request({ origin: 'https://www.ptcarcade.fun' }), ALLOWED);
  assert.equal(verdict.rejected, true);
  const message = crossSiteMessage(verdict);
  assert.match(message, /https:\/\/www\.ptcarcade\.fun/, 'the message must name what was seen');
  assert.match(message, /https:\/\/ptcarcade\.fun/, 'and what was expected');
  assert.match(message, /PUBLIC_APP_ORIGIN/, 'and the setting that decides it');
});

void test('a request naming no origin is allowed through', () => {
  // Non-browser clients and same-origin form posts do not always send one; the
  // Sec-Fetch-Site check above is what covers the browser case.
  assert.equal(checkCrossSite(request({}), ALLOWED).rejected, false);
});

void test('an unparsable origin is refused', () => {
  const verdict = checkCrossSite(request({ origin: 'not a url' }), ALLOWED);
  assert.equal(verdict.rejected, true);
  assert.equal(verdict.reason, 'origin-unparsable');
});

void test('without PUBLIC_APP_ORIGIN the check falls back to the request host', () => {
  // Behind a proxy this is only correct when TRUST_PROXY is set: otherwise the
  // protocol reads as http, every https mutation mismatches, and the site looks
  // broken in a way that has nothing to do with the browser.
  assert.equal(checkCrossSite(request({ origin: 'https://ptcarcade.fun' }), undefined).rejected, false);

  const untrustedProxy = checkCrossSite(request({ origin: 'https://ptcarcade.fun', protocol: 'http' }), undefined);
  assert.equal(untrustedProxy.rejected, true);
  assert.match(crossSiteMessage(untrustedProxy), /http:\/\/ptcarcade\.fun/, 'the message exposes the http/https mismatch');
});

void test('both routers share one implementation', async () => {
  // They had a copy each, written differently. Two copies of a security check
  // drift, and a rule that holds on one router and not the other reads as a
  // mystery rather than a rule.
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  for (const file of ['server/src/http/auth-routes.ts', 'server/src/http/account-routes.ts']) {
    const source = await readFile(path.resolve(process.cwd(), file), 'utf8');
    assert.match(source, /checkCrossSite/, `${file} must use the shared check`);
    assert.doesNotMatch(source, /Sec-Fetch-Site/, `${file} must not re-implement it`);
  }
});
