import assert from 'node:assert/strict';
import test from 'node:test';
import { PlayerManager } from '../server/src/players/player-manager.js';
import { RoomManager } from '../server/src/rooms/room-manager.js';
import { WorldManager } from '../server/src/world/world-manager.js';

const identity = { displayName: 'WORLD TESTER', avatarId: 'neon-capsule' };
const roomConfigs = [
  { id: 'main', spawnSeparation: .1, spawnPoints: [{ x: 0, y: 1.65, z: 0, rotationY: 0 }, { x: 1, y: 1.65, z: 0, rotationY: 0 }] },
  { id: 'other', spawnSeparation: .1, spawnPoints: [{ x: 0, y: 1.65, z: 0, rotationY: 0 }] }
];

function setup() { const players = new PlayerManager(new RoomManager(roomConfigs)); const world = new WorldManager(players); players.subscribe((event) => world.handlePlayerEvent(event)); return { players, world }; }

void test('world activity follows authoritative connected room population', () => {
  const { players, world } = setup();
  players.join('a', 'main', undefined, identity, 1_000);
  assert.equal(world.snapshot('main').activityLevel, 'quiet');
  players.join('b', 'main', undefined, identity, 1_100);
  assert.equal(world.snapshot('main').activityLevel, 'active');
  assert.equal(world.snapshot('main').population, 2);
  players.disconnect('b', 1_200);
  assert.equal(world.snapshot('main').activityLevel, 'quiet');
});

void test('environment state remains isolated by room', () => {
  const { players, world } = setup(); players.join('a', 'main', undefined, identity, 1_000); players.join('b', 'other', undefined, identity, 1_000);
  assert.equal(world.setTheme('main', 'retro-80s'), true);
  assert.equal(world.snapshot('main').themeId, 'retro-80s');
  assert.equal(world.snapshot('other').themeId, 'synthwave');
  assert.notEqual(world.snapshot('main'), world.snapshot('other'));
});

void test('world events and announcements publish typed room events', () => {
  const { world } = setup(); const types: string[] = []; world.subscribe((event) => types.push(event.type));
  world.announce('main', 'Welcome.', 'welcome', 1_000); world.trigger('main', 'neon-surge', 900, 1_100);
  assert.deepEqual(types, ['WorldAnnouncement', 'WorldEventTriggered']);
});

void test('themes and weather are configuration-driven and validated', () => {
  const { world } = setup();
  assert.equal(world.setTheme('main', 'retro-80s'), true);
  assert.equal(world.setWeather('main', 'snow'), true);
  assert.equal(world.snapshot('main').themeId, 'retro-80s');
  assert.equal(world.snapshot('main').weatherId, 'snow');
  assert.equal(world.setTheme('main', 'unapproved-theme'), false);
});
