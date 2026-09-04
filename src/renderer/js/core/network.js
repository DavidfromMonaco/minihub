/**
 * Routing network owned by the Hub.
 *
 * Nodes declare typed input/output ports. Connections link a source output
 * port to a compatible target input port (same type). Data flows from a
 * source node through the network to connected targets — modules never call
 * each other directly.
 *
 * Port types: 'midi' | 'audio' | 'control'.
 *   midi     carries real MIDI events through `emitData` to connected nodes
 *   audio    carries no samples through this network - audio never crosses the
 *            Electron boundary - but the connection is authoritative: a VST
 *            chain reaches the physical output only while its `audio-out` is
 *            connected to the Audio Output node (see engineSync.js)
 *   control  carries normalized semantic control values (for example K1..K8)
 *
 * Routing state is fully independent of UI focus: changing which module is
 * visible never affects the network.
 */
export class Network {
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
    if ((fromPort.type === 'midi' || fromPort.type === 'audio')
        && this._wouldCreateCycle(fromNodeId, toNodeId, fromPort.type)) {
      throw new Error(`${fromPort.type.toUpperCase()} connection would create a feedback cycle`);
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

  _wouldCreateCycle(fromNodeId, toNodeId, type) {
    if (fromNodeId === toNodeId) return true;
    const pending = [toNodeId];
    const seen = new Set();
    while (pending.length) {
      const id = pending.pop();
      if (id === fromNodeId) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      const current = this._nodes.get(id);
      // A physical MIDI output is an endpoint, not an internal thru path. The
      // MiniLab card deliberately represents two independent hardware sides:
      // its MIDI OUT originates at the device; data received on MIDI IN is
      // sent to the selected output and is never re-emitted from MIDI OUT.
      // Treating those ports as an implicit node-level edge creates a false
      // cycle for MiniLab -> Sequencer -> MiniLab hardware monitoring.
      if (type === 'midi' && current?.type === 'midi-output') continue;
      for (const c of this._connections) {
        if (c.from.nodeId !== id) continue;
        const source = this._nodes.get(c.from.nodeId);
        const port = source?.outputs.find((p) => p.id === c.from.portId);
        if (port?.type === type) pending.push(c.to.nodeId);
      }
    }
    return false;
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
   * A source node pushes data into the network on one of its output ports.
   * The network forwards it to every connected target's onInput handler.
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
          console.error(`[network] onInput failed for "${target.id}":`, err);
        }
      }
    }
  }

  /** Forward through one already-existing cable only. This keeps physical
   * topology authoritative while allowing track-aware sources such as the
   * Sequencer to choose which of their stable fan-out branches receives a
   * live event. */
  emitDataTo(nodeId, portId, targetNodeId, data) {
    const node = this._nodes.get(nodeId);
    const port = node?.outputs.find((candidate) => candidate.id === portId);
    if (!port) return false;
    const connection = this.connectionsFrom(nodeId, portId)
      .find((candidate) => candidate.to.nodeId === targetNodeId);
    if (!connection) return false;
    const target = this._nodes.get(connection.to.nodeId);
    if (!target?.onInput) return false;
    try {
      target.onInput(connection.to.portId, data);
      return true;
    } catch (err) {
      console.error(`[network] onInput failed for "${target.id}":`, err);
      return false;
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
    this.settings.set('networkConnections', this.serialize());
  }

  /** Restore persisted connections (after nodes have been registered). */
  restore(connections) {
    if (!Array.isArray(connections)) return;
    for (const c of connections) {
      try {
        this.connect(c.from.nodeId, c.from.portId, c.to.nodeId, c.to.portId);
      } catch (err) {
        // Skip invalid/stale connections (e.g. a node no longer present).
        console.warn('[network] skipped invalid connection:', err.message);
      }
    }
  }

  _emit(change) {
    this.events.emit('network:change', { ...change, connections: this.serialize() });
  }
}
