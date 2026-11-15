// Tests: the arithmetic that keeps the overlay's panel inside the window when it's dragged, resized or put back on a
// new page (src/placement.ts).
// How: boxes and windows as plain numbers; no browser.
// Passes when: a box always ends wholly inside the window and at least the minimum size (unless the window is
// smaller), a resize keeps the opposite edge still, and only a well-formed placement is read back from storage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EDGE_GAP, MIN_HEIGHT, MIN_WIDTH, fitBox, movedBox, placementOf, resizedBox } from '../src/placement.ts';

const viewport = { width: 1200, height: 800 };
const box = { left: 780, top: 12, width: 400, height: 776 };

test('a box already inside the window is left as it is', () => {
  assert.deepEqual(fitBox(box, viewport), box);
});

test('a box saved on a wider window is pulled back inside a smaller one, and shrunk to fit it', () => {
  assert.deepEqual(fitBox({ left: 1500, top: 100, width: 500, height: 900 }, viewport), { left: 1200 - 500 - EDGE_GAP, top: EDGE_GAP, width: 500, height: 800 - 2 * EDGE_GAP });
});

test('a box is never smaller than the minimum, unless the window itself is smaller', () => {
  assert.deepEqual(fitBox({ left: 100, top: 100, width: 50, height: 50 }, viewport), { left: 100, top: 100, width: MIN_WIDTH, height: MIN_HEIGHT });
  const tiny = { width: 300, height: 300 };
  assert.deepEqual(fitBox(box, tiny), { left: EDGE_GAP, top: EDGE_GAP, width: 300 - 2 * EDGE_GAP, height: 300 - 2 * EDGE_GAP });
});

test('a drag moves the box, and stops it at the window edge', () => {
  assert.deepEqual(movedBox(box, -300, 0, viewport), { ...box, left: 480 });
  assert.deepEqual(movedBox({ ...box, height: 400 }, -5000, 5000, viewport), { left: EDGE_GAP, top: 800 - 400 - EDGE_GAP, width: 400, height: 400 });
});

test('the left grip widens the box to the left with its right edge still, down to the minimum width and up to the window', () => {
  const right = box.left + box.width;
  const wider = resizedBox(box, 'left', -200, 0, viewport);
  assert.deepEqual(wider, { ...box, left: 580, width: 600 });
  assert.equal(resizedBox(box, 'left', 300, 0, viewport).width, MIN_WIDTH);
  assert.equal(resizedBox(box, 'left', 300, 0, viewport).left + MIN_WIDTH, right);
  assert.deepEqual(resizedBox(box, 'left', -5000, 0, viewport), { ...box, left: EDGE_GAP, width: right - EDGE_GAP });
});

test('the top grip changes the height with the bottom still; the bottom-left corner moves the left and the bottom', () => {
  const short = { left: 700, top: 300, width: 400, height: 400 };
  assert.deepEqual(resizedBox(short, 'top', 0, -100, viewport), { ...short, top: 200, height: 500 });
  assert.deepEqual(resizedBox(short, 'top', 0, 200, viewport), { ...short, top: 700 - MIN_HEIGHT, height: MIN_HEIGHT });
  assert.deepEqual(resizedBox(short, 'bottom-left', -100, 50, viewport), { left: 600, top: 300, width: 500, height: 450 });
  assert.equal(resizedBox(short, 'bottom-left', 0, 5000, viewport).height, 800 - EDGE_GAP - 300);
});

test('only a well-formed placement is read back from storage', () => {
  assert.deepEqual(placementOf({ box: null, folded: true }), { box: null, folded: true });
  assert.deepEqual(placementOf({ box, folded: false }), { box, folded: false });
  for (const bad of [null, 'left', {}, { box: null }, { box, folded: 'no' }, { box: { ...box, width: '400' }, folded: false }, { box: { ...box, top: Number.NaN }, folded: false }]) {
    assert.equal(placementOf(bad), null, JSON.stringify(bad));
  }
});
