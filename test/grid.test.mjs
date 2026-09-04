import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHub } from './helpers.mjs';
import {
  GRID_SIZE,
  snapToGrid,
  snapPoint,
  dragPosition
} from '../src/renderer/js/core/grid.js';
import { NetworkLayout } from '../src/renderer/js/core/networkLayout.js';

const START = { x: 0, y: 0, clientX: 0, clientY: 0 };

// ---- shared constant --------------------------------------------------------
test('visual grid and snap logic share the same GRID_SIZE', () => {
  assert.equal(GRID_SIZE, 20);
  // snapToGrid must be derived from GRID_SIZE, not a separate magic number.
  assert.equal(snapToGrid(GRID_SIZE), GRID_SIZE);
  assert.equal(snapToGrid(GRID_SIZE * 3), GRID_SIZE * 3);
});

// ---- nearest-grid calculation ------------------------------------------------
test('snapToGrid rounds to the nearest grid point', () => {
  assert.equal(snapToGrid(0), 0);
  assert.equal(snapToGrid(20), 20);
  assert.equal(snapToGrid(25), 20);
  assert.equal(snapToGrid(34), 40);
  assert.equal(snapToGrid(9), 0);
});

test('snapToGrid handles positive coordinates', () => {
  assert.equal(snapToGrid(25), 20);
  assert.equal(snapToGrid(55), 60);
});

test('snapToGrid handles negative coordinates', () => {
  assert.equal(snapToGrid(-25), -20);
  assert.equal(snapToGrid(-34), -40);
  assert.equal(snapToGrid(-55), -60);
});

test('exact grid coordinates remain unchanged', () => {
  for (const v of [0, 20, 40, 60, -20, -40, 100]) {
    assert.equal(snapToGrid(v), v, `snapToGrid(${v}) should be identity`);
  }
});

test('snapPoint snaps both axes', () => {
  assert.deepEqual(snapPoint(25, 34), { x: 20, y: 40 });
});

// ---- free vs ctrl drag ------------------------------------------------------
test('free drag does not snap', () => {
  const pos = dragPosition(START, { clientX: 23, clientY: 17 }, 1, false);
  assert.deepEqual(pos, { x: 23, y: 17 });
});

test('Ctrl-drag snaps to the grid', () => {
  const pos = dragPosition(START, { clientX: 23, clientY: 17 }, 1, true);
  assert.deepEqual(pos, { x: 20, y: 20 });
});

test('Ctrl can be enabled during a drag', () => {
  // First pointermove without Ctrl -> free position.
  const free = dragPosition(START, { clientX: 23, clientY: 17 }, 1, false);
  assert.deepEqual(free, { x: 23, y: 17 });
  // Later pointermove with Ctrl -> snapped position (same fixed start).
  const snapped = dragPosition(START, { clientX: 23, clientY: 17 }, 1, true);
  assert.deepEqual(snapped, { x: 20, y: 20 });
});

test('Ctrl can be released during a drag', () => {
  const snapped = dragPosition(START, { clientX: 23, clientY: 17 }, 1, true);
  assert.deepEqual(snapped, { x: 20, y: 20 });
  const free = dragPosition(START, { clientX: 23, clientY: 17 }, 1, false);
  assert.deepEqual(free, { x: 23, y: 17 }); // free path restored
});

// ---- zoom independence ------------------------------------------------------
test('snapping produces identical world coordinates regardless of zoom', () => {
  // Same world displacement reached via different screen deltas at different zooms.
  const a = dragPosition(START, { clientX: 100, clientY: 0 }, 1, true); // world 100
  const b = dragPosition(START, { clientX: 200, clientY: 0 }, 2, true); // world 100
  assert.deepEqual(a, b);
  assert.deepEqual(a, { x: 100, y: 0 });

  const c = dragPosition(START, { clientX: 50, clientY: 0 }, 0.5, true); // world 100
  assert.deepEqual(c, a);
});

test('free drag also produces identical world coords regardless of zoom', () => {
  const a = dragPosition(START, { clientX: 100, clientY: 0 }, 1, false);
  const b = dragPosition(START, { clientX: 200, clientY: 0 }, 2, false);
  assert.deepEqual(a, b);
  assert.deepEqual(a, { x: 100, y: 0 });
});

// ---- pan/zoom do not change routing or node world positions ------------------
test('pan/zoom do not change routing or node world positions', async () => {
  const hub = makeHub();
  hub.network.addNode({ id: 'a', name: 'A', outputs: [{ id: 'o', type: 'midi' }] });
  hub.network.addNode({ id: 'b', name: 'B', inputs: [{ id: 'i', type: 'midi' }] });
  hub.network.connect('a', 'o', 'b', 'i');
  const layout = new NetworkLayout(hub.settings);
  await layout.set('a', 100, 100);
  await layout.set('b', 600, 100);
  const beforeLayout = hub.settings.get('networkLayout');
  const beforeNetwork = hub.network.serialize();

  // Simulate dragging at several zooms (free + snapped) and persisting.
  for (const zoom of [0.25, 0.5, 1, 1.5, 2.5]) {
    const free = dragPosition({ x: 100, y: 100, clientX: 0, clientY: 0 }, { clientX: 40, clientY: 20 }, zoom, false);
    const snapped = dragPosition({ x: 100, y: 100, clientX: 0, clientY: 0 }, { clientX: 40, clientY: 20 }, zoom, true);
    await layout.set('a', free.x, free.y);
    await layout.set('a', snapped.x, snapped.y);
  }

  // Routing is untouched by any of this.
  assert.deepEqual(hub.network.serialize(), beforeNetwork);
  assert.equal(hub.network.connections().length, 1);
  // Only node 'a' position changed; 'b' and the network are intact.
  assert.deepEqual(hub.settings.get('networkLayout').b, beforeLayout.b);
});
