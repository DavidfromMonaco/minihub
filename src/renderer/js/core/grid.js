/**
 * Shared grid constants + helpers for the Patch Bay.
 *
 * `GRID_SIZE` is the single source of truth for both the visual background
 * grid and node snapping, so the visible grid and the snap grid always share
 * the same origin (world 0,0) and spacing. All values are world coordinates.
 */

export const GRID_SIZE = 20; // world units

/** Round a world coordinate to the nearest grid point. */
export function snapToGrid(value) {
  return Math.round(value / GRID_SIZE) * GRID_SIZE;
}

/** Round a world point to the nearest grid point. */
export function snapPoint(x, y) {
  return { x: snapToGrid(x), y: snapToGrid(y) };
}

/**
 * Compute a node's world position during a drag from a FIXED start state and
 * the current pointer, optionally snapping to the grid.
 *
 *   start  = { x, y, clientX, clientY }  (world pos + initial pointer)
 *   current = { clientX, clientY }        (current pointer)
 *   zoom   = viewport zoom (screen -> world scale)
 *   snap   = whether Ctrl is held (snap to grid)
 *
 * Screen deltas are divided by zoom once to stay in world coordinates, then
 * optionally snapped. The origin is captured once and never replaced, so
 * repeated pointermove events cannot accumulate.
 */
export function dragPosition(start, current, zoom, snap) {
  const dx = (current.clientX - start.clientX) / zoom;
  const dy = (current.clientY - start.clientY) / zoom;
  let x = Math.round(start.x + dx);
  let y = Math.round(start.y + dy);
  if (snap) {
    x = snapToGrid(x);
    y = snapToGrid(y);
  }
  return { x, y };
}
