import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

// The mapping is browser code with no DOM dependency, so it is exercised
// directly rather than asserted against as source text: these tests fail when
// the behaviour changes, and survive the file being reformatted or retuned.
const mapping = await import(pathToFileURL(path.resolve(process.cwd(), 'emulators/gamepad-mapping.js')).href);

function pad(overrides: Record<string, unknown> = {}) {
  return {
    index: 0,
    connected: true,
    buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 })),
    axes: [0, 0, 0, 0],
    ...overrides
  };
}

void test('a held button and a squeezed analogue trigger both read as pressed', () => {
  const controller = pad();
  assert.equal(mapping.buttonPressed(controller, 0), false);
  controller.buttons[0] = { pressed: true, value: 1 };
  assert.equal(mapping.buttonPressed(controller, 0), true);
  // Some pads never latch `pressed` on the triggers, so travel counts too.
  controller.buttons[7] = { pressed: false, value: 0.9 };
  assert.equal(mapping.buttonPressed(controller, 7), true);
  controller.buttons[6] = { pressed: false, value: 0.2 };
  assert.equal(mapping.buttonPressed(controller, 6), false);
  assert.equal(mapping.buttonPressed(controller, 99), false);
  assert.equal(mapping.buttonPressed(null, 0), false);
});

void test('the pad already in use keeps the session when a second one is plugged in', () => {
  const first = pad({ index: 0 });
  const second = pad({ index: 1 });
  const pads = [first, second];
  assert.equal(mapping.pickGamepad(pads, 1), second);
  assert.equal(mapping.pickGamepad(pads, null), first);
  // getGamepads reports a sparse array with holes for empty ports.
  assert.equal(mapping.pickGamepad([null, null, second], null), second);
  // A remembered index that has since disconnected falls back to any live pad.
  assert.equal(mapping.pickGamepad([first, pad({ index: 1, connected: false })], 1), first);
  assert.equal(mapping.pickGamepad([null, null], 0), null);
  assert.equal(mapping.pickGamepad(null, null), null);
});

void test('the stick dead zone is radial, so a diagonal nudge is as dead as a straight one', () => {
  const target = { x: 0, y: 0 };
  const deadZone = 0.2;
  // .15 on each axis clears no single axis but is .21 of total deflection: a
  // per-axis dead zone would call this nothing while the stick is clearly off
  // centre, which is what made diagonals engage before cardinals.
  const diagonal = mapping.readStick(pad({ axes: [0.15, 0.15, 0, 0] }), 0, 1, deadZone, target);
  assert.ok(Math.hypot(diagonal.x, diagonal.y) > 0, 'a diagonal past the dead zone must move the player');
  const inside = mapping.readStick(pad({ axes: [0.1, 0.1, 0, 0] }), 0, 1, deadZone, target);
  assert.deepEqual({ x: inside.x, y: inside.y }, { x: 0, y: 0 });
});

void test('a fully deflected stick reaches full speed and the travel below it is rescaled', () => {
  const target = { x: 0, y: 0 };
  const full = mapping.readStick(pad({ axes: [1, 0, 0, 0] }), 0, 1, 0.2, target);
  assert.equal(Number(full.x.toFixed(6)), 1);
  // Half way between the dead zone and the rim is half speed, not 0.6 —
  // without rescaling the player could never walk slowly.
  const half = mapping.readStick(pad({ axes: [0.6, 0, 0, 0] }), 0, 1, 0.2, target);
  assert.equal(Number(half.x.toFixed(6)), 0.5);
});

void test('reading a stick reuses the caller target instead of allocating per frame', () => {
  const target = { x: 0, y: 0 };
  assert.equal(mapping.readStick(pad(), 0, 1, 0.2, target), target);
  assert.equal(mapping.readDpad(pad(), target), target);
});

void test('a connected but untouched pad reports no activity', () => {
  assert.equal(mapping.gamepadHasActivity(pad()), false);
  assert.equal(mapping.gamepadHasActivity(null), false);
  const pressed = pad();
  pressed.buttons[3] = { pressed: true, value: 1 };
  assert.equal(mapping.gamepadHasActivity(pressed), true);
  assert.equal(mapping.gamepadHasActivity(pad({ axes: [0, 0.9, 0, 0] })), true);
  // Resting drift inside the dead zone is not the player touching the pad.
  assert.equal(mapping.gamepadHasActivity(pad({ axes: [0.05, -0.04, 0, 0] })), false);
});

void test('the d-pad reads as a direction pair', () => {
  const target = { x: 0, y: 0 };
  const controller = pad();
  controller.buttons[mapping.GAMEPAD_BUTTONS.DPAD_LEFT] = { pressed: true, value: 1 };
  controller.buttons[mapping.GAMEPAD_BUTTONS.DPAD_DOWN] = { pressed: true, value: 1 };
  assert.deepEqual(mapping.readDpad(controller, target), { x: -1, y: 1 });
});
