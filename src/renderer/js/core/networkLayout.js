/**
 * View-state persistence for routing node positions.
 *
 * Node positions are purely visual and must never live inside `hub.network`.
 * They are stored under the `networkLayout` settings key as:
 *
 *   networkLayout: {
 *     "minilab-3": { x: 120, y: 180 }
 *   }
 *
 * Nodes without a stored position get a deterministic default so the canvas
 * is stable across sessions without extra state.
 */
const KEY = 'networkLayout';

// Deterministic default placement grid.
const DEFAULT_X = 80;
const DEFAULT_Y = 80;
const COLS = 3;
/** Clear space kept between two nodes, in world units. */
export const NODE_GAP = 40;

/**
 * Where a set of nodes goes when nobody has placed them, given their SIZES.
 *
 * The grid used to be `300 x 220` per cell, which was 200-wide nodes plus room
 * to breathe -- true of every node until a controller started being drawn at the
 * width its device needs. A BeatStep node is 361 x 262, so it reached 61 units
 * into its right-hand neighbour and 42 into the one below, and the Patch Bay
 * opened on a pile.
 *
 * Each column is as wide as its widest node and each row as tall as its tallest,
 * so the grid is the content's, not a guess about it.
 */
export function gridPositions(sizes, { startX = DEFAULT_X, startY = DEFAULT_Y, gap = NODE_GAP, cols = COLS } = {}) {
  const colWidth = [];
  const rowHeight = [];
  sizes.forEach((size, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    colWidth[col] = Math.max(colWidth[col] ?? 0, Number.isFinite(size?.width) ? size.width : 0);
    rowHeight[row] = Math.max(rowHeight[row] ?? 0, Number.isFinite(size?.height) ? size.height : 0);
  });
  const colX = [];
  const rowY = [];
  let x = startX;
  colWidth.forEach((width, col) => { colX[col] = x; x += width + gap; });
  let y = startY;
  rowHeight.forEach((height, row) => { rowY[row] = y; y += height + gap; });
  return sizes.map((_, index) => ({ x: colX[index % cols], y: rowY[Math.floor(index / cols)] }));
}

/**
 * Push apart nodes that overlap, moving each one as little as possible.
 *
 * Needed because positions are PERSISTED: a canvas laid out when every node was
 * 200 wide keeps those coordinates, and the node that grew now sits on top of
 * its neighbour. Nothing here invents a layout -- it separates what already
 * exists, along whichever axis costs the smaller move, so a row stays a row.
 *
 * Deterministic: the order of `rects` decides who yields, and the earlier node
 * never moves. Returns only the nodes that actually moved.
 */
export function separateOverlaps(rects, gap = NODE_GAP, passes = 8) {
  const boxes = rects.map((rect) => ({ ...rect }));
  for (let pass = 0; pass < passes; pass += 1) {
    let moved = false;
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i];
        const b = boxes[j];
        const overlapX = Math.min(a.x + a.width + gap, b.x + b.width + gap) - Math.max(a.x, b.x);
        const overlapY = Math.min(a.y + a.height + gap, b.y + b.height + gap) - Math.max(a.y, b.y);
        if (overlapX <= 0 || overlapY <= 0) continue;
        // The cheaper direction, and always away from the node that was there
        // first, so a nudge cannot cascade back over what it just cleared.
        if (overlapX <= overlapY) b.x += b.x >= a.x ? overlapX : -overlapX;
        else b.y += b.y >= a.y ? overlapY : -overlapY;
        moved = true;
      }
    }
    if (!moved) break;
  }
  const changed = new Map();
  boxes.forEach((box, index) => {
    const before = rects[index];
    if (box.x !== before.x || box.y !== before.y) changed.set(box.id, { x: box.x, y: box.y });
  });
  return changed;
}

export class NetworkLayout {
  constructor(settings) {
    this.settings = settings;
  }

  _map() {
    const map = this.settings.get(KEY);
    return map && typeof map === 'object' ? map : {};
  }

  /**
   * Resolve the position for a node. `index` is the node's position in the
   * network's node list and is used only to derive a deterministic default.
   */
  get(nodeId, index = 0, sizes = null) {
    const entry = this._map()[nodeId];
    if (entry && Number.isFinite(entry.x) && Number.isFinite(entry.y)) {
      return { x: entry.x, y: entry.y };
    }
    // `sizes` is every node's box, in the same order as the indexes handed to
    // this method: a cell is only as wide as what goes in it.
    const grid = gridPositions(Array.isArray(sizes) && sizes.length ? sizes : [{ width: 200, height: 200 }],
      {});
    return grid[Math.min(index, grid.length - 1)] ?? { x: DEFAULT_X, y: DEFAULT_Y };
  }

  /** Persist several positions at once, e.g. after separating overlaps. */
  setMany(entries) {
    if (!entries || entries.size === 0) return;
    const map = { ...this._map() };
    for (const [nodeId, pos] of entries) map[nodeId] = { x: pos.x, y: pos.y };
    return this.settings.set(KEY, map);
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
