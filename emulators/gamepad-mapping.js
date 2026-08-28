/**
 * One reading of the W3C Standard Gamepad, shared by the arcade walker and the
 * PS2 frame. Both surfaces used to carry their own copy of these indexes,
 * thresholds, and dead zones, and the two copies had already drifted apart.
 *
 * Every function here is pure and allocation-free: they run once per animation
 * frame per surface, so a returned object would be garbage on every frame.
 * Callers pass a reusable target where a pair of numbers has to come back.
 */

/** Standard Gamepad button indexes. Names follow the physical layout. */
export const GAMEPAD_BUTTONS = Object.freeze({
  SOUTH: 0, EAST: 1, WEST: 2, NORTH: 3,
  L1: 4, R1: 5, L2: 6, R2: 7,
  SELECT: 8, START: 9,
  L3: 10, R3: 11,
  DPAD_UP: 12, DPAD_DOWN: 13, DPAD_LEFT: 14, DPAD_RIGHT: 15
});

export const GAMEPAD_AXES = Object.freeze({ LEFT_X: 0, LEFT_Y: 1, RIGHT_X: 2, RIGHT_Y: 3 });

/**
 * Analogue triggers report a value without ever latching `pressed` on some
 * pads, so a trigger counts as held once it passes this much of its travel.
 */
export const BUTTON_PRESS_THRESHOLD = 0.55;

/** Enough to swallow a worn stick's resting drift without eating slow walks. */
export const DEFAULT_DEAD_ZONE = 0.18;

export function buttonPressed(pad, index) {
  const button = pad?.buttons?.[index];
  if (!button) return false;
  return button.pressed === true || button.value > BUTTON_PRESS_THRESHOLD;
}

export function axisValue(pad, index) {
  const value = pad?.axes?.[index];
  return Number.isFinite(value) ? value : 0;
}

/**
 * Picks the pad to drive from, preferring the one already in use so a second
 * connected controller cannot steal the session mid-walk. `pads` is the live
 * `navigator.getGamepads()` result, which is a sparse array with null holes —
 * indexed here rather than spread, because this runs every frame.
 */
export function pickGamepad(pads, preferredIndex) {
  if (!pads) return null;
  if (preferredIndex !== null && preferredIndex !== undefined) {
    const preferred = pads[preferredIndex];
    if (preferred?.connected) return preferred;
  }
  for (let index = 0; index < pads.length; index += 1) {
    const pad = pads[index];
    if (pad?.connected) return pad;
  }
  return null;
}

/**
 * Radial dead zone: the magnitude of the pair is tested, not each axis alone.
 * Per-axis dead zones make a square hole, so a diagonal push engages while the
 * same physical deflection straight ahead does nothing. Past the threshold the
 * remaining travel is rescaled to a full 0..1 so slow walking survives.
 */
export function readStick(pad, axisX, axisY, deadZone, target) {
  const rawX = axisValue(pad, axisX), rawY = axisValue(pad, axisY);
  const magnitude = Math.hypot(rawX, rawY);
  if (magnitude <= deadZone) {
    target.x = 0;
    target.y = 0;
    return target;
  }
  const scale = Math.min(1, (magnitude - deadZone) / (1 - deadZone)) / magnitude;
  target.x = rawX * scale;
  target.y = rawY * scale;
  return target;
}

/** Single-axis reading, for surfaces that map a stick onto digital keys. */
export function readAxis(pad, axis, deadZone) {
  const raw = axisValue(pad, axis);
  const magnitude = Math.abs(raw);
  if (magnitude <= deadZone) return 0;
  return Math.sign(raw) * Math.min(1, (magnitude - deadZone) / (1 - deadZone));
}

/**
 * Whether the player is actually touching the pad. A connected-but-idle
 * controller must not count as input: the arcade grants control to whichever
 * device the player is using, and a pad left plugged in behind the monitor
 * would otherwise hold that grant forever.
 */
export function gamepadHasActivity(pad, deadZone = DEFAULT_DEAD_ZONE) {
  if (!pad) return false;
  const buttons = pad.buttons;
  if (buttons) for (let index = 0; index < buttons.length; index += 1) {
    if (buttonPressed(pad, index)) return true;
  }
  // Only the four stick axes. Pads that fall outside the standard mapping put
  // a hat switch on a further axis and rest it at a value like 3.29 — reading
  // every axis meant one of those counted as a player's hands on the sticks
  // from the moment it was plugged in, which is the state this test exists to
  // rule out. Anything a non-standard axis carries reaches us as a button.
  const axes = pad.axes;
  if (axes) for (let index = GAMEPAD_AXES.LEFT_X; index <= GAMEPAD_AXES.RIGHT_Y; index += 1) {
    const value = axes[index];
    if (Number.isFinite(value) && Math.abs(value) > deadZone) return true;
  }
  return false;
}

/** D-pad as a -1/0/1 pair, so it can stand in for the left stick. */
export function readDpad(pad, target) {
  target.x = (buttonPressed(pad, GAMEPAD_BUTTONS.DPAD_RIGHT) ? 1 : 0) - (buttonPressed(pad, GAMEPAD_BUTTONS.DPAD_LEFT) ? 1 : 0);
  target.y = (buttonPressed(pad, GAMEPAD_BUTTONS.DPAD_DOWN) ? 1 : 0) - (buttonPressed(pad, GAMEPAD_BUTTONS.DPAD_UP) ? 1 : 0);
  return target;
}
