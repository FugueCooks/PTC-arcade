import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

void test('the Solana logo boards are gone from the hub', async () => {
  const arcade = await readFile(path.resolve(process.cwd(), 'arcade.js'), 'utf8');

  // The two signs, the builder that placed them, the canvas that painted them
  // and the wash lights that existed only to light them. A leftover of any one
  // of these means a board is still hanging somewhere or a texture is still
  // being generated for nothing.
  assert.doesNotMatch(arcade, /addSolanaNeonSign/);
  assert.doesNotMatch(arcade, /createSolanaSignTexture/);
  assert.doesNotMatch(arcade, /solanaSignTexture|solanaSignFaceMaterial|solanaSignBackingMaterial/);
  assert.doesNotMatch(arcade, /solanaWestWash|solanaEastWash/);
});

void test('the ambient floor pools survive the boards, on the approved palette', async () => {
  const arcade = await readFile(path.resolve(process.cwd(), 'arcade.js'), 'utf8');

  // The pools are coloured light on the walking route rather than a mark, so
  // they stay. The group that holds them stays with them.
  assert.match(arcade, /const SOLANA_PALETTE=Object\.freeze\(\[0x14f195,0x20d9ff,0x9945ff\]\)/);
  assert.match(arcade, /solanaAtmosphere\.name='solana-atmosphere'/);
  assert.match(arcade, /const SOLANA_AMBIENT_POOLS=Object\.freeze\(\[/);
  assert.match(arcade, /pool\.userData\.decorative=true/);
  assert.match(arcade, /new THREE\.PointLight\(color,7\.5,18,2\)/);
  // Eight pools draw from the palette; the two signs that used to take one
  // each are gone, so the count drops from ten.
  assert.equal((arcade.match(/SOLANA_PALETTE\[/g) ?? []).length, 8,
    'the eight walking-route pools share the approved palette');
});

void test('no more than two Solana lights are alive near the player', async () => {
  const arcade = await readFile(path.resolve(process.cwd(), 'arcade.js'), 'utf8');

  assert.match(arcade, /beforeRenderCallbacks\.push\(now=>/);
  assert.match(arcade, /const roomLights=\[\],accentLights=\[\],muralLights=\[\],solanaLights=\[\]/);
  assert.match(arcade, /solanaLights\.sort[\s\S]+light\.visible=index<2&&distanceSq<400/);
});
