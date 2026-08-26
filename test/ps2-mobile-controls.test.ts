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

void test('the PS2 frame cache key changes with the mobile control release', () => {
  assert.match(adapter, /index\.html\?v=ps2-touch-1/);
});
