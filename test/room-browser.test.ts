import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

void test('the player screen exposes quick join, live refresh, room ID entry, and cancelable waiting', async () => {
  const [markup, selection, multiplayer, placement] = await Promise.all([
    readFile(path.resolve(process.cwd(), 'index.html'), 'utf8'),
    readFile(path.resolve(process.cwd(), 'avatar-selection.js'), 'utf8'),
    readFile(path.resolve(process.cwd(), 'multiplayer-client.js'), 'utf8'),
    readFile(path.resolve(process.cwd(), 'rooms', 'room-placement-client.js'), 'utf8')
  ]);
  assert.match(markup, /id="room-refresh"/);
  assert.match(markup, /id="room-id"/);
  assert.match(markup, /id="placement-cancel"/);
  assert.match(selection, /QUICK JOIN · BEST AVAILABLE/);
  assert.match(selection, /placementClient\.rooms\(\)/);
  assert.match(selection, /arcade:placement-cancel/);
  assert.match(multiplayer, /new AbortController\(\)/);
  assert.match(multiplayer, /placementAbortController\?\.abort\(\)/);
  assert.match(placement, /Math\.min\(5_000, baseDelay \* \(attempt \+ 1\)\)/);
  assert.match(placement, /removeEventListener\('abort', aborted\)/);
});
