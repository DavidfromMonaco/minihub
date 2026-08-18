/**
 * View-state persistence for routing node positions.
 *
 * Node positions are purely visual and must never live inside `hub.graph`.
 * They are stored under the `graphLayout` settings key as:
 *
 *   graphLayout: {
 *     "minilab-3": { x: 120, y: 180 }
 *   }
 *
 * Nodes without a stored position get a deterministic default so the canvas
 * is stable across sessions without extra state.
 */
const KEY = 'graphLayout';

// Deterministic default placement grid.
const DEFAULT_X = 80;
const DEFAULT_Y = 80;
const COL_SPACING = 300;
const ROW_SPACING = 220;
const COLS = 3;

export class GraphLayout {
  constructor(settings) {
    this.settings = settings;
  }

  _map() {
    const map = this.settings.get(KEY);
    return map && typeof map === 'object' ? map : {};
  }

  /**
   * Resolve the position for a node. `index` is the node's position in the
   * graph's node list and is used only to derive a deterministic default.
   */
  get(nodeId, index = 0) {
    const entry = this._map()[nodeId];
    if (entry && Number.isFinite(entry.x) && Number.isFinite(entry.y)) {
      return { x: entry.x, y: entry.y };
    }
    const col = index % COLS;
    const row = Math.floor(index / COLS);
    return { x: DEFAULT_X + col * COL_SPACING, y: DEFAULT_Y + row * ROW_SPACING };
  }

  /** Persist a node position. Returns the promise from settings.set. */
  set(nodeId, x, y) {
    const map = { ...this._map(), [nodeId]: { x, y } };
    return this.settings.set(KEY, map);
  }

  /** Remove a node's stored position (e.g. when the node is deleted). */
  remove(nodeId) {
    const map = this._map();
    if (!(nodeId in map)) return;
    delete map[nodeId];
    return this.settings.set(KEY, map);
  }
}
