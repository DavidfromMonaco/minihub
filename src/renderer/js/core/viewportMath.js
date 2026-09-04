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

export const MIN_ZOOM = 0.25; // 25%
export const MAX_ZOOM = 2.5; // 250%
export const DEFAULT_VIEWPORT = { x: 0, y: 0, zoom: 1 };

// Fit-to-nodes defaults.
export const FIT_PADDING = 60; // screen px reserved around the fitted nodes
export const FIT_SINGLE_MAX_ZOOM = 1.5; // comfortable cap when fitting one node

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
