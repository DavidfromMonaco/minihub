/**
 * Keeps the native engine's chain enablement in sync with the Hub routing
 * graph. The graph remains authoritative:
 *
 *   - a VST chain is MIDI-enabled only when a MIDI source is connected into its
 *     `midi-in` port (MiniLab MIDI OUT -> VST MIDI IN)
 *   - a VST chain reaches the physical output only when its `audio-out` is
 *     connected to the Audio Output node's `audio-in`
 *
 * Disconnecting either cable immediately stops that chain from receiving MIDI
 * or reaching the physical output, so the Patch Bay stays meaningful.
 */
export function describeAudioGraph(hub) {
  const supported = new Set(['audio-input', 'vst', 'mixer', 'morpher', 'sequencer', 'audio-output']);
  return hub.graph.listNodes().filter((node) => supported.has(node.type)).map((node) => {
    const content = hub.nodes?.get(node.id)?.content || {};
    const incoming = hub.graph.connectionsTo(node.id);
    const inputs = node.inputs.filter((p)=>p.type==='audio').flatMap((port)=>incoming.filter((c)=>c.to.portId===port.id)).map((c) => {
      const state = content.inputs?.find((p) => p.id === c.to.portId);
      return { portId:c.to.portId, sourceNodeId:c.from.nodeId, sourcePortId:c.from.portId, level:Number.isFinite(state?.level)?state.level:1, muted:state?.muted===true };
    });
    return { id:node.id, nodeType:node.type, inputs,
      ...(node.type==='mixer'?{masterLevel:content.masterLevel??1}:{}),
      ...(node.type==='morpher'?{stepCount:content.stepCount??4,steps:content.steps||[]}:{}) };
  });
}

export function describeMidiGraph(hub) {
  const supported = new Set(['arpeggiator', 'vst', 'midi-output']);
  return hub.graph.listNodes().filter((node) => supported.has(node.type)).map((node) => {
    const incoming = hub.graph.connectionsTo(node.id, 'midi-in')
      .filter((c) => hub.graph.getNode(c.from.nodeId)?.outputs.find((p) => p.id === c.from.portId)?.type === 'midi')
      .map((c) => ({ sourceNodeId: c.from.nodeId, sourcePortId: c.from.portId }));
    const content = hub.nodes?.get(node.id)?.content || {};
    const destinations=node.type==='arpeggiator'?hub.graph.connectionsFrom(node.id,'midi-out').filter((c)=>['vst','midi-output'].includes(hub.graph.getNode(c.to.nodeId)?.type)).map((c)=>c.to.nodeId):[];
    return { id: node.id, nodeType: node.type, inputs: incoming, destinations, ...(node.type === 'arpeggiator' ? content : {}) };
  });
}

/** Everything that defines the SHAPE of the audio graph.
 *
 *  A difference here has to recompile the native plan, because it changes buffer
 *  wiring and per-source PDC delays. `stepCount` belongs here: it resizes the
 *  Morpher pattern, unlike the step values themselves.
 */
export function audioTopologyKey(nodes) {
  return JSON.stringify(nodes.map((node) => ({
    id: node.id,
    nodeType: node.nodeType,
    inputs: node.inputs.map((input) => ({
      portId: input.portId,
      sourceNodeId: input.sourceNodeId,
      sourcePortId: input.sourcePortId
    })),
    ...(node.stepCount !== undefined ? { stepCount: node.stepCount } : {})
  })));
}

/** The continuously edited values.
 *
 *  These are applied in place on the already published plan. A `range` slider
 *  emits one `input` per pixel of a drag; routing those through syncAudioGraph
 *  recompiled the graph tens of times per second and rebuilt every SourceDelay,
 *  zeroing the PDC delay lines mid-stream on each one.
 */
export function audioNodeValues(nodes) {
  return nodes.map((node) => ({
    id: node.id,
    inputs: node.inputs.map((input) => ({
      portId: input.portId, level: input.level, muted: input.muted
    })),
    ...(node.masterLevel !== undefined ? { masterLevel: node.masterLevel } : {}),
    ...(node.steps !== undefined ? { steps: node.steps } : {})
  }));
}

export function buildRoutingSync(hub) {
  // Last topology and last values published to the engine, tracked separately
  // so a value edit never escalates into a graph recompile.
  let publishedTopology = '';
  let publishedValues = '';
  let midiGraphPublished = '';
  const midiPublished = new Map();

  const sync = () => {
    if (!hub.engine) return;
    for (const node of hub.graph.listNodes()) if (node.type === 'vst') {
      const enabled=hub.graph.connectionsTo(node.id, 'midi-in').length > 0;
      if(midiPublished.get(node.id)!==enabled){midiPublished.set(node.id,enabled);hub.engine.setChainMidiEnabled(node.id,enabled);}
    }

    const nodes = describeAudioGraph(hub);
    const topology = audioTopologyKey(nodes);
    const values = JSON.stringify(audioNodeValues(nodes));
    if (topology !== publishedTopology) {
      // syncAudioGraph carries the values too, so they are never left behind.
      publishedTopology = topology;
      publishedValues = values;
      hub.diagnostics?.log(`startup:audio-graph-sync nodes=${nodes.length}`);
      hub.engine.syncAudioGraph(nodes);
    } else if (values !== publishedValues) {
      publishedValues = values;
      hub.engine.setAudioNodeValues(audioNodeValues(nodes));
    }

    const midiNodes=describeMidiGraph(hub); const midiKey=JSON.stringify(midiNodes);
    if(midiKey!==midiGraphPublished){
      midiGraphPublished=midiKey;
      hub.engine.syncMidiGraph(midiNodes);
    }
  };

  /** Drop the cache so the next sync re-publishes everything (engine restart). */
  sync.reset = () => { publishedTopology=''; publishedValues=''; midiGraphPublished=''; midiPublished.clear(); };
  return sync;
}

export function setupEngineSync(hub) {
  const sync = buildRoutingSync(hub);
  hub.events.on('graph:change', sync);
  hub.events.on('nativeAudio:stateChanged', sync);
  hub.events.on('nativeMidi:stateChanged', sync);
  hub.events.on('sequencer:changed', sync);
  hub.events.on('graph:change', () => hub.sequencer?.syncNative());
  hub.events.on('engine:deviceState', () => { sync.reset(); sync(); });
  // The engine refuses a values-only update whose topology it does not
  // recognise, rather than applying it in part. Forget what we believe is
  // published so the next sync sends the whole graph again.
  hub.events.on('engine:error', (msg) => {
    if (msg && msg.code === 'audio-values-stale') { sync.reset(); sync(); }
  });
  // A restarted engine remembers nothing, so the cache must not claim the
  // topology is already published.
  hub.events.on('engine:state', (s) => {
    if (!s) return;
    if (s.state !== 'running') sync.reset();
    else { sync.reset(); sync(); }
  });
  sync();
  return sync;
}
