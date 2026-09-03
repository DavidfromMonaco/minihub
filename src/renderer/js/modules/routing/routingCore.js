/**
 * Pure, DOM-free logic for the Routing / Patch Bay editor.
 *
 * This module is the only place that translates between the visual editor
 * and `hub.graph`. It never stores routing state itself — it always derives
 * the visual model from the graph on demand, and it mutates routing only
 * through the graph API.
 *
 * Keeping this logic separate from the SVG rendering makes it directly
 * testable in Node without a DOM.
 */

export const PORT_TYPES = ['midi', 'audio', 'control', 'preset'];

/**
 * Secondary distinction for each port type (beyond color) so ports are not
 * identified by color alone. `shape` drives the jack glyph, `label` the text.
 */
export function portTypeInfo(type) {
  switch (type) {
    case 'midi':
      return { label: 'MIDI', shape: 'square', className: 'midi' };
    case 'audio':
      return { label: 'AUDIO', shape: 'circle', className: 'audio' };
    case 'control':
      return { label: 'CTRL', shape: 'triangle', className: 'control' };
    case 'preset':
      return { label: 'PRESET', shape: 'diamond', className: 'preset' };
    default:
      return { label: String(type).toUpperCase(), shape: 'circle', className: '' };
  }
}

/** Ports are compatible only when their types match exactly. */
export function canConnect(fromPort, toPort) {
  return Boolean(
    fromPort &&
      toPort &&
      fromPort.type &&
      fromPort.type === toPort.type
  );
}

/** Map graph nodes to the visual node model (id, name, type, inputs, outputs). */
export function buildVisualNodes(graph) {
  return graph.listNodes().map((node) => ({
    id: node.id,
    name: node.name,
    type: node.type || null,
    inputs: (node.inputs || []).map((p) => ({ ...p })),
    outputs: (node.outputs || []).map((p) => ({ ...p }))
  }));
}

/** Map graph connections to the visual cable model. */
export function buildVisualConnections(graph) {
  return graph.connections().map((c, i) => ({
    id: `cable-${i}`,
    from: { ...c.from },
    to: { ...c.to }
  }));
}

/**
 * Attempt to create a connection through the graph API.
 * Returns { ok: true } on success or { ok: false, reason } on rejection.
 * Never touches graph state directly — always goes through `graph.connect`.
 */
export function createConnection(graph, from, to) {
  const fromNode = graph.getNode(from.nodeId);
  const toNode = graph.getNode(to.nodeId);
  const fromPort = fromNode && fromNode.outputs.find((p) => p.id === from.portId);
  const toPort = toNode && toNode.inputs.find((p) => p.id === to.portId);

  if (!fromPort || !toPort) {
    return { ok: false, reason: 'unknown-port' };
  }
  if (!canConnect(fromPort, toPort)) {
    return { ok: false, reason: 'incompatible' };
  }
  try {
    graph.connect(from.nodeId, from.portId, to.nodeId, to.portId);
    return { ok: true };
  } catch (err) {
    // e.g. duplicate connection.
    return { ok: false, reason: err.message || 'rejected' };
  }
}

/** Remove a connection through the graph API. Returns true if removed. */
export function deleteConnection(graph, connection) {
  return graph.disconnect(
    connection.from.nodeId,
    connection.from.portId,
    connection.to.nodeId,
    connection.to.portId
  );
}
