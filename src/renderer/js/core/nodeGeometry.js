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
export const SURFACE_NODE_HEIGHT = 166;
export const SURFACE_SCALE = 0.405;
export const SURFACE_Y = 32;
export const SURFACE_X = 3;
/** Where a surface node's remaining, non-control ports sit: one row, below it. */
export const SURFACE_PORT_ROW_Y = 146;

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
  if (node.surface) return SURFACE_NODE_HEIGHT;
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
        return { port, x: pos.x + SURFACE_X + point.x * SURFACE_SCALE,
          y: pos.y + SURFACE_Y + point.y * SURFACE_SCALE };
      });
    // A controller is both a physical MIDI source and, for the MiniLab, the
    // existing hardware MIDI destination. The faceplate takes the control ports;
    // whatever else the node declares keeps a socket, because a cable into that
    // MIDI socket is the visible authority for playthrough to the hardware
    // output. Hiding it would make a working signal path invisible.
    const midi = node.outputs.find((port) => port.type !== 'control');
    if (midi) outputs.push({ port: midi, x: pos.x + NODE_WIDTH, y: pos.y + SURFACE_PORT_ROW_Y });
    const inputs = node.inputs
      .filter((port) => port.type === 'midi')
      .map((port) => ({ port, x: pos.x, y: pos.y + SURFACE_PORT_ROW_Y }));
    return { width: NODE_WIDTH, height: SURFACE_NODE_HEIGHT, inputs, outputs };
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
