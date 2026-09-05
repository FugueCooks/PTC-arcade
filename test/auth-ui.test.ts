import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

void test('player selection supports temporary guests and username accounts', async () => {
  const [markup, client] = await Promise.all([
    readFile(path.resolve(process.cwd(), 'index.html'), 'utf8'),
    readFile(path.resolve(process.cwd(), 'avatar-selection.js'), 'utf8')
  ]);
  // Guests still get in without an account at all; that is the front door.
  assert.match(markup, /PLAY AS GUEST/);
  assert.match(client, /api\/auth\/guest[^\n]+avatarId: selectedAvatarId/);

  // Accounts are a username and a password, and the form offers both making
  // one and signing back in.
  assert.match(markup, /id="account-username"/);
  assert.match(markup, /id="account-password"/);
  assert.match(markup, /type="password"/);
  assert.match(markup, /CREATE ACCOUNT/);
  assert.match(markup, /SIGN IN/);
  assert.match(client, /\/api\/auth\/register/);
  assert.match(client, /\/api\/auth\/login/);
  // The two schemas disagree deliberately: registration requires avatarId and
  // sign-in is strict and rejects it, so one shared body breaks whichever end
  // is not in use. Sending only a username and password looked correct, passed
  // every unit test, and was refused by the live endpoint for every account.
  assert.match(client, /accountMode === 'register'\s*\n?\s*\? \{ username, password, avatarId: selectedAvatarId \}\s*\n?\s*: \{ username, password \}/);

  // The wallet flow is gone from what a player can reach: no picker, no
  // challenge, no signature. The server routes still exist behind it, so this
  // pins the surface rather than the codebase.
  assert.doesNotMatch(markup, /CONNECT WALLET|wallet-select|Solana wallet/);
  assert.doesNotMatch(client, /wallet\/challenge|wallet\/verify|wallet-standard-bundle/);

  for (const endpoint of ['/api/auth/session', '/api/auth/guest', '/api/auth/logout', '/api/account/profile']) {
    assert.match(client, new RegExp(endpoint.replaceAll('/', '\\/')));
  }
  // The session lives in an http-only cookie the server sets. A token written
  // into localStorage would be readable by any script that gets onto the page.
  assert.match(client, /credentials: 'same-origin'/);
  assert.doesNotMatch(client, /localStorage\.setItem\([^\n]*(token|session)/i);
  // The password is sent and then dropped; nothing holds it after the request.
  assert.match(client, /accountPassword\.value = ''/);
});
