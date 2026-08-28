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

// What the mapping itself does is covered by gamepad-mapping.test.ts against
// the real module. What is left here is the wiring that only exists in this
// file: which action each button reaches, and when the pad holds control.
void test('standard gamepads can move, look, interact, and switch arcade camera mode', async () => {
  const arcade = await readFile(path.resolve(process.cwd(), 'arcade.js'), 'utf8');
  assert.match(arcade, /from '\.\/emulators\/gamepad-mapping\.js/, 'the arcade shares one gamepad mapping with the emulator frames');
  assert.match(arcade, /pickGamepad\(navigator\.getGamepads\?\.\(\),activeGamepadIndex\)/);
  assert.match(arcade, /consumeGamepadPress\(pad,GAMEPAD_BUTTONS\.SOUTH,\(\)=>\{if\(!activeCabinet\)interactWithNearbyCabinet\(\)\}\)/);
  assert.match(arcade, /consumeGamepadPress\(pad,GAMEPAD_BUTTONS\.NORTH,toggleCameraMode\)/);
  assert.match(arcade, /consumeGamepadPress\(pad,GAMEPAD_BUTTONS\.EAST,\(\)=>\{if\(activeCabinet\)closeMachine\(\)/);
  assert.match(arcade, /mobileMove\.x\+gamepadMove\.x/);
  assert.match(arcade, /mobileMove\.y\+gamepadMove\.y/);
});

void test('the arcade follows the device the player last touched', async () => {
  const arcade = await readFile(path.resolve(process.cwd(), 'arcade.js'), 'utf8');
  // A pad left plugged in behind the monitor must not hold the HUD hints or
  // the movement grant: engagement follows activity, and keyboard or mouse
  // input hands both straight back.
  assert.match(arcade, /if\(gamepadHasActivity\(pad,GAMEPAD_DEAD_ZONE\)\)setGamepadEngaged\(true\)/);
  assert.match(arcade, /if\(!gamepadEngaged\)return false/);
  assert.match(arcade, /classList\.toggle\('gamepad-input',engaged\)/, 'the gamepad HUD class has to come back off again');
  assert.match(arcade, /addEventListener\('keydown',e=>\{keys\[e\.code\]=true;setGamepadEngaged\(false\)/);
  assert.match(arcade, /if\(e\.movementX\|\|e\.movementY\)setGamepadEngaged\(false\)/);
});

void test('an open cabinet keeps the camera, and analogue sticks keep their magnitude', async () => {
  const arcade = await readFile(path.resolve(process.cwd(), 'arcade.js'), 'utf8');
  // Look is read inside a !activeCabinet branch: a right stick that swung the
  // camera behind the modal left the player facing elsewhere on close.
  const poll = arcade.slice(arcade.indexOf('function pollArcadeGamepad('));
  const look = poll.slice(poll.indexOf('if(!activeCabinet){'), poll.indexOf('consumeGamepadPress(pad,GAMEPAD_BUTTONS.SOUTH,()=>'));
  assert.match(look, /readStick\(pad,GAMEPAD_AXES\.RIGHT_X,GAMEPAD_AXES\.RIGHT_Y/);
  assert.match(look, /yaw-=gamepadLook\.x/);
  // Normalising alone threw away how far the stick was pushed, so every input
  // walked at exactly one speed.
  assert.match(arcade, /const analogSpeed=Math\.min\(1,movementVector\.length\(\)\)/);
  assert.match(arcade, /multiplyScalar\(d\*5\*analogSpeed\)/);
});
