import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();

void test('EmulatorJS forces browser-backed save states after runtime initialization', async () => {
  const player = await readFile(path.join(root, 'player.html'), 'utf8');
  assert.match(player, /EJS_defaultOptions\s*=\s*\{\s*'save-state-location':\s*'browser'\s*\}/);
  assert.match(player, /emulator\.settings\s*=\s*\{[\s\S]*'save-state-location':\s*'browser'/);
  assert.match(player, /emulator\.allSettings\['save-state-location'\]\s*=\s*'browser'/);
  assert.match(player, /window\.EJS_ready\s*=\s*enforceBrowserSavePersistenceWithRetries/);
  assert.match(player, /window\.EJS_onGameStart\s*=\s*enforceBrowserSavePersistenceWithRetries/);
  assert.doesNotMatch(player, /window\.EJS_onSaveState\s*=/, 'registering this callback suppresses EmulatorJS default save-state handling');
});

void test('cabinet exit asks the iframe to flush save files before removing it', async () => {
  const [player, arcade] = await Promise.all([
    readFile(path.join(root, 'player.html'), 'utf8'),
    readFile(path.join(root, 'arcade.js'), 'utf8')
  ]);
  assert.match(arcade, /postMessage\(\{type:'arcade:emulator-stop'\},location\.origin\)/);
  assert.match(arcade, /setTimeout\(\(\)=>\{frame\?\.remove\(\);objectUrls\.forEach/);
  assert.match(player, /event\.data\?\.type\s*===\s*'arcade:emulator-stop'/);
  assert.match(player, /saveOwner\?\.saveSaveFiles\?\.\(\)/);
  assert.match(player, /type:\s*'arcade:emulator-stopped'/);
});
