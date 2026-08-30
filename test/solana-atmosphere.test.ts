import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

void test('the hub uses one generated Solana neon texture for its signs', async () => {
  const arcade = await readFile(path.resolve(process.cwd(), 'arcade.js'), 'utf8');

  assert.match(arcade, /const SOLANA_PALETTE=Object\.freeze\(\[0x14f195,0x20d9ff,0x9945ff\]\)/);
  assert.match(arcade, /const solanaSignTexture=createSolanaSignTexture\(\)/);
  assert.match(arcade, /solanaAtmosphere\.name='solana-atmosphere'/);
  assert.equal((arcade.match(/createSolanaSignTexture\(\)/g) ?? []).length, 2,
    'one declaration and one invocation keep the signs on a shared texture');
});

void test('Solana signs stay on solid partition spans and clear every doorway', async () => {
  const arcade = await readFile(path.resolve(process.cwd(), 'arcade.js'), 'utf8');

  assert.match(arcade, /x:PLAYSTATION_WALL_X\+\.205,y:3\.7,z:-16\.6,rotationY:Math\.PI\/2,width:5\.2,height:1\.25/);
  assert.match(arcade, /x:N64_WALL_X-\.205,y:3\.7,z:20\.4,rotationY:-Math\.PI\/2,width:5\.2,height:1\.25/);
  assert.doesNotMatch(arcade, /addSolanaNeonSign\(\{x:0/);
});

void test('Solana ambient washes brighten the walking route within a two-light budget', async () => {
  const arcade = await readFile(path.resolve(process.cwd(), 'arcade.js'), 'utf8');

  assert.match(arcade, /solanaWestWash\.userData\.solanaLight=true/);
  assert.match(arcade, /solanaEastWash\.userData\.solanaLight=true/);
  assert.match(arcade, /const SOLANA_AMBIENT_POOLS=Object\.freeze\(\[/);
  assert.equal((arcade.match(/SOLANA_PALETTE\[/g) ?? []).length, 10,
    'the two signs and eight walking-route pools share the approved palette');
  assert.match(arcade, /pool\.userData\.decorative=true/);
  assert.match(arcade, /new THREE\.PointLight\(color,7\.5,18,2\)/);
  assert.match(arcade, /beforeRenderCallbacks\.push\(now=>/);
  assert.match(arcade, /const roomLights=\[\],accentLights=\[\],muralLights=\[\],solanaLights=\[\]/);
  assert.match(arcade, /solanaLights\.sort[\s\S]+light\.visible=index<2&&distanceSq<400/);
});
