import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { RoomManager } from '../server/src/rooms/room-manager.js';

void test('the room registry provides ten unique 25-player arcade instances', async () => {
  const registry = JSON.parse(await readFile(path.resolve(process.cwd(), 'assets/rooms/registry.json'), 'utf8')) as {
    rooms: Array<{ id: string; name: string; capacity: number; enabled: boolean }>;
  };
  const enabled = registry.rooms.filter((room) => room.enabled);
  assert.equal(enabled.length, 10);
  assert.equal(new Set(enabled.map((room) => room.id)).size, 10);
  assert.ok(enabled.every((room) => room.capacity === 25 && room.name.length >= 2));
});

void test('the Node fallback recognizes every configured room and enforces capacity', () => {
  const rooms = new RoomManager();
  for (const id of ['main', 'main-2', 'main-3', 'main-4', 'main-5', 'main-6', 'main-7', 'main-8', 'main-9', 'main-10']) {
    assert.equal(rooms.get(id)?.id, id);
  }
  const room = rooms.get('main-10')!;
  for (let index = 0; index < 25; index += 1) room.add(`player-${index}`);
  assert.equal(room.isFull, true);
});
