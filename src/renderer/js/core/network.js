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
    // Cables the file names and the session cannot make, because something they
    // point at is not here. They are remembered, never routed. See restore().
    this._unresolved = [];
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
      // A device that draws its ports on a faceplate instead of stacking them in
      // a dock declares it here, as data: { width, height, ports: {id: {x,y}} }.
      // The Patch Bay reads this rather than testing which node it is looking at.
      surface: node.surface || null,
      onInput: typeof node.onInput === 'function' ? node.onInput : null
    });
    this._emit({ type: 'add', nodeId: node.id });
    // The node that just arrived may be the one a remembered cable was waiting
    // for -- a controller whose profile was loaded back, a node type registered
    // later in the boot order.
    this._resolveWaiting();
  }

  removeNode(id) {
    const node = this._nodes.get(id);
    if (!node) return false;
    this._nodes.delete(id);
    this._connections = this._connections.filter(
      (c) => c.from.nodeId !== id && c.to.nodeId !== id
    );
    // A node the user deleted is gone for good -- ids are never reused
    // (ARCHITECTURE section 13, invariant 4) -- so a cable still waiting for it
    // is waiting for something that cannot come back.
    this._unresolved = this._unresolved.filter(
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

  /**
   * What gets WRITTEN: the live cables, plus the ones still waiting for what
   * they name. `connections()` is the live list and is what routing reads --
   * the difference is the whole point, and mixing them up would either hand a
   * phantom cable to the engine or drop a real one from the file.
   */
  serialize() {
    return [...this._connections, ...this._unresolved].map((c) => ({
      from: { ...c.from },
      to: { ...c.to }
    }));
  }

  /** Cables the file holds that this session cannot make. Copy. */
  unresolvedConnections() {
    return this._unresolved.map((c) => ({ from: { ...c.from }, to: { ...c.to } }));
  }

  _persist() {
    this.settings.set('networkConnections', this.serialize());
  }

  /** The shape of a persisted cable, or null. Shape only -- see _absentEndpoint
   *  for the other half. */
  static _endpointPair(value) {
    const part = (side) => (typeof side?.nodeId === 'string' && side.nodeId
      && typeof side?.portId === 'string' && side.portId
      ? { nodeId: side.nodeId, portId: side.portId }
      : null);
    const from = part(value?.from);
    const to = part(value?.to);
    return from && to ? { from, to } : null;
  }

  /**
   * What this cable names that is not here, or null when everything is.
   *
   * The distinction this draws is the one that decides whether a cable is kept
   * or thrown away. ABSENT means the node or the port cannot be found: the cable
   * may be perfectly correct and simply describe a device that is not loaded
   * right now. WRONG means every endpoint exists and the cable still cannot be
   * made -- incompatible types, a duplicate, a feedback cycle. Only the first
   * kind is worth remembering; keeping the second would preserve garbage for
   * ever.
   */
  _absentEndpoint(from, to) {
    const fromNode = this._nodes.get(from.nodeId);
    if (!fromNode) return `node ${from.nodeId}`;
    const toNode = this._nodes.get(to.nodeId);
    if (!toNode) return `node ${to.nodeId}`;
    if (!fromNode.outputs.some((port) => port.id === from.portId)) {
      return `output port ${from.nodeId}.${from.portId}`;
    }
    if (!toNode.inputs.some((port) => port.id === to.portId)) {
      return `input port ${to.nodeId}.${to.portId}`;
    }
    return null;
  }

  _isWaiting(pair) {
    return this._unresolved.some((c) => c.from.nodeId === pair.from.nodeId
      && c.from.portId === pair.from.portId
      && c.to.nodeId === pair.to.nodeId
      && c.to.portId === pair.to.portId);
  }

  /**
   * Restore persisted connections (after nodes have been registered).
   *
   * WHY A CABLE IS KEPT RATHER THAN SKIPPED
   * ---------------------------------------
   * This used to warn and move on, and `_persist()` then wrote the file without
   * the cable: one launch to lose it, one save to make it permanent. That is the
   * same silent destruction `normalizeControlBinding` was fixed for -- the
   * specification calls it section 6.1 -- and the controller is where it bites,
   * because the controller node's id IS the loaded profile's id. Load another
   * profile and every cable from the keyboard points at a node that does not
   * exist. The user's project must survive being opened with the wrong keyboard
   * plugged in, and switching back must bring the cables back.
   *
   * So: absent means remembered, wrong means dropped, and nothing that is
   * remembered ever routes.
   */
  restore(connections) {
    if (!Array.isArray(connections)) return;
    this._unresolved = [];
    for (const value of connections) {
      const pair = Network._endpointPair(value);
      if (!pair) {
        console.warn('[network] dropped a malformed connection:', value);
        continue;
      }
      const absent = this._absentEndpoint(pair.from, pair.to);
      if (absent) {
        if (!this._isWaiting(pair)) this._unresolved.push(pair);
        continue;
      }
      try {
        this.connect(pair.from.nodeId, pair.from.portId, pair.to.nodeId, pair.to.portId);
      } catch (err) {
        // Everything it names is here and it still cannot be made: the cable is
        // wrong, not waiting.
        console.warn('[network] dropped an invalid connection:', err.message);
      }
    }
  }

  /**
   * Connect what is no longer waiting. Called when a node arrives.
   *
   * The list is narrowed BEFORE any `connect()`, because `connect()` persists,
   * and persisting while a cable sits in both lists would write it twice.
   */
  _resolveWaiting() {
    if (!this._unresolved.length) return;
    const ready = [];
    const waiting = [];
    for (const pair of this._unresolved) {
      (this._absentEndpoint(pair.from, pair.to) ? waiting : ready).push(pair);
    }
    if (!ready.length) return;
    this._unresolved = waiting;
    for (const pair of ready) {
      try {
        this.connect(pair.from.nodeId, pair.from.portId, pair.to.nodeId, pair.to.portId);
      } catch (err) {
        console.warn('[network] dropped an invalid connection:', err.message);
      }
    }
  }

  /** The event carries the LIVE cables. A waiting one is not routing, and every
   *  listener of `network:change` -- engineSync, controlBindings, the sequencer,
   *  the Patch Bay -- reads this as what is actually connected. */
  _emit(change) {
    this.events.emit('network:change', { ...change, connections: this.connections() });
  }
}
