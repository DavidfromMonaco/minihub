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
  // Last value published to the engine per chain. Every graph change used to
  // re-send both flags for every VST node, so dragging one cable re-published
  // the whole topology. Sending only real transitions keeps the command stream
  // proportional to what actually changed.
  const published = new Map(); // chainId -> `${midiEnabled}|${outputEnabled}`

  const sync = () => {
    if (!hub.engine) return;
    const live = new Set();
    for (const node of hub.graph.listNodes()) {
      if (node.type !== 'vst') continue;
      live.add(node.id);
      const midiEnabled = hub.graph.connectionsTo(node.id, 'midi-in').length > 0;
      const outputEnabled = hub.graph
        .connectionsFrom(node.id, 'audio-out')
        .some((c) => c.to.nodeId === 'audio-output' && c.to.portId === 'audio-in');

      const key = `${midiEnabled}|${outputEnabled}`;
      if (published.get(node.id) === key) continue;
      published.set(node.id, key);
      hub.engine.setChainMidiEnabled(node.id, midiEnabled);
      hub.engine.setChainOutputEnabled(node.id, outputEnabled);
    }
    // Forget deleted nodes; `nodes.delete` already disabled them in the engine.
    for (const chainId of [...published.keys()]) {
      if (!live.has(chainId)) published.delete(chainId);
    }
  };

  /** Drop the cache so the next sync re-publishes everything (engine restart). */
  sync.reset = () => published.clear();
  return sync;
}

export function setupEngineSync(hub) {
  const sync = buildRoutingSync(hub);
  hub.events.on('graph:change', sync);
  // A restarted engine remembers nothing, so the cache must not claim the
  // topology is already published.
  hub.events.on('engine:state', (s) => {
    if (s && s.state !== 'running') sync.reset();
  });
  sync();
  return sync;
}
