/**
 * Routing graph owned by the Hub.
 *
 * Nodes declare typed input/output ports. Connections link a source output
 * port to a compatible target input port (same type). Data flows from a
 * source node through the graph to connected targets — modules never call
 * each other directly.
 *
 * Port types: 'midi' | 'audio' | 'control'. Only 'midi' is functional for now;
 * 'audio' and 'control' are declared for future use and are not processed.
 *
 * Routing state is fully independent of UI focus: changing which module is
 * visible never affects the graph.
 */
export class Graph {
  constructor(events, settings) {
    this.events = events;
    this.settings = settings;
    this._nodes = new Map(); // nodeId -> node
    this._connections = []; // [{ from: {nodeId, portId}, to: {nodeId, portId} }]
  }

  // ---------- nodes ----------

  addNode(node) {
    if (!node || typeof node.id !== 'string' || !node.id) {
      throw new Error('Node must have a string id');
    }
    if (this._nodes.has(node.id)) {
      throw new Error(`Node already registered: ${node.id}`);
    }
    this._nodes.set(node.id, {
      id: node.id,
      name: node.name || node.id,
      type: node.type || null,
      inputs: node.inputs || [],
      outputs: node.outputs || [],
      onInput: typeof node.onInput === 'function' ? node.onInput : null
    });
    this._emit({ type: 'add', nodeId: node.id });
  }

  removeNode(id) {
    const node = this._nodes.get(id);
    if (!node) return false;
    this._nodes.delete(id);
    this._connections = this._connections.filter(
      (c) => c.from.nodeId !== id && c.to.nodeId !== id
    );
    this._persist();
    this._emit({ type: 'remove', nodeId: id });
    return true;
  }

  getNode(id) {
    return this._nodes.get(id);
  }

  listNodes() {
    return [...this._nodes.values()];
  }

  // ---------- connections ----------

  /**
   * Connect a source output port to a compatible target input port.
   * Rejects unknown ports, incompatible types, and duplicates.
   */
  connect(fromNodeId, fromPortId, toNodeId, toPortId) {
    const fromNode = this._nodes.get(fromNodeId);
    const toNode = this._nodes.get(toNodeId);
    if (!fromNode) throw new Error(`Unknown source node: ${fromNodeId}`);
    if (!toNode) throw new Error(`Unknown target node: ${toNodeId}`);

    const fromPort = fromNode.outputs.find((p) => p.id === fromPortId);
    const toPort = toNode.inputs.find((p) => p.id === toPortId);
    if (!fromPort) throw new Error(`Unknown output port: ${fromNodeId}.${fromPortId}`);
    if (!toPort) throw new Error(`Unknown input port: ${toNodeId}.${toPortId}`);
    if (fromPort.type !== toPort.type) {
      throw new Error(`Incompatible port types: ${fromPort.type} -> ${toPort.type}`);
    }
    if (this._hasConnection(fromNodeId, fromPortId, toNodeId, toPortId)) {
      throw new Error('Connection already exists');
    }

    const conn = {
      from: { nodeId: fromNodeId, portId: fromPortId },
      to: { nodeId: toNodeId, portId: toPortId }
    };
    this._connections.push(conn);
    this._persist();
    this._emit({ type: 'connect', from: { ...conn.from }, to: { ...conn.to } });
    return true;
  }

  disconnect(fromNodeId, fromPortId, toNodeId, toPortId) {
    const idx = this._connections.findIndex(
      (c) =>
        c.from.nodeId === fromNodeId &&
        c.from.portId === fromPortId &&
        c.to.nodeId === toNodeId &&
        c.to.portId === toPortId
    );
    if (idx === -1) return false;
    this._connections.splice(idx, 1);
    this._persist();
    this._emit({
      type: 'disconnect',
      from: { nodeId: fromNodeId, portId: fromPortId },
      to: { nodeId: toNodeId, portId: toPortId }
    });
    return true;
  }

  _hasConnection(fromNodeId, fromPortId, toNodeId, toPortId) {
    return this._connections.some(
      (c) =>
        c.from.nodeId === fromNodeId &&
        c.from.portId === fromPortId &&
        c.to.nodeId === toNodeId &&
        c.to.portId === toPortId
    );
  }

  /** All connections (copy). */
  connections() {
    return this._connections.map((c) => ({
      from: { ...c.from },
      to: { ...c.to }
    }));
  }

  /** Connections originating from a node (optionally a specific port). */
  connectionsFrom(nodeId, portId) {
    return this._connections.filter(
      (c) =>
        c.from.nodeId === nodeId &&
        (portId === undefined || c.from.portId === portId)
    );
  }

  /** Connections targeting a node (optionally a specific port). */
  connectionsTo(nodeId, portId) {
    return this._connections.filter(
      (c) =>
        c.to.nodeId === nodeId &&
        (portId === undefined || c.to.portId === portId)
    );
  }

  // ---------- topology queries ----------

  /** Node ids that feed into the given node. */
  upstream(nodeId) {
    const result = new Set();
    for (const c of this._connections) {
      if (c.to.nodeId === nodeId) result.add(c.from.nodeId);
    }
    return [...result];
  }

  /** Node ids that receive data from the given node. */
  downstream(nodeId) {
    const result = new Set();
    for (const c of this._connections) {
      if (c.from.nodeId === nodeId) result.add(c.to.nodeId);
    }
    return [...result];
  }

  // ---------- data flow ----------

  /**
   * A source node pushes data into the graph on one of its output ports.
   * The graph forwards it to every connected target's onInput handler.
   */
  emitData(nodeId, portId, data) {
    const node = this._nodes.get(nodeId);
    if (!node) return;
    const port = node.outputs.find((p) => p.id === portId);
    if (!port) return;
    for (const conn of this.connectionsFrom(nodeId, portId)) {
      const target = this._nodes.get(conn.to.nodeId);
      if (target && target.onInput) {
        try {
          target.onInput(conn.to.portId, data);
        } catch (err) {
          console.error(`[graph] onInput failed for "${target.id}":`, err);
        }
      }
    }
  }

  // ---------- persistence ----------

  serialize() {
    return this._connections.map((c) => ({
      from: { ...c.from },
      to: { ...c.to }
    }));
  }

  _persist() {
    this.settings.set('graphConnections', this.serialize());
  }

  /** Restore persisted connections (after nodes have been registered). */
  restore(connections) {
    if (!Array.isArray(connections)) return;
    for (const c of connections) {
      try {
        this.connect(c.from.nodeId, c.from.portId, c.to.nodeId, c.to.portId);
      } catch (err) {
        // Skip invalid/stale connections (e.g. a node no longer present).
        console.warn('[graph] skipped invalid connection:', err.message);
      }
    }
  }

  _emit(change) {
    this.events.emit('graph:change', { ...change, connections: this.serialize() });
  }
}
