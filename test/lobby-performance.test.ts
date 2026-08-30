import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();

void test('lobby audio and dormant jukebox state are not shipped', async () => {
  const [index, styles, clientWorld, protocol, serverWorld, edgeWorld, config] = await Promise.all([
    readFile(path.resolve(root, 'index.html'), 'utf8'),
    readFile(path.resolve(root, 'style.css'), 'utf8'),
    readFile(path.resolve(root, 'world/world-manager.js'), 'utf8'),
    readFile(path.resolve(root, 'server/src/protocol.ts'), 'utf8'),
    readFile(path.resolve(root, 'server/src/world/world-manager.ts'), 'utf8'),
    readFile(path.resolve(root, 'cloudflare/src/index.ts'), 'utf8'),
    readFile(path.resolve(root, 'assets/world/config.json'), 'utf8')
  ]);

  assert.doesNotMatch(index, /audio-toggle/);
  assert.doesNotMatch(styles, /audio-toggle/);
  assert.doesNotMatch(clientWorld, /AudioManager|audioCue/);
  assert.doesNotMatch(`${protocol}\n${serverWorld}\n${edgeWorld}\n${config}`, /jukebox|audioCue|"tracks"/i);
  await assert.rejects(access(path.resolve(root, 'world/audio-manager.js')));
});

void test('repeated ceiling fixtures are GPU-instanced without changing their placement calls', async () => {
  const arcade = await readFile(path.resolve(root, 'arcade.js'), 'utf8');
  assert.match(arcade, /const ceilingFixturePositions=/);
  assert.match(arcade, /new THREE\.InstancedMesh\(geometry,material,positions\.length\)/);
  assert.match(arcade, /queueCeilingFixture\(x,z,cool\)/);
  assert.match(arcade, /flushCeilingFixtures\(\)/);
  assert.doesNotMatch(arcade, /const housing=new THREE\.Mesh\(new THREE\.BoxGeometry\(3\.6,\.17,\.52\)/);
});

void test('movement uses the server packet budget and throttles redundant correction echoes', async () => {
  const [client, server, edge] = await Promise.all([
    readFile(path.resolve(root, 'multiplayer-client.js'), 'utf8'),
    readFile(path.resolve(root, 'server/src/index.ts'), 'utf8'),
    readFile(path.resolve(root, 'cloudflare/src/index.ts'), 'utf8')
  ]);

  assert.match(client, /const sendIntervalMs = 50;/);
  assert.match(client, /const interpolationDelayMs = 75;/);
  assert.match(server, /now - lastAuthoritativeEchoAt >= 250/);
  assert.match(edge, /now - \(attachment\.lastAuthoritativeEchoAt \?\? 0\) >= 250/);
  assert.match(edge, /private correct\(socket: WebSocket, player\?: PlayerState\): void \{ if \(player\) this\.send\(socket, 'player:state', player\); \}/);
});
