import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

void test('player selection supports guest, login, registration, session restore, and sign out', async () => {
  const [markup, client] = await Promise.all([
    readFile(path.resolve(process.cwd(), 'index.html'), 'utf8'),
    readFile(path.resolve(process.cwd(), 'avatar-selection.js'), 'utf8')
  ]);
  assert.match(markup, /CONTINUE AS GUEST/);
  assert.match(markup, /CREATE ACCOUNT/);
  assert.match(markup, />USERNAME<\/label>/);
  assert.doesNotMatch(markup, /id="account-email"|FORGOT PASSWORD|EMAIL<\/label>/);
  assert.match(client, /CREATE ACCOUNT & ENTER/);
  assert.match(markup, /id="sign-out"/);
  for (const endpoint of ['/api/auth/session', '/api/auth/register', '/api/auth/login', '/api/auth/guest', '/api/auth/logout', '/api/account/profile']) {
    assert.match(client, new RegExp(endpoint.replaceAll('/', '\\/')));
  }
  assert.match(client, /credentials: 'same-origin'/);
  assert.doesNotMatch(client, /localStorage\.setItem\([^\n]*(token|session)/i);
});
