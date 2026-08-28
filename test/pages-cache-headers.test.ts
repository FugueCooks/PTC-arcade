import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const build = await readFile(path.resolve(process.cwd(), 'tools/build-pages.mjs'), 'utf8');
const headers = build.slice(build.indexOf('function headersFile()'));

function ruleFor(pattern: string): string {
  const start = headers.indexOf(`\n${pattern}\n`);
  assert.notEqual(start, -1, `no _headers rule for ${pattern}`);
  const body = headers.slice(start + pattern.length + 2);
  return body.slice(0, body.indexOf('\n')).trim();
}

void test('emulator binaries stay cached for a day', () => {
  // Play.wasm and the Gecko package are content: they change when a core is
  // rebuilt, which is rare, and they are the largest thing a player downloads.
  assert.match(ruleFor('/emulators/*'), /max-age=86400/);
  assert.match(ruleFor('/assets/*'), /max-age=86400/);
});

void test('emulator code revalidates instead of sitting behind a day of cache', () => {
  // The frames and adapters live in the same directory as those binaries. Under
  // the binary rule a shipped fix could stay unreachable for a day, plus a week
  // of stale-while-revalidate, while the page looked current — the drift the
  // ?v= tokens in the import graph were compensating for by hand.
  for (const pattern of ['/emulators/*.js', '/emulators/*.html', '/emulators/*.css']) {
    const rule = ruleFor(pattern);
    assert.match(rule, /must-revalidate/, `${pattern} must revalidate`);
    assert.doesNotMatch(rule, /stale-while-revalidate/, `${pattern} must not be served stale`);
    const maxAge = Number(/max-age=(\d+)/.exec(rule)?.[1]);
    assert.ok(maxAge <= 300, `${pattern} caps at five minutes, got ${maxAge}`);
  }
});

void test('the emulator code rules come after the directory rule they narrow', () => {
  // Cloudflare applies every matching rule in order, so a broad rule listed
  // last would put the day-long cache back on the code it is meant to exclude.
  assert.ok(headers.indexOf('/emulators/*\n') < headers.indexOf('/emulators/*.js'));
});

void test('the entry points are never cached', () => {
  for (const pattern of ['/index.html', '/', '/runtime-config.js']) assert.match(ruleFor(pattern), /no-store/);
});
