/**
 * View-state persistence for the Patch Bay viewport (pan + zoom).
 *
 * Viewport state is purely visual and must never live inside `hub.graph`.
 * It is stored under the `graphViewport` settings key as:
 *
 *   graphViewport: { x: 0, y: 0, zoom: 1 }
 *
 * where `x`/`y` are the world coordinate at the viewport's top-left corner
 * and `zoom` is the scale factor. Node positions stay in `graphLayout`.
 */
import { DEFAULT_VIEWPORT, clampZoom } from './viewportMath.js';

const KEY = 'graphViewport';

export class GraphViewport {
  constructor(settings) {
    this.settings = settings;
  }

  /** Load the persisted viewport, falling back to defaults. */
  load() {
    const v = this.settings.get(KEY);
    return {
      x: v && Number.isFinite(v.x) ? v.x : DEFAULT_VIEWPORT.x,
      y: v && Number.isFinite(v.y) ? v.y : DEFAULT_VIEWPORT.y,
      zoom: v && Number.isFinite(v.zoom) ? clampZoom(v.zoom) : DEFAULT_VIEWPORT.zoom
    };
  }

  /** Persist a viewport. Zoom is clamped to valid limits. */
  save(x, y, zoom) {
    return this.settings.set(KEY, {
      x,
      y,
      zoom: clampZoom(zoom)
    });
  }

  /** Reset to defaults (zoom 100%, pan 0,0). */
  reset() {
    return this.settings.set(KEY, { ...DEFAULT_VIEWPORT });
  }
}
