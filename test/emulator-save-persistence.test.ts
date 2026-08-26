import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();

void test('EmulatorJS grants persistent saves only from server-issued wallet entitlements', async () => {
  const player = await readFile(path.join(root, 'player.html'), 'utf8');
  assert.match(player, /fetch\('\/api\/auth\/session',\s*\{\s*credentials:\s*'same-origin',\s*cache:\s*'no-store'\s*\}\)/);
  assert.match(player, /payload\?\.entitlements\?\.canPersistGameSaves\s*===\s*true/);
  assert.match(player, /walletSaveGameId\(policy\.subject\)\s*:\s*ephemeral/);
  assert.match(player, /payload\?\.identity\?\.publicPlayerId/);
  assert.match(player, /Math\.imul\(hash,\s*0x01000193\)/);
  assert.match(player, /saveState:\s*saveEntitled/);
  assert.match(player, /loadState:\s*saveEntitled/);
  assert.match(player, /EJS_hideSettings\s*=\s*saveEntitled\s*\?\s*\[\]\s*:\s*\['save-state-location',\s*'save-save-interval'\]/);
  assert.match(player, /'save-state-location':\s*saveEntitled\s*\?\s*'browser'\s*:\s*'download'/);
  assert.match(player, /if\s*\(!saveEntitled\)\s*\{[\s\S]*arcade:emulator-stopped/);
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
