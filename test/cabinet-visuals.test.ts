import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

void test('console controllers fit within and rest on the cabinet control deck', async () => {
  const arcade = await readFile(path.resolve(process.cwd(), 'arcade.js'), 'utf8');

  assert.match(arcade, /const CONTROLLER_DECK=\{width:\.58,depth:\.34\}/);
  assert.match(arcade, /mount\.position\.set\(0,1\.465,\.52\);mount\.rotation\.x=\.16/);
  assert.match(arcade, /-scaled\.min\.y\+config\.offset\[1\]/);
});

void test('the custom Crash and Gex cabinets use PlayStation controllers', async () => {
  const arcade = await readFile(path.resolve(process.cwd(), 'arcade.js'), 'utf8');

  assert.match(arcade, /makeCabinet\('gex-enter-the-gecko',[^\n]+false,true,'psx'\)/);
  assert.match(arcade, /makeCabinet\('crash-bandicoot',[^\n]+true,false,'psx'\)/);
});
