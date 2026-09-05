/**
 * Centralized Patch Bay node geometry.
 *
 * A node is split into two visual areas:
 *   - an upper identity/content area (family surface, title, badges)
 *   - a lower I/O dock (dark/neutral, holds the routing ports)
 *
 * All dimensions used by the SVG renderer, cable endpoints, port hit areas,
 * node dragging, and fit/reset view are derived here so there is a single
 * source of truth for node size. The I/O dock has a sensible minimum height
 * and grows when a node exposes more ports.
 */
export const NODE_WIDTH = 200;
export const IDENTITY_H = 88; // upper identity/content area height
export const DOCK_MIN_H = 46; // I/O dock minimum height
export const PORT_ROW = 30; // vertical spacing between ports
export const PAD_BOTTOM = 12; // padding below the last port row

/**
 * A node that carries a `surface` draws its control ports where the device puts
 * them, instead of stacking them in the dock. These four numbers are how MiniHub
 * frames such a surface inside a node; they are rendering, not hardware, which is
 * why they live here and the coordinates live in the profile.
 *
 * They used to be named after one device, next to a `node.id === MINILAB_NODE_ID`
 * branch. Stacking 25 control ports at PORT_ROW would make a node about 760 px
 * tall, so the branch was not decoration -- it was the only thing standing
 * between a controller and an unusable node. It is now a property a node
 * declares, which is what lets a second device have one.
 */
export const SURFACE_Y = 32;
export const SURFACE_X = 3;
/** Room under the panel: the view switch, and the row of the node's own ports. */
const SURFACE_DOCK_H = 41;
// The port row, then the view switch under it, then a margin. The switch used
// to be drawn ON the port row, across the input port's label.
const SURFACE_PAD_BOTTOM = 42;

/**
 * How far the device's own coordinates are shrunk to fit the node.
 *
 * It was `0.405`, which is `(200 - 6) / 480` -- the MiniLab 3's width, resolved
 * once and frozen. Any narrower device was then drawn small in a node sized for
 * a MiniLab, with the empty band at the right and below filled by the node's
 * labels; any wider one would have run past the node's edge. The scale is the
 * profile's business, so it is computed from the surface the node carries.
 */
/** The socket a control port draws, across. Nothing smaller can be clicked. */
const SOCKET_W = 11;
/** Past this a node stops being a node and becomes a wall. */
const NODE_WIDTH_MAX = 520;

/**
 * How wide a node that draws a panel is.
 *
 * `NODE_WIDTH` for everything else, and for a controller whose panel is roomy
 * enough at that width -- the MiniLab 3 is, its tightest pair sitting 28 units
 * apart. A denser device is drawn WIDER instead of being crushed: the BeatStep
 * has 13 units between two buttons, and at 200 that leaves 6 for an 11-unit
 * socket. Rescaling the drawing cannot create that room; only the node can.
 */
export function surfaceWidth(surface) {
  const gap = surface?.minGap;
  const width = surface?.width;
  if (!Number.isFinite(gap) || gap <= 0 || !Number.isFinite(width) || width <= 0) return NODE_WIDTH;
  const needed = Math.ceil(width * (SOCKET_W / gap)) + SURFACE_X * 2;
  return Math.min(NODE_WIDTH_MAX, Math.max(NODE_WIDTH, needed));
}

/** The width of any node, panel or not. */
export function nodeWidth(node) {
  return node?.surface ? surfaceWidth(node.surface) : NODE_WIDTH;
}

export function surfaceScale(surface) {
  const width = surface?.width;
  return Number.isFinite(width) && width > 0 ? (surfaceWidth(surface) - SURFACE_X * 2) / width : 1;
}

/**
 * The drawn height of the panel, in node units.
 *
 * Rounded, because everything below it is a socket centre: cables, hit areas and
 * drag targets all resolve against these numbers, and a quarter of a pixel of
 * drift between two of them is a cable that no longer meets its own socket.
 */
export function surfaceHeight(surface) {
  const height = surface?.height;
  return Number.isFinite(height) && height > 0 ? Math.round(height * surfaceScale(surface)) : 0;
}

/** Where a surface node's remaining, non-control ports sit: one row, below it. */
export function surfacePortRowY(surface) {
  return SURFACE_Y + surfaceHeight(surface) + SURFACE_DOCK_H;
}

/** Total height of a node that draws a panel. Follows the panel, not a device. */
export function surfaceNodeHeight(surface) {
  return surfacePortRowY(surface) + SURFACE_PAD_BOTTOM;
}

/** Height of the lower I/O dock (grows with the number of port rows). */
export function dockHeight(node) {
  const rows = Math.max(node.inputs.length, node.outputs.length);
  return Math.max(DOCK_MIN_H, rows * PORT_ROW + PAD_BOTTOM);
}

/** Total node height (identity area + I/O dock). */
export function identityHeight(node) {
  return IDENTITY_H;
}

export function nodeHeight(node) {
  if (node.surface) return surfaceNodeHeight(node.surface);
  return identityHeight(node) + dockHeight(node);
}

/** World Y of a port row (ports live inside the I/O dock). */
export function portY(node, index) {
  return identityHeight(node) + (index + 0.5) * PORT_ROW;
}

/**
 * Compute the full geometry of a node at a world position, including the
 * resolved world coordinates of every input/output port. Used for cable
 * endpoints, hit areas, and bounds.
 */
export function nodeGeometry(node, pos) {
  if (node.surface) {
    const outputs = node.outputs
      .filter((port) => port.type === 'control' && node.surface.ports[port.id])
      .map((port) => {
        const point = node.surface.ports[port.id];
        const scale = surfaceScale(node.surface);
        return { port, x: pos.x + SURFACE_X + point.x * scale,
          y: pos.y + SURFACE_Y + point.y * scale };
      });
    // A controller is both a physical MIDI source and, for the MiniLab, the
    // existing hardware MIDI destination. The faceplate takes the control ports;
    // whatever else the node declares keeps a socket, because a cable into that
    // MIDI socket is the visible authority for playthrough to the hardware
    // output. Hiding it would make a working signal path invisible.
    const midi = node.outputs.find((port) => port.type !== 'control');
    if (midi) outputs.push({ port: midi, x: pos.x + surfaceWidth(node.surface), y: pos.y + surfacePortRowY(node.surface) });
    const inputs = node.inputs
      .filter((port) => port.type === 'midi')
      .map((port) => ({ port, x: pos.x, y: pos.y + surfacePortRowY(node.surface) }));
    return { width: surfaceWidth(node.surface), height: surfaceNodeHeight(node.surface), inputs, outputs };
  }
  const inputs = node.inputs.map((p, i) => ({
    port: p,
    x: pos.x,
    y: pos.y + portY(node, i)
  }));
  const outputs = node.outputs.map((p, i) => ({
    port: p,
    x: pos.x + NODE_WIDTH,
    y: pos.y + portY(node, i)
  }));
  return { width: NODE_WIDTH, height: nodeHeight(node), inputs, outputs };
}
