import assert from 'node:assert/strict';
import test from 'node:test';
import { PlayerManager } from '../server/src/players/player-manager.js';
import { RoomManager } from '../server/src/rooms/room-manager.js';
import { ChatManager, sanitizeChatText } from '../server/src/social/chat-manager.js';
import { ReactionManager } from '../server/src/social/reaction-manager.js';
import { PresenceManager } from '../server/src/social/presence-manager.js';
import { StatusManager } from '../server/src/social/status-manager.js';

const identity = { displayName: 'SOCIAL TESTER', avatarId: 'neon-capsule' };
const setup = () => {
  const players = new PlayerManager(new RoomManager());
  const joined = players.join('socket-a', 'main', undefined, identity, 1_000);
  return { players, joined };
};

void test('chat is sanitized, room-local, bounded, and rate limited', () => {
  const { players } = setup();
  const chat = new ChatManager(players, { minimumIntervalMs: 500, maxMessagesPerWindow: 2 });
  assert.equal(sanitizeChatText('  hello <b>arcade</b>\u0000  '), 'hello barcade/b');
  assert.equal(chat.send('socket-a', 'hello <arcade>', 2_000).ok, true);
  assert.deepEqual(chat.send('socket-a', 'too soon', 2_100), { ok: false, reason: 'rate-limited' });
  assert.equal(chat.snapshot('main')[0]?.text, 'hello arcade');
  assert.equal(chat.snapshot('another-room').length, 0);
});

void test('AFK status is authoritative and activity restores idle immediately', () => {
  const { players, joined } = setup();
  const statuses = new StatusManager(players, { afkTimeoutMs: 1_000 });
  statuses.handlePlayerEvent({ type: 'PlayerJoined', roomId: 'main', player: joined.player, socketId: 'socket-a' }, 1_000);
  statuses.sweep(2_001);
  assert.equal(players.stateFor('socket-a')?.s, 'away');
  statuses.noteActivityForSocket('socket-a', 2_010);
  assert.equal(players.stateFor('socket-a')?.s, 'idle');
});

void test('reactions validate the allowlist and enforce cooldowns', () => {
  const { players } = setup();
  const reactions = new ReactionManager(players, 500);
  assert.equal(reactions.send('socket-a', '🔥', 2_000).ok, true);
  assert.deepEqual(reactions.send('socket-a', '👍', 2_100), { ok: false, reason: 'rate-limited' });
  assert.deepEqual(reactions.send('socket-a', '💰', 3_000), { ok: false, reason: 'invalid' });
});

void test('proximity sends nearby movement immediately and throttles far updates', () => {
  const players = new PlayerManager(new RoomManager([
    { id: 'main', spawnSeparation: 1, spawnPoints: [{ x: 0, y: 1.65, z: 0, rotationY: 0 }, { x: 20, y: 1.65, z: 0, rotationY: 0 }] }
  ]));
  const first = players.join('socket-a', 'main', undefined, identity, 1_000).player;
  players.join('socket-b', 'main', undefined, identity, 1_000);
  const presence = new PresenceManager(players, { nearbyDistance: 5, farUpdateIntervalMs: 300 });
  const walking = { ...first, s: 'walking' as const, a: 'walk' as const };
  assert.deepEqual(presence.movementRecipients(walking, 'socket-a', 1_000), ['socket-b']);
  assert.deepEqual(presence.movementRecipients(walking, 'socket-a', 1_100), []);
  assert.deepEqual(presence.movementRecipients({ ...walking, s: 'idle', a: 'idle' }, 'socket-a', 1_110), ['socket-b']);
});
