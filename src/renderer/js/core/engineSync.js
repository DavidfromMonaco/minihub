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
export function buildRoutingSync(hub) {
  return () => {
    if (!hub.engine) return;
    for (const node of hub.graph.listNodes()) {
      if (node.type !== 'vst') continue;
      const midiEnabled = hub.graph.connectionsTo(node.id, 'midi-in').length > 0;
      const outputEnabled = hub.graph
        .connectionsFrom(node.id, 'audio-out')
        .some((c) => c.to.nodeId === 'audio-output' && c.to.portId === 'audio-in');
      hub.engine.setChainMidiEnabled(node.id, midiEnabled);
      hub.engine.setChainOutputEnabled(node.id, outputEnabled);
    }
  };
}

export function setupEngineSync(hub) {
  const sync = buildRoutingSync(hub);
  hub.events.on('graph:change', sync);
  sync();
  return sync;
}
