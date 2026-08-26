import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * The origin runs on a free plan that spins down after about fifteen minutes
 * without traffic, so the first player after a quiet spell waits roughly a
 * minute for the site to answer. The always-on Worker pings it on a schedule to
 * prevent that.
 *
 * It is the kind of arrangement that disappears in a refactor without anyone
 * noticing — the site still works, just slowly, and only sometimes — so the
 * pieces are pinned here.
 */
const root = process.cwd();
const worker = await readFile(path.join(root, 'cloudflare/src/index.ts'), 'utf8');
const wrangler = await readFile(path.join(root, 'cloudflare/wrangler.jsonc'), 'utf8');

void test('the worker is scheduled often enough to beat the idle timeout', () => {
  const cron = /"crons"\s*:\s*\[\s*"([^"]+)"/.exec(wrangler);
  assert.ok(cron, 'the worker must declare a cron trigger');

  const everyNMinutes = /^\*\/(\d+) \* \* \* \*$/.exec(cron[1]);
  assert.ok(everyNMinutes, `unexpected schedule ${cron[1]}`);
  // The origin idles at 15 minutes. A schedule at or above that keeps nothing
  // warm, and one close to it leaves no margin for a late run.
  assert.ok(Number(everyNMinutes[1]) <= 12, 'the ping must run well inside the 15 minute idle window');
});

void test('the worker exports a scheduled handler that pings the origin', () => {
  assert.match(worker, /async scheduled\s*\(/, 'a cron trigger with no scheduled handler does nothing');
  assert.match(worker, /ORIGIN_HEALTH_URL/, 'the target must be configuration, not a hardcoded host');
  assert.match(worker, /ctx\.waitUntil/, 'the request must outlive the handler');
  assert.match(worker, /catch/, 'a down origin must not make the realtime worker throw');
});

void test('the ping aims at the origin, not the proxied public domain', () => {
  const target = /"ORIGIN_HEALTH_URL"\s*:\s*"([^"]+)"/.exec(wrangler);
  assert.ok(target, 'ORIGIN_HEALTH_URL must be configured');
  // A request to the public domain re-enters Cloudflare and can be answered
  // without ever reaching the origin, which would keep nothing warm.
  assert.doesNotMatch(target[1], /ptcarcade\.fun/, 'ping the origin hostname, not the proxied domain');
  assert.match(target[1], /\/healthz$/, 'the cheapest endpoint that proves the process is up');
});

void test('the endpoint being pinged is one the server actually serves', async () => {
  const routes = await readFile(path.join(root, 'server/src/http/operational-routes.ts'), 'utf8');
  assert.match(routes, /app\.get\('\/healthz'/, 'the keep-warm target must exist on the origin');
});
