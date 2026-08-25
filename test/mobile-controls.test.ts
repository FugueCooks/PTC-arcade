import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

void test('touch devices receive independent movement, look, use, and view controls', async () => {
  const [markup, styles, arcade] = await Promise.all([
    readFile(path.resolve(process.cwd(), 'index.html'), 'utf8'),
    readFile(path.resolve(process.cwd(), 'style.css'), 'utf8'),
    readFile(path.resolve(process.cwd(), 'arcade.js'), 'utf8')
  ]);

  assert.match(markup, /id="mobile-move-zone"/);
  assert.match(markup, /id="mobile-look-zone"/);
  assert.match(markup, /id="mobile-use"/);
  assert.match(markup, /id="mobile-view"/);
  assert.match(styles, /body\.mobile-input\.arcade-started:not\(\.cabinet-open\)/);
  assert.match(styles, /touch-action:none/);
  assert.match(arcade, /mobileViewportQuery=matchMedia\('\(max-width: 720px\)'\)/);
  assert.match(arcade, /mobileViewportQuery\.addEventListener\('change',syncMobileInputMode\)/);
  assert.match(arcade, /movementVector\.set\([^\n]+mobileMove\.x[^\n]+mobileMove\.y/);
  assert.match(arcade, /yaw-=dx\*\.006/);
  assert.match(arcade, /mobileInputAvailable\(\)\?'TAP USE':'PRESS E'/);
  assert.match(arcade, /if\(!mobileInputAvailable\(\)\)renderer\.domElement\.requestPointerLock\(\)/);
});
