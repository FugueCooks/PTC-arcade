import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

void test('third-person mouse pitch follows the same direction as first-person look', async () => {
  const arcade = await readFile(path.resolve(process.cwd(), 'arcade.js'), 'utf8');
  assert.match(arcade, /followOffset\.set\(0,2\.15-pitch\*2\.1,4\.55\)/);
});

void test('latency correction ignores tiny echoes and bounds avatar update work', async () => {
  const multiplayer = await readFile(path.resolve(process.cwd(), 'multiplayer-client.js'), 'utf8');
  assert.match(multiplayer, /drift < 0\.08 && rotationDrift < 0\.05/);
  assert.match(multiplayer, /drift > 1 \? 0\.28 : drift > 0\.35 \? 0\.08 : 0\.025/);
  assert.match(multiplayer, /performanceProfile\?\.lowPower \? 1000 \/ 30 : 1000 \/ 60/);
  assert.match(multiplayer, /now - lastAvatarFrameAt < avatarFrameIntervalMs - 1/);
});
