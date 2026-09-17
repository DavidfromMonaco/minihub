import { getNodeType } from './nodeTypes.js';

/**
 * What an outside agent reads before it acts: the setup, as data.
 *
 * WHY THIS IS THE TOPOLOGY AND NOT THE PARAMETER SPACE
 * ----------------------------------------------------
 * One Dexed instance reports 2,238 parameters and one Massive X 2,105. A
 * project with three instruments in it would describe itself in more text than
 * any reader can hold, and none of that text is needed to decide where a cable
 * goes. So parameters are absent here on purpose: they are read one plugin at a
 * time, through `vstParameterDiscovery.js`, by a caller that has already
 * decided which plugin it wants to change. The same reasoning keeps a clip's
 * NOTES out — a count is enough to choose a clip, and the notes themselves come
 * from the request the Clip Editor already uses to open one.
 *
 * WHY PORTS COME FROM THE NETWORK AND NOT FROM THE TYPE REGISTRY
 * --------------------------------------------------------------
 * `nodeTypes.js` declares the ports a node is BORN with. A Mixer and a Morpher
 * grow another input as soon as the last free one is taken
 * (`nodeInstances._ensureDynamicAudioPorts`), so the registry's list goes stale
 * the moment a second cable lands. An agent connecting to an `audio-in-3` it
 * read from that stale list builds a cable the network refuses — and the
 * refusal then reads as a defect in the agent rather than in what it was told.
 * Invariant 2 settles it: the network is the authority, here as everywhere.
 */

const strip = (ports) => (Array.isArray(ports) ? ports : [])
  .map((port) => ({ id: port.id, type: port.type, label: port.label }));

/**
 * A node's content, minus the one field that is unreadable by construction.
 *
 * A plugin's `state` is a base64 chunk of that plugin's own memory. It is the
 * largest thing in a project and it says nothing to anyone but the plugin that
 * wrote it, so carrying it here would cost the whole budget of the description
 * and buy nothing.
 */
function contentOf(instance, hub) {
  const content = instance?.content;
  if (!content || typeof content !== 'object') return null;
  const copy = JSON.parse(JSON.stringify(content));
  if (Array.isArray(copy.plugins)) {
    for (const plugin of copy.plugins) {
      delete plugin.state;
      // What that state holds is still reachable when the plugin says so: the
      // `plugin` request hands it one in its own vocabulary.
      if (hub?.engine?.acceptsRequests?.(instance.id, plugin.id)) plugin.requests = true;
    }
  }
  return copy;
}

/**
 * What a One Ring node's runtime last reported, in the words of its `status`
 * request -- which is what `set-node-content` never answered: whether the
 * sequence it wrote is playing, where, and what was refused.
 */
function oneRingStatusOf(hub, nodeId) {
  const status = hub.oneRing?.statusOf?.(nodeId) ?? null;
  return {
    ready: Number.isSafeInteger(hub.oneRing?.generationOf?.(nodeId)),
    running: status?.playing === true,
    beat: status?.beat ?? 0,
    bpm: status?.bpm ?? 0,
    scene: status?.scene ?? null,
    pendingScene: status && status.pendingScene >= 0 ? status.pendingScene : null,
    activeChannels: (status?.active ?? []).flatMap((active, i) => (active ? [i + 1] : [])),
    refused: status?.rejected ?? 0,
    guarded: status?.guarded ?? 0,
    lastRefusal: hub.oneRing?.refusalOf?.(nodeId) ?? '',
    capture: status?.capture ?? 'off',
    sounding: status?.sounding ?? [0, 0, 0, 0],
    feedback: status?.feedback === true,
    written: hub.oneRing?.writesOf?.(nodeId)?.written ?? 0,
    writesRefused: hub.oneRing?.writesOf?.(nodeId)?.refused ?? 0
  };
}

/**
 * Every node in the network, with the ports it actually has.
 *
 * WHY THE NETWORK AND NOT `nodes.list()`
 * --------------------------------------
 * `NodeInstanceManager` holds what the USER created. The Audio Output, the
 * Sequencer and the controller are not in it -- they are routing nodes their
 * own modules register -- so a description built from the instances is a
 * description with no speakers in it. An agent reading it can build a perfect
 * chain and has nowhere to plug it, which it discovers as a cable refused
 * against a node id it never saw. Invariant 2 again: the network is the
 * authority, so the network is the list.
 *
 * `system: true` marks the ones with no instance behind them. They are not the
 * agent's to delete, and saying so is cheaper than a rule nobody can check.
 */
export function describeNodes(hub) {
  const nodes = typeof hub.network?.listNodes === 'function' ? hub.network.listNodes() : [];
  return nodes.map((node) => {
    const instance = hub.nodes?.get?.(node.id) || null;
    const typeId = instance?.type || node.type || '';
    const type = getNodeType(typeId);
    return {
      id: node.id,
      type: typeId,
      ordinal: instance?.ordinal ?? null,
      name: instance?.name || node.name || node.id,
      label: type?.label || node.name || node.id,
      system: !instance,
      ports: { inputs: strip(node.inputs), outputs: strip(node.outputs) },
      content: contentOf(instance, hub),
      ...(typeId === 'one-ring' ? { status: oneRingStatusOf(hub, node.id) } : {})
    };
  });
}

/**
 * Every cable, by its endpoints.
 *
 * The `type` is looked up rather than stored, because a connection does not
 * carry one: `network.connect()` proves both ends agree and then keeps only the
 * endpoints. Reporting a type the connection does not hold would be inventing a
 * second source for something the ports already answer.
 */
export function describeCables(hub) {
  const connections = typeof hub.network?.connections === 'function'
    ? hub.network.connections() : [];
  return connections.map((connection) => {
    const source = hub.network?.getNode?.(connection.from.nodeId);
    const port = (source?.outputs || []).find((entry) => entry.id === connection.from.portId);
    return {
      from: { nodeId: connection.from.nodeId, portId: connection.from.portId },
      to: { nodeId: connection.to.nodeId, portId: connection.to.portId },
      type: port?.type || null
    };
  });
}

/**
 * The arrangement, without the notes.
 *
 * The live model is asked first and the persisted key is the fallback: while
 * the application runs, `SequencerController` is the authority and the settings
 * key trails it by one write.
 */
export function describeSequencer(hub) {
  const state = hub.sequencer?.model?.snapshot?.() || hub.settings?.get?.('sequencerState') || null;
  if (!state || typeof state !== 'object') return null;
  const tracks = Array.isArray(state.tracks) ? state.tracks : [];
  return {
    bpm: hub.settings?.get?.('transportBpm') ?? null,
    tracks: tracks.map((track) => ({
      id: track.id,
      name: track.name,
      type: track.type,
      outputId: track.outputId || '',
      muted: track.muted === true,
      armed: track.armed === true,
      volume: track.volume,
      clips: (Array.isArray(track.clips) ? track.clips : []).map((clip) => ({
        id: clip.id,
        startPpq: clip.startPpq,
        lengthPpq: clip.lengthPpq,
        noteCount: Array.isArray(clip.notes) ? clip.notes.length : 0
      }))
    }))
  };
}

/**
 * The plugins installed on this machine, as the scanner found them.
 *
 * `category` and `isInstrument` come from the VST3 metadata itself, so a reader
 * learns what a plugin IS without anyone curating a list. What it does not
 * learn is what a plugin SOUNDS like: that a given name is a wavetable synth is
 * knowledge the reader brings, and a reader that does not have it should say so
 * rather than choose at random.
 */
export function describeCatalogue(hub) {
  const catalogue = hub.settings?.get?.('vstCatalog');
  return (Array.isArray(catalogue) ? catalogue : []).map((entry) => ({
    pluginId: entry.pluginId || entry.path || '',
    name: entry.name || '',
    manufacturer: entry.manufacturer || '',
    category: entry.category || '',
    role: entry.role || '',
    isInstrument: entry.isInstrument === true
  }));
}

/**
 * Whether the machine is in a state to make any sound at all.
 *
 * Worth reading before anything else, and easy to forget: a perfectly wired
 * setup with no audio device running is silent, and every other signal still
 * says success. An audition answers `sounded: true` on a MIDI note that left
 * correctly for a chain whose output reaches nothing.
 */
export function describeAudio(hub) {
  const state = hub.engine?.deviceState || null;
  return {
    running: state?.running === true,
    device: state?.device || null,
    sampleRate: state?.sampleRate ?? null,
    bufferSize: state?.bufferSize ?? null,
    error: state?.error || null
  };
}

/**
 * What is on screen, so an agent can show the person what it is working on.
 *
 * `main` comes from the main process, which alone knows whether MiniHub's own
 * window is visible at all: a launch with a hidden window style leaves every
 * request answering while the person sees nothing. `launchedInsidePackage` is
 * the other thing nothing on screen says -- see `recordLaunchContext` in
 * main.js. The plugin editors are the renderer's record of what the engine
 * reported open; the pages are the ids `show-window` accepts.
 */
export function describeWindows(hub, mainState = null) {
  const pages = (typeof hub.modules?.list === 'function' ? hub.modules.list() : [])
    .filter((module) => module.navEntry)
    .map((module) => ({ id: module.id, label: module.navEntry.label || module.name || module.id }));
  const pluginEditors = [];
  for (const instance of typeof hub.nodes?.list === 'function' ? hub.nodes.list() : []) {
    const plugins = Array.isArray(instance?.content?.plugins) ? instance.content.plugins : [];
    for (const status of hub.engine?.getOpenEditors?.(instance.id) || []) {
      const plugin = plugins.find((entry) => entry.id === status.instanceId);
      pluginEditors.push({ nodeId: instance.id, pluginInstanceId: status.instanceId, name: plugin?.name || '' });
    }
  }
  return {
    main: mainState?.main || null,
    page: hub.modules?.activeId || null,
    pages,
    pluginEditors,
    clipEditors: Array.isArray(mainState?.clipEditors) ? mainState.clipEditors : [],
    launchedInsidePackage: mainState?.launchedInsidePackage || null
  };
}

/** The whole description, in one object. */
export function describeSetup(hub) {
  return {
    audio: describeAudio(hub),
    nodes: describeNodes(hub),
    cables: describeCables(hub),
    sequencer: describeSequencer(hub),
    catalogue: describeCatalogue(hub)
  };
}
