import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHub } from './helpers.mjs';
import {
  fitViewport,
  worldToScreen,
  MIN_ZOOM,
  MAX_ZOOM,
  FIT_PADDING,
  FIT_SINGLE_MAX_ZOOM,
  DEFAULT_VIEWPORT
} from '../src/renderer/js/core/viewportMath.js';
import { NetworkViewport } from '../src/renderer/js/core/networkViewport.js';
import { NetworkLayout } from '../src/renderer/js/core/networkLayout.js';

const CANVAS = { width: 800, height: 600 };

function visibleWorldRect(view, canvas) {
  return { x: view.x, y: view.y, width: canvas.width / view.zoom, height: canvas.height / view.zoom };
}

function isVisible(rect, view, canvas) {
  const v = visibleWorldRect(view, canvas);
  return (
    rect.x >= v.x &&
    rect.y >= v.y &&
    rect.x + rect.width <= v.x + v.width &&
    rect.y + rect.height <= v.y + v.height
  );
}

function bbox(rects) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  return { minX, minY, maxX, maxY };
}

// ---- one node ---------------------------------------------------------------
test('fit view with a single node centers it at a comfortable zoom', () => {
  const rects = [{ x: 100, y: 200, width: 200, height: 80 }];
  const view = fitViewport(rects, CANVAS);
  assert.ok(view.zoom <= FIT_SINGLE_MAX_ZOOM, 'single node zoom should be capped');
  assert.ok(view.zoom >= MIN_ZOOM && view.zoom <= MAX_ZOOM);
  assert.ok(isVisible(rects[0], view, CANVAS), 'single node should be visible');
  // Centered: the node center maps to the canvas center.
  const center = worldToScreen(view, { x: 200, y: 240 });
  assert.ok(Math.abs(center.x - CANVAS.width / 2) < 1e-6);
  assert.ok(Math.abs(center.y - CANVAS.height / 2) < 1e-6);
});

// ---- multiple nodes ---------------------------------------------------------
test('fit view with multiple nodes makes all visible and centered', () => {
  const rects = [
    { x: 100, y: 100, width: 200, height: 80 },
    { x: 900, y: 500, width: 200, height: 80 }
  ];
  const view = fitViewport(rects, CANVAS);
  assert.ok(view.zoom >= MIN_ZOOM && view.zoom <= MAX_ZOOM);
  for (const r of rects) {
    assert.ok(isVisible(r, view, CANVAS), `node at (${r.x},${r.y}) should be visible`);
  }
  const b = bbox(rects);
  const center = worldToScreen(view, { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });
  assert.ok(Math.abs(center.x - CANVAS.width / 2) < 1e-6);
  assert.ok(Math.abs(center.y - CANVAS.height / 2) < 1e-6);
});

// ---- padding ----------------------------------------------------------------
test('fit preserves padding around the node bounding box', () => {
  const rects = [
    { x: 100, y: 100, width: 200, height: 80 },
    { x: 700, y: 300, width: 200, height: 80 }
  ];
  const view = fitViewport(rects, CANVAS);
  const b = bbox(rects);
  const topLeft = worldToScreen(view, { x: b.minX, y: b.minY });
  const bottomRight = worldToScreen(view, { x: b.maxX, y: b.maxY });
  // The bbox should be inset from the canvas edges by (at least) the padding.
  assert.ok(topLeft.x >= FIT_PADDING - 1e-6, `left padding ${topLeft.x} >= ${FIT_PADDING}`);
  assert.ok(topLeft.y >= FIT_PADDING - 1e-6, `top padding ${topLeft.y} >= ${FIT_PADDING}`);
  assert.ok(bottomRight.x <= CANVAS.width - FIT_PADDING + 1e-6);
  assert.ok(bottomRight.y <= CANVAS.height - FIT_PADDING + 1e-6);
});

// ---- zoom limits ------------------------------------------------------------
test('fit respects zoom limits (huge network clamps to min zoom)', () => {
  const rects = [
    { x: 0, y: 0, width: 200, height: 80 },
    { x: 20000, y: 20000, width: 200, height: 80 }
  ];
  const view = fitViewport(rects, CANVAS);
  assert.equal(view.zoom, MIN_ZOOM);
});

test('fit single node does not zoom above comfortable cap', () => {
  const rects = [{ x: 0, y: 0, width: 200, height: 80 }];
  const view = fitViewport(rects, CANVAS);
  assert.equal(view.zoom, FIT_SINGLE_MAX_ZOOM);
});

// ---- empty network ------------------------------------------------------------
test('fit with no nodes falls back to the default viewport', () => {
  assert.deepEqual(fitViewport([], CANVAS), DEFAULT_VIEWPORT);
  assert.deepEqual(fitViewport(null, CANVAS), DEFAULT_VIEWPORT);
});

// ---- Reset View does not change node positions / routing --------------------
test('fit + persist does not change node positions or routing', async () => {
  const hub = makeHub();
  hub.network.addNode({ id: 'a', name: 'A', outputs: [{ id: 'o', type: 'midi' }] });
  hub.network.addNode({ id: 'b', name: 'B', inputs: [{ id: 'i', type: 'midi' }] });
  hub.network.connect('a', 'o', 'b', 'i');
  const layout = new NetworkLayout(hub.settings);
  await layout.set('a', 100, 100);
  await layout.set('b', 600, 100);
  const beforeLayout = hub.settings.get('networkLayout');
  const beforeNetwork = hub.network.serialize();

  const rects = [
    { x: 100, y: 100, width: 200, height: 80 },
    { x: 600, y: 100, width: 200, height: 80 }
  ];
  const fit = fitViewport(rects, CANVAS);
  const vp = new NetworkViewport(hub.settings);
  await vp.save(fit.x, fit.y, fit.zoom);

  assert.deepEqual(hub.settings.get('networkLayout'), beforeLayout, 'node positions unchanged');
  assert.deepEqual(hub.network.serialize(), beforeNetwork, 'routing unchanged');
  assert.equal(hub.network.connections().length, 1);
});

// ---- persisted viewport restored on normal reopening ------------------------
test('persisted viewport is restored on normal reopening', async () => {
  const hub = makeHub();
  const vp = new NetworkViewport(hub.settings);
  await vp.save(-300, 150, 0.8);
  // Simulate reopening: load from settings.
  const loaded = vp.load();
  assert.deepEqual(loaded, { x: -300, y: 150, zoom: 0.8 });
});
