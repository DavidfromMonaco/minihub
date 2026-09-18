/**
 * Pure world <-> viewport transform math for the Patch Bay canvas.
 *
 * World coordinates are the routing node positions (stored in `networkLayout`)
 * and cable geometry. The viewport is a single transform:
 *
 *   screen = (world - pan) * zoom
 *   world  = pan + screen / zoom
 *
 * where `pan` is the world coordinate at the top-left of the viewport and
 * `zoom` is the scale factor. Keeping one transform means no coordinate drift
 * after repeated zoom/pan operations.
 *
 * Viewport shape: { x, y, zoom } — `x`,`y` are the world coordinate of the
 * viewport's top-left corner, `zoom` is the scale.
 */

/**
 * The zoom floor, and why it is this low.
 *
 * It was 0.25, and that number was what made the canvas feel finite. Align
 * stacks every node at the same distance from the sources into one column --
 * which is what a rank means, and what every other node editor draws -- so
 * twelve nodes hanging off one controller is a column 2,560 units tall. On a
 * 1400 x 760 canvas that frames at exactly 0.250: the floor, touched. Fourteen
 * nodes need 0.208, and `fitToNodes` could not reach it, so Align laid the
 * graph out correctly and then showed you the top two thirds of it.
 *
 * 0.05 is chosen so that "frame everything" is never a lie: a fifty-node fan
 * frames at 0.049. What a node LOOKS like down there is `nodeDetail`'s
 * business, not the floor's -- refusing to zoom out is not a way to keep text
 * readable, it is a way to lose the node.
 */
export const MIN_ZOOM = 0.05; // 5%
export const MAX_ZOOM = 2.5; // 250%
export const DEFAULT_VIEWPORT = { x: 0, y: 0, zoom: 1 };

// Fit-to-nodes defaults.
export const FIT_PADDING = 60; // screen px reserved around the fitted nodes
export const FIT_SINGLE_MAX_ZOOM = 1.5; // comfortable cap when fitting one node

/** Under this, a node is drawn as a named block instead of a faceplate. */
const DETAIL_ZOOM = 0.5;
/** The title's normal size, in world units -- `.node-title` in base.css. */
const TITLE_WORLD_PX = 12;
/**
 * How big the title is allowed to grow. A node is 200 units wide and the text
 * starts 12 in, so about 30 is where a ten-character name still ends before
 * the node does; past that the clip path cuts names rather than shrinking them.
 */
const TITLE_MAX_PX = 30;
/** The on-screen size the name tries to hold on to while the node shrinks. */
const TITLE_TARGET_PX = 9;
/** The on-screen size below which a name is a smudge, not a word. */
const TITLE_LEGIBLE_PX = 5.5;

/**
 * How much of a node to draw at this zoom.
 *
 * The convention every node editor lands on: far out, the ports, badges and
 * faceplate legends stop being information and become grain, so they go, and
 * the one thing worth keeping -- which node this is -- is drawn bigger so it
 * survives the shrinking. Blender flattens the node, Blueprints drops its
 * pins; both keep the name until it too is unreadable, and then drop it.
 *
 * `far` and `mute` are published as classes and `titleSize` as a custom
 * property, so the decision is made once here and the stylesheet does the
 * drawing. Nothing is removed that cannot be reached another way: what goes
 * at `far` is the OPEN chip (double-click, and the node menu) and the rear-view
 * switch (the same switch on every other node, and the toolbar).
 */
export function nodeDetail(zoom) {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : DEFAULT_VIEWPORT.zoom;
  // Not gated on `far`: the size has to be continuous in the zoom, or crossing
  // the threshold pops the name from six pixels to eleven in one wheel notch.
  // It holds TITLE_TARGET_PX from 75% down to 30%, then decays to the cap.
  const titleSize = Math.min(TITLE_MAX_PX, Math.max(TITLE_WORLD_PX, Math.round(TITLE_TARGET_PX / z)));
  return { far: z < DETAIL_ZOOM, mute: titleSize * z < TITLE_LEGIBLE_PX, titleSize };
}

/**
 * Whether a grid whose lines are `spacing` world units apart is worth painting.
 *
 * The background is two tiled patterns, 20 and 100 units. At 25% the fine one
 * is five screen pixels apart, which is not a grid -- it is a grey wash over
 * the whole canvas, and at the new floor it is solid. Coarsening as you pull
 * back is what a grid does everywhere; eight pixels is where a line still
 * reads as a line.
 */
export function gridVisible(spacing, zoom) {
  const s = Number(spacing);
  const z = Number(zoom);
  if (!Number.isFinite(s) || !Number.isFinite(z)) return false;
  return s * z >= 8;
}

export function clampZoom(zoom) {
  if (!Number.isFinite(zoom)) return DEFAULT_VIEWPORT.zoom;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** Convert a screen point (relative to the canvas top-left) to world coords. */
export function screenToWorld(viewport, screen) {
  return {
    x: viewport.x + screen.x / viewport.zoom,
    y: viewport.y + screen.y / viewport.zoom
  };
}

/** Convert a world point to screen coords (relative to canvas top-left). */
export function worldToScreen(viewport, world) {
  return {
    x: (world.x - viewport.x) * viewport.zoom,
    y: (world.y - viewport.y) * viewport.zoom
  };
}

/**
 * Zoom to `newZoom` keeping the world point under `screen` fixed on screen.
 * Returns a new viewport with the same zoom-under-cursor behavior.
 */
export function zoomAt(viewport, screen, newZoom) {
  const z = clampZoom(newZoom);
  const world = screenToWorld(viewport, screen);
  return {
    x: world.x - screen.x / z,
    y: world.y - screen.y / z,
    zoom: z
  };
}

/**
 * Pan by a screen-space delta (e.g. right-drag). Dragging content right means
 * the viewport moves left, so pan decreases by the world-space delta.
 */
export function panBy(viewport, screenDelta) {
  return {
    x: viewport.x - screenDelta.x / viewport.zoom,
    y: viewport.y - screenDelta.y / viewport.zoom,
    zoom: viewport.zoom
  };
}

/**
 * Compute the pan for a drag from a FIXED start state and the current pointer
 * position. This is the correct model for a drag: the origin (startClient,
 * startPan, startZoom) is captured once and never replaced, so repeated
 * pointermove events cannot accumulate or amplify.
 *
 *   start  = { clientX, clientY, panX, panY, zoom }
 *   current = { clientX, clientY }
 *
 * Screen-space deltas are divided by the fixed start zoom exactly once.
 */
export function panFromStart(start, current) {
  const dx = current.clientX - start.clientX;
  const dy = current.clientY - start.clientY;
  return {
    x: start.panX - dx / start.zoom,
    y: start.panY - dy / start.zoom,
    zoom: start.zoom
  };
}

/**
 * Fit a viewport so all given node rects (world coordinates) are visible in a
 * canvas of `canvasSize` screen px, with `padding` screen px around them.
 *
 *   nodeRects  = [{ x, y, width, height }]  (world coordinates)
 *   canvasSize = { width, height }          (screen px)
 *   opts       = { padding }                (screen px, default FIT_PADDING)
 *
 * Returns a viewport { x, y, zoom } that centers the node bounding box.
 * Respects zoom limits; a single node is capped at a comfortable zoom rather
 * than zooming excessively; an empty list falls back to the default viewport.
 */
export function fitViewport(nodeRects, canvasSize, opts = {}) {
  const padding = Number.isFinite(opts.padding) ? opts.padding : FIT_PADDING;
  if (!Array.isArray(nodeRects) || nodeRects.length === 0) {
    return { ...DEFAULT_VIEWPORT };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of nodeRects) {
    const w = Number.isFinite(r.width) ? r.width : 0;
    const h = Number.isFinite(r.height) ? r.height : 0;
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + w);
    maxY = Math.max(maxY, r.y + h);
  }

  const worldW = Math.max(1, maxX - minX);
  const worldH = Math.max(1, maxY - minY);
  const availW = Math.max(1, canvasSize.width - 2 * padding);
  const availH = Math.max(1, canvasSize.height - 2 * padding);

  let zoom = Math.min(availW / worldW, availH / worldH);
  zoom = clampZoom(zoom);
  if (nodeRects.length === 1) {
    zoom = Math.min(zoom, FIT_SINGLE_MAX_ZOOM);
  }

  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  return {
    x: centerX - canvasSize.width / 2 / zoom,
    y: centerY - canvasSize.height / 2 / zoom,
    zoom
  };
}
