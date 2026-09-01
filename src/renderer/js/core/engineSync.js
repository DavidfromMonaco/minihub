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

export function buildRoutingSync(hub) {
  // Last value published to the engine per chain. Every graph change used to
  // re-send both flags for every VST node, so dragging one cable re-published
  // the whole topology. Sending only real transitions keeps the command stream
  // proportional to what actually changed.
  let published = '';
  let midiGraphPublished = '';
  const midiPublished = new Map();

  const sync = () => {
    if (!hub.engine) return;
    for (const node of hub.graph.listNodes()) if (node.type === 'vst') {
      const enabled=hub.graph.connectionsTo(node.id, 'midi-in').length > 0;
      if(midiPublished.get(node.id)!==enabled){midiPublished.set(node.id,enabled);hub.engine.setChainMidiEnabled(node.id,enabled);}
    }
    const nodes=describeAudioGraph(hub); const key=JSON.stringify(nodes);
    if(key!==published){published=key;hub.diagnostics?.log(`startup:audio-graph-sync nodes=${nodes.length}`);hub.engine.syncAudioGraph(nodes);}
    const midiNodes=describeMidiGraph(hub); const midiKey=JSON.stringify(midiNodes);
    if(midiKey!==midiGraphPublished){
      midiGraphPublished=midiKey;
      hub.engine.syncMidiGraph(midiNodes);
    }
  };

  /** Drop the cache so the next sync re-publishes everything (engine restart). */
  sync.reset = () => { published=''; midiGraphPublished=''; midiPublished.clear(); };
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
