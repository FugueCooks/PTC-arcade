import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

void test('player selection supports temporary guests and signed Solana wallet accounts', async () => {
  const [markup, client] = await Promise.all([
    readFile(path.resolve(process.cwd(), 'index.html'), 'utf8'),
    readFile(path.resolve(process.cwd(), 'avatar-selection.js'), 'utf8')
  ]);
  assert.match(markup, /PLAY AS GUEST/);
  assert.match(markup, /CONNECT WALLET/);
  assert.match(markup, /PERSISTENT DISPLAY NAME/);
  assert.match(markup, /never request seed phrases or private keys/i);
  assert.match(markup, /Choose any avatar and play immediately as a guest/i);
  assert.match(client, /api\/auth\/guest[^\n]+avatarId: selectedAvatarId/);
  assert.doesNotMatch(markup, /CREATE ACCOUNT|PASSWORD|>USERNAME<\/label>/);
  assert.match(client, /wallet\/challenge/);
  assert.match(client, /wallet\/verify/);
  for (const endpoint of ['/api/auth/session', '/api/auth/guest', '/api/auth/logout', '/api/account/profile']) {
    assert.match(client, new RegExp(endpoint.replaceAll('/', '\\/')));
  }
  assert.doesNotMatch(client, /\/api\/auth\/(register|login)/);
  assert.match(client, /credentials: 'same-origin'/);
  assert.doesNotMatch(client, /localStorage\.setItem\([^\n]*(token|session)/i);
});
