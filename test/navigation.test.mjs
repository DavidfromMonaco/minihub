import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHub } from './helpers.mjs';
import {
  MIN_ZOOM,
  MAX_ZOOM,
  clampZoom,
  screenToWorld,
  worldToScreen,
  zoomAt,
  panBy,
  panFromStart,
  DEFAULT_VIEWPORT
} from '../src/renderer/js/core/viewportMath.js';
import { GraphViewport } from '../src/renderer/js/core/graphViewport.js';
import { GraphLayout } from '../src/renderer/js/core/graphLayout.js';

const approx = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ~= ${b}`);

// ---- zoom limits ------------------------------------------------------------
test('zoom is clamped to 25%..250%', () => {
  assert.equal(clampZoom(0.1), MIN_ZOOM);
  assert.equal(clampZoom(3), MAX_ZOOM);
  assert.equal(clampZoom(1), 1);
  assert.equal(clampZoom(0.5), 0.5);
  assert.equal(clampZoom(NaN), 1);
  assert.equal(clampZoom(Infinity), 1); // non-finite -> default 100%
});

test('zoomAt clamps the new zoom', () => {
  const v = zoomAt(DEFAULT_VIEWPORT, { x: 100, y: 100 }, 10);
  assert.equal(v.zoom, MAX_ZOOM);
  const v2 = zoomAt(DEFAULT_VIEWPORT, { x: 100, y: 100 }, 0.01);
  assert.equal(v2.zoom, MIN_ZOOM);
});

// ---- zoom around cursor -----------------------------------------------------
test('zoomAt keeps the world point under the cursor fixed', () => {
  const viewport = { x: 40, y: -20, zoom: 1 };
  const screen = { x: 120, y: 80 };
  const before = screenToWorld(viewport, screen);
  for (const z of [0.5, 1.5, 2.5, 0.25]) {
    const next = zoomAt(viewport, screen, z);
    const after = screenToWorld(next, screen);
    approx(after.x, before.x);
    approx(after.y, before.y);
    assert.equal(next.zoom, z);
  }
});

test('zooming in narrows the visible world region (anchored at cursor)', () => {
  const viewport = { x: 0, y: 0, zoom: 1 };
  const next = zoomAt(viewport, { x: 200, y: 200 }, 2);
  // The cursor world point (200,200) must remain under screen (200,200).
  assert.deepEqual(screenToWorld(next, { x: 200, y: 200 }), { x: 200, y: 200 });
  assert.equal(next.zoom, 2);
});

// ---- pan --------------------------------------------------------------------
test('panBy moves the viewport opposite the drag direction in world units', () => {
  const viewport = { x: 0, y: 0, zoom: 1 };
  // Drag content right by 100px -> viewport moves left by 100 world units.
  assert.deepEqual(panBy(viewport, { x: 100, y: 0 }), { x: -100, y: 0, zoom: 1 });
  assert.deepEqual(panBy(viewport, { x: 0, y: 50 }), { x: 0, y: -50, zoom: 1 });
});

test('panBy scales screen delta by 1/zoom', () => {
  const viewport = { x: 0, y: 0, zoom: 2 };
  const next = panBy(viewport, { x: 100, y: 200 });
  assert.deepEqual(next, { x: -50, y: -100, zoom: 2 });
});

// ---- transform consistency (no drift) ---------------------------------------
test('world<->screen round-trips are stable across transforms', () => {
  const viewports = [
    { x: 0, y: 0, zoom: 1 },
    { x: -300, y: 120, zoom: 0.5 },
    { x: 500, y: -40, zoom: 2.5 },
    { x: 12.5, y: -7.25, zoom: 1.7 }
  ];
  for (const v of viewports) {
    const world = { x: 123.4, y: -56.7 };
    const screen = worldToScreen(v, world);
    const back = screenToWorld(v, screen);
    approx(back.x, world.x);
    approx(back.y, world.y);
  }
});

// ---- connection coordinates remain correct after transform ------------------
test('connection endpoints map to correct screen positions after pan/zoom', () => {
  const viewport = { x: 0, y: 0, zoom: 1 };
  // A connection between two nodes' ports in world coordinates.
  const fromWorld = { x: 200, y: 100 }; // output jack
  const toWorld = { x: 600, y: 100 }; // input jack

  // At 1x the screen positions equal world positions.
  assert.deepEqual(worldToScreen(viewport, fromWorld), fromWorld);
  assert.deepEqual(worldToScreen(viewport, toWorld), toWorld);

  // After zooming 2x around the origin, both endpoints scale together, so the
  // cable still terminates exactly at the port screen positions.
  const zoomed = zoomAt(viewport, { x: 0, y: 0 }, 2);
  const fromScreen = worldToScreen(zoomed, fromWorld);
  const toScreen = worldToScreen(zoomed, toWorld);
  assert.deepEqual(fromScreen, { x: 400, y: 200 });
  assert.deepEqual(toScreen, { x: 1200, y: 200 });
  // Round-trip back to the same world coords (no drift).
  assert.deepEqual(screenToWorld(zoomed, fromScreen), fromWorld);
  assert.deepEqual(screenToWorld(zoomed, toScreen), toWorld);
});

// ---- viewport persistence ----------------------------------------------------
test('viewport persists under graphViewport and loads back', async () => {
  const hub = makeHub();
  const vp = new GraphViewport(hub.settings);
  await vp.save(120, -80, 1.5);
  assert.deepEqual(hub.settings.get('graphViewport'), { x: 120, y: -80, zoom: 1.5 });
  const loaded = vp.load();
  assert.deepEqual(loaded, { x: 120, y: -80, zoom: 1.5 });
});

test('viewport load falls back to defaults and clamps zoom', async () => {
  const hub = makeHub();
  const vp = new GraphViewport(hub.settings);
  assert.deepEqual(vp.load(), DEFAULT_VIEWPORT);
  await vp.save(0, 0, 9);
  assert.equal(vp.load().zoom, MAX_ZOOM);
});

test('Reset View restores zoom 100% and default pan', async () => {
  const hub = makeHub();
  const vp = new GraphViewport(hub.settings);
  await vp.save(300, -40, 2.2);
  await vp.reset();
  assert.deepEqual(hub.settings.get('graphViewport'), DEFAULT_VIEWPORT);
  assert.deepEqual(vp.load(), DEFAULT_VIEWPORT);
});

// ---- routing state independent from viewport --------------------------------
test('viewport changes never touch routing state', async () => {
  const hub = makeHub();
  hub.graph.addNode({ id: 'a', name: 'A', outputs: [{ id: 'o', type: 'midi' }] });
  hub.graph.addNode({ id: 'b', name: 'B', inputs: [{ id: 'i', type: 'midi' }] });
  hub.graph.connect('a', 'o', 'b', 'i');
  const before = hub.graph.serialize();

  const vp = new GraphViewport(hub.settings);
  await vp.save(-500, 300, 0.5);
  await vp.reset();
  await vp.save(10, 20, 2);

  assert.deepEqual(hub.graph.serialize(), before, 'routing must be unchanged');
  assert.equal(hub.graph.connections().length, 1);
  assert.deepEqual(hub.settings.get('graphConnections'), before);
});

// ---- pan interaction (fixed-start model) -------------------------------------
// A drag of +100 physical screen px X must move the canvas content +100 px on
// screen, at every zoom level — no amplification, no inversion.
function contentDisplacement(startViewport, dragStart, dragEnd, worldPoint) {
  const start = {
    clientX: dragStart.x,
    clientY: dragStart.y,
    panX: startViewport.x,
    panY: startViewport.y,
    zoom: startViewport.zoom
  };
  const pan = panFromStart(start, { clientX: dragEnd.x, clientY: dragEnd.y });
  const v = { x: pan.x, y: pan.y, zoom: pan.zoom };
  const s0 = worldToScreen(startViewport, worldPoint);
  const s1 = worldToScreen(v, worldPoint);
  return { x: s1.x - s0.x, y: s1.y - s0.y };
}

test('pan: +100px X follows content +100px on screen at every zoom', () => {
  const world = { x: 300, y: 200 };
  for (const zoom of [0.25, 0.5, 1, 1.5, 2.5]) {
    const vp = { x: 40, y: -30, zoom };
    const d = contentDisplacement(vp, { x: 10, y: 10 }, { x: 110, y: 10 }, world);
    approx(d.x, 100);
    approx(d.y, 0);
  }
});

test('pan: -100px X follows content -100px on screen at every zoom', () => {
  const world = { x: 300, y: 200 };
  for (const zoom of [0.25, 0.5, 1, 1.5, 2.5]) {
    const vp = { x: 40, y: -30, zoom };
    const d = contentDisplacement(vp, { x: 110, y: 10 }, { x: 10, y: 10 }, world);
    approx(d.x, -100);
    approx(d.y, 0);
  }
});

test('pan: +100px Y follows content +100px on screen at every zoom', () => {
  const world = { x: 300, y: 200 };
  for (const zoom of [0.25, 0.5, 1, 1.5, 2.5]) {
    const vp = { x: 40, y: -30, zoom };
    const d = contentDisplacement(vp, { x: 10, y: 10 }, { x: 10, y: 110 }, world);
    approx(d.x, 0);
    approx(d.y, 100);
  }
});

test('pan: -100px Y follows content -100px on screen at every zoom', () => {
  const world = { x: 300, y: 200 };
  for (const zoom of [0.25, 0.5, 1, 1.5, 2.5]) {
    const vp = { x: 40, y: -30, zoom };
    const d = contentDisplacement(vp, { x: 10, y: 110 }, { x: 10, y: 10 }, world);
    approx(d.x, 0);
    approx(d.y, -100);
  }
});

test('pan: repeated pointermove events do not accumulate or amplify', () => {
  const startViewport = { x: 0, y: 0, zoom: 2 };
  const start = { clientX: 0, clientY: 0, panX: 0, panY: 0, zoom: 2 };
  const world = { x: 500, y: 500 };

  // Simulate a single drag firing many pointermove events with cumulative
  // cursor positions. Each move is computed from the FIXED start, so the final
  // pan equals panFromStart(start, final) — no accumulation.
  let last = null;
  for (const n of [25, 50, 75, 100]) {
    last = panFromStart(start, { clientX: n, clientY: 0 });
    const d = contentDisplacement(startViewport, { x: 0, y: 0 }, { x: n, y: 0 }, world);
    approx(d.x, n); // content follows exactly, no amplification
  }
  const direct = panFromStart(start, { clientX: 100, clientY: 0 });
  assert.deepEqual(last, direct);
  assert.deepEqual(last, { x: -50, y: 0, zoom: 2 });
});

// ---- node positions remain world coordinates --------------------------------
test('node positions are stored as world coordinates, not screen', async () => {
  const hub = makeHub();
  const layout = new GraphLayout(hub.settings);
  await layout.set('minilab-3', 120, 180);
  const stored = layout.get('minilab-3', 0);
  assert.deepEqual(stored, { x: 120, y: 180 });

  // Under a zoomed/panned viewport the screen position differs from the stored
  // world coordinate, proving the stored value is world-space.
  const screen = worldToScreen({ x: 50, y: 0, zoom: 2 }, stored);
  assert.deepEqual(screen, { x: 140, y: 360 });
});
