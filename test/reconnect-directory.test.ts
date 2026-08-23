import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryReconnectDirectory } from '../server/src/players/reconnect-directory.js';

void test('reconnect routing restores a live room and expires stale records', async () => {
  const directory = new InMemoryReconnectDirectory();
  await directory.save('private-token', { playerId: 'p1', roomId: 'room-a', serverId: 'server-a', expiresAt: 200 });
  assert.equal((await directory.get('private-token', 100))?.roomId, 'room-a');
  assert.equal(await directory.get('private-token', 201), undefined);
});
