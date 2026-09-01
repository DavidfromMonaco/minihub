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
import { miniLabPatchPortPosition } from '../ui/miniLabControlSurface.js';

export const NODE_WIDTH = 200;
export const IDENTITY_H = 88; // upper identity/content area height
export const DOCK_MIN_H = 46; // I/O dock minimum height
export const PORT_ROW = 30; // vertical spacing between ports
export const PAD_BOTTOM = 12; // padding below the last port row
export const MINILAB_NODE_HEIGHT = 166;
export const MINILAB_SURFACE_SCALE = 0.405;
export const MINILAB_SURFACE_Y = 32;
export const MINILAB_SURFACE_X = 3;

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
  if (node.id === 'minilab-3') return MINILAB_NODE_HEIGHT;
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
  if (node.id === 'minilab-3') {
    const controls = node.outputs.filter((port) => port.type === 'control');
    const outputs = controls.map((port) => {
      const point = miniLabPatchPortPosition(port.id);
      return { port, x: pos.x + MINILAB_SURFACE_X + point.x * MINILAB_SURFACE_SCALE,
        y: pos.y + MINILAB_SURFACE_Y + point.y * MINILAB_SURFACE_SCALE };
    });
    const midi = node.outputs.find((port) => port.id === 'midi-out');
    if (midi) outputs.push({ port: midi, x: pos.x + NODE_WIDTH, y: pos.y + 146 });
    // MiniLab is both a physical MIDI source and the existing hardware MIDI
    // destination. Keep its special control-surface geometry, but do not hide
    // the declared MIDI input: a cable into that socket is the visible
    // authority for renderer playthrough to the selected hardware output.
    const inputs = node.inputs
      .filter((port) => port.type === 'midi')
      .map((port) => ({ port, x: pos.x, y: pos.y + 146 }));
    return { width: NODE_WIDTH, height: MINILAB_NODE_HEIGHT, inputs, outputs };
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
