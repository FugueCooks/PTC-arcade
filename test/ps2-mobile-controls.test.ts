import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const frame = readFileSync(resolve('emulators/play/index.html'), 'utf8');
const adapter = readFileSync(resolve('emulators/adapters/play-ps2-adapter.js'), 'utf8');

void test('Play PS2 exposes a touch-only complete controller overlay', () => {
  assert.match(frame, /id="ps2-touch-controls"/);
  assert.match(frame, /navigator\.maxTouchPoints > 0/);
  assert.match(frame, /matchMedia\('\(pointer: coarse\)'\)/);
  for (const label of ['Move up', 'Move down', 'Move left', 'Move right', 'Camera up', 'Camera down', 'Triangle', 'Square', 'Circle', 'Cross', 'L1', 'L2', 'R1', 'R2', 'Start', 'Select']) {
    assert.match(frame, new RegExp(`aria-label="${label}"`, 'i'), `missing ${label}`);
  }
});

void test('touch controls use Play upstream key codes and support simultaneous holds', () => {
  for (const mapping of ['KeyT ArrowUp', 'KeyF ArrowLeft', 'KeyH ArrowRight', 'KeyG ArrowDown', 'KeyA', 'KeyZ', 'KeyS', 'KeyX', 'Enter', 'Backspace', 'Key1', 'Key2', 'Key8', 'Key9', 'KeyJ', 'KeyL', 'KeyI', 'KeyK']) {
    assert.match(frame, new RegExp(`data-ps2-keys="${mapping}"`), `missing mapping ${mapping}`);
  }
  assert.match(frame, /const activeTouchKeys = new Map\(\)/);
  assert.match(frame, /button\.setPointerCapture\?\.\(event\.pointerId\)/);
  assert.match(frame, /\['pointerup', 'pointercancel', 'lostpointercapture'\]/);
  assert.match(frame, /canvas\.dispatchEvent\(event\)/);
  assert.match(frame, /for \(const code of active\.codes\) dispatchPs2Key\(code, false\)/);
});

void test('the PS2 frame cache key changes with the shared-input release', () => {
  assert.match(adapter, /index\.html\?v=runtime-visible-1/);
});

void test('Play PS2 maps a standard physical gamepad and exposes its controls panel', () => {
  assert.match(frame, /import \{[^}]*pickGamepad[^}]*\} from '\.\.\/gamepad-mapping\.js/, 'the frame shares the arcade mapping');
  assert.match(frame, /id="ps2-controller-toggle"/);
  assert.match(frame, /id="ps2-controller-status"/);
  for (const button of ['SOUTH', 'EAST', 'WEST', 'NORTH', 'L1', 'R1', 'L2', 'R2', 'SELECT', 'START', 'DPAD_UP', 'DPAD_DOWN', 'DPAD_LEFT', 'DPAD_RIGHT']) {
    assert.match(frame, new RegExp(`GAMEPAD_BUTTONS\\.${button}`), `missing standard gamepad button ${button}`);
  }
  for (const axis of ['LEFT_X', 'LEFT_Y', 'RIGHT_X', 'RIGHT_Y']) assert.match(frame, new RegExp(`GAMEPAD_AXES\\.${axis}`));
  assert.match(frame, /setGamepadKey\(binding\.code/);
});

void test('the PS2 controller poll idles when no pad is connected', () => {
  // This shares a frame budget with a PS2 core. The old poll ran an animation
  // frame forever on machines with no controller, and rewrote the status line
  // and re-queried its elements on every one of them.
  assert.match(frame, /gamepadPollHandle = null;/);
  assert.match(frame, /function scheduleGamepadPoll\(\) \{\s*if \(gamepadPollHandle === null\)/);
  assert.match(frame, /addEventListener\('gamepadconnected'[\s\S]{0,600}scheduleGamepadPoll\(\)/);
  assert.doesNotMatch(frame, /controllerStatus\.textContent = /, 'the status line is written through setControllerStatus, which only writes on change');
  const poll = frame.slice(frame.indexOf('function pollPs2Gamepad()'), frame.indexOf('function scheduleGamepadPoll()'));
  assert.doesNotMatch(poll, /document\.querySelector/, 'the poll must hold its element references, not re-query them each frame');
});

void test('the PS2 frame offers the controls its core can actually honour', () => {
  // EmulatorJS ships a whole frontend, so the other cabinets get save states,
  // pause and the rest. Play! is a bare core and keeps its Emscripten module in
  // its own scope: there is no pause, no reset, no save state to call. What can
  // be reached is what the core is built on, and nothing here claims more.
  assert.match(frame, /id="ps2-toolbar"/);
  for (const control of ['ps2-mute', 'ps2-fullscreen', 'ps2-restart', 'ps2-exit']) {
    assert.match(frame, new RegExp(`id="${control}"`), `the toolbar is missing ${control}`);
  }
  // Pause was built and removed: Play! emulates on worker threads, so holding
  // the main thread's animation frames left the core running at full speed
  // behind a button that said RESUME.
  assert.doesNotMatch(frame, /id="ps2-pause"/, 'a pause button that cannot pause must not ship');
  assert.doesNotMatch(frame, /emulatorPaused/);
  // Mute suspends the context the core created, because the graph between its
  // source and the speakers belongs to the core and has no gain to turn.
  assert.match(frame, /audioContexts\.push\(context\)/, 'the audio context has to be captured before the core makes it');
  assert.match(frame, /context\.suspend\?\.\(\)/);
});

void test('a frame without threads says so instead of quietly crawling', () => {
  // Without cross-origin isolation the core loses SharedArrayBuffer and runs
  // single-threaded, which is the difference between 56 f/s and a slideshow —
  // and is otherwise invisible.
  assert.match(frame, /!crossOriginIsolated \|\| typeof SharedArrayBuffer === 'undefined'/);
  assert.match(frame, /RUNNING WITHOUT THREADS/);
  assert.match(frame, /arcade:ps2-degraded/);
});

void test('the PS2 pad can be remapped, and the layout survives a reload', () => {
  // Remapping never reaches the core: every control here ends up as one of the
  // keys Play! already listens for, so this rebinds which physical button
  // produces that key and nothing more.
  assert.match(frame, /id="ps2-remap"/);
  assert.match(frame, /const GAMEPAD_BINDING_STORAGE = 'ps2-gamepad-bindings-v1'/);
  assert.match(frame, /localStorage\.setItem\(GAMEPAD_BINDING_STORAGE/);
  for (const label of ['CROSS', 'CIRCLE', 'SQUARE', 'TRIANGLE', 'SELECT', 'START']) {
    assert.match(frame, new RegExp(`'${label}'`), `the remap panel must name ${label}`);
  }

  // A saved layout is merged over the defaults per control, so a binding added
  // to the core later still appears for someone who customised theirs first,
  // and a stored entry for a control that no longer exists is ignored.
  assert.match(frame, /const bindings = DEFAULT_GAMEPAD_KEY_BINDINGS\.map\(binding => \(\{ \.\.\.binding \}\)\)/);
  assert.match(frame, /Number\.isSafeInteger\(button\) && button >= 0 && button < 32/);

  // One physical button drives one control, and an unbound control never fires
  // from button 0 by accident.
  assert.match(frame, /if \(binding\.button === button && binding\.code !== code\) binding\.button = -1/);
  assert.match(frame, /binding\.button >= 0 && buttonPressed\(gamepad, binding\.button\)/);

  // And the press that binds a control is not also played into the game.
  assert.match(frame, /if \(listeningFor\) \{/);
  assert.match(frame, /releaseGamepadKeys\(\);/);
});

void test('the PS2 output is presented on a stable pixel grid', () => {
  // The core held 55 f/s while the picture still shimmered, which puts the
  // fault in presentation rather than emulation: a 640x480 buffer was being
  // smoothed onto a fractional number of screen pixels, so every frame landed
  // on a slightly different grid and the image crawled under a moving camera.
  // Every other emulator screen in the arcade already draws pixelated.
  assert.match(frame, /image-rendering:pixelated/);
  assert.doesNotMatch(frame, /#outputCanvas \{ width:100%; height:100%; min-height:0; object-fit:contain/, 'the stretched canvas is what caused the resampling');
  assert.match(frame, /function presentAtWholeScale\(\)/);
  // Snapped only when it is nearly free: a panel that fits 1.9 times would drop
  // to 1 and show the game at half the size it could be.
  assert.match(frame, /whole >= 1 && whole \/ fitted >= \.85 \? whole : fitted/);
  // Re-measured when the panel changes and when the core switches video mode.
  assert.match(frame, /new ResizeObserver\(presentAtWholeScale\)/);
  assert.match(frame, /attributeFilter: \['width', 'height'\]/);
});

void test('the arcade stops compositing itself while a game runs', async () => {
  // The arcade stops rendering when an emulator starts, but its WebGL canvas
  // stayed in the page beneath a translucent modal. A non-opaque layer above a
  // GPU layer means the compositor cannot skip what is underneath, so every
  // emulator frame was blended over a live canvas — a cost that exists only
  // inside the arcade, which is exactly why a frame opened on its own always
  // measured fine and the cabinet still felt bad.
  const { readFile } = await import('node:fs/promises');
  const pathModule = await import('node:path');
  const css = await readFile(pathModule.resolve(process.cwd(), 'style.css'), 'utf8');
  const arcadeSource = await readFile(pathModule.resolve(process.cwd(), 'arcade.js'), 'utf8');

  assert.match(arcadeSource, /renderer\.domElement\.id='arcade-canvas'/, 'the canvas needs a handle to be hidden by');
  assert.match(css, /body\.emulator-running #arcade-canvas \{ display:none; \}/);
  // And the backdrop over it becomes opaque, or hiding the canvas gains nothing.
  assert.match(css, /body\.emulator-running #machine-modal \{ background:#06030b; \}/);
});
