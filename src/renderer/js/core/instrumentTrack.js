import { AUDIO_OUTPUT_NODE_ID } from './systemNodes.js';
import { SEQUENCER_LIMITS } from './sequencerModel.js';

/**
 * A MIDI track and the instrument it plays, in one gesture.
 *
 * Asked by the author on 2026-09-26. A playable synth cost him a node made in
 * the Patch Bay, a plugin loaded on its page, two cables, a track, its input
 * and its destination -- and a trip between the Patch Bay and the Sequencer
 * for most of them. This is the gesture every workstation has: an instrument
 * dropped in the arrangement is a track.
 *
 * Nothing here is hidden routing (invariant 2). It makes the same node and the
 * same cables a hand would, through the same doors -- `hub.nodes.create`,
 * `appendPlugin`, `network.connect`, `SequencerController.setTrack` -- and they
 * are on the Patch Bay afterwards, to be moved or pulled out like any other.
 *
 * WHERE THE SOUND GOES
 * --------------------
 * Where the last MIDI track's instrument sends its own: into the same Mixer,
 * or the same effect, or the output. The author's patch is synth -> Mixer ->
 * output; the next synth joins that Mixer rather than bypassing it. With no
 * previous instrument, a Mixer already feeding the output, else the output.
 */

/** The installed plugins a track can play, by name. */
export function instrumentPlugins(hub) {
  return [...(hub.engine?.plugins || [])]
    .filter((plugin) => plugin?.pluginId && plugin.name && plugin.role === 'instrument')
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/** The node and input port a new instrument's AUDIO OUT is cabled to. */
export function audioHomeFor(hub, previousInstrumentId = null) {
  const network = hub.network;
  const onward = previousInstrumentId
    ? network.connectionsFrom(previousInstrumentId, 'audio-out')[0]?.to.nodeId
    : null;
  const mixerToOutput = network.connectionsTo(AUDIO_OUTPUT_NODE_ID)
    .map((connection) => network.getNode(connection.from.nodeId))
    .find((node) => node?.type === 'mixer')?.id;
  const nodeId = onward || mixerToOutput || AUDIO_OUTPUT_NODE_ID;
  const node = network.getNode(nodeId);
  if (!node) return null;
  const taken = new Set(network.connectionsTo(nodeId).map((connection) => connection.to.portId));
  // A Mixer always keeps one AUDIO IN free (`_ensureDynamicAudioPorts`); the
  // output and an effect take any number of cables on their one input.
  const port = ['mixer', 'morpher'].includes(node.type)
    ? node.inputs.find((input) => input.type === 'audio' && !taken.has(input.id))
    : node.inputs.find((input) => input.type === 'audio');
  return port ? { nodeId, portId: port.id } : null;
}

/**
 * Make the track, its instrument and its cables. Returns
 * `{ track, nodeId, pluginInstanceId }`, or null when the plugin is not
 * installed or the Sequencer is full.
 */
export function createInstrumentTrack(hub, pluginId) {
  const plugin = hub.engine?.getPlugin?.(pluginId);
  const sequencer = hub.sequencer;
  if (!plugin || !sequencer) return null;
  // Checked first: a full Sequencer must not leave an orphan node behind.
  if (sequencer.model.state.tracks.length >= SEQUENCER_LIMITS.tracks) return null;
  const previous = [...sequencer.model.state.tracks].reverse()
    .find((track) => track.type === 'midi' && hub.nodes.get(track.outputId)?.type === 'vst');
  const node = hub.nodes.create('vst');
  if (!node) return null;
  const entry = hub.nodes.appendPlugin(node.id, pluginId);
  const home = audioHomeFor(hub, previous?.outputId || null);
  if (home) {
    try { hub.network.connect(node.id, 'audio-out', home.nodeId, home.portId); } catch (_) { /* the node stays, uncabled, as a hand would leave it */ }
  }
  const track = sequencer.addTrack('midi');
  if (!track) return { track: null, nodeId: node.id, pluginInstanceId: entry?.id || null };
  sequencer.setTrack(track.id, { name: plugin.name, outputId: node.id });
  return { track: sequencer.model.state.tracks.find((item) => item.id === track.id) || track, nodeId: node.id, pluginInstanceId: entry?.id || null };
}

/**
 * The plugin window of whatever a MIDI track plays, when that is a VST node:
 * its instrument, or the first plugin of its chain. Null otherwise.
 */
export function trackPlugin(hub, track) {
  if (track?.type !== 'midi' || hub.nodes?.get(track.outputId)?.type !== 'vst') return null;
  const plugins = hub.nodes.getChain(track.outputId)?.plugins || [];
  const plugin = plugins.find((item) => item.role === 'instrument') || plugins[0];
  return plugin ? { nodeId: track.outputId, pluginInstanceId: plugin.id } : null;
}

/**
 * Open a plugin's window now, or as soon as the engine has it ready: a new
 * instrument is still loading when its track appears, and "not ready" is not
 * an answer to a click. Returns a function that gives up waiting.
 */
export function openPluginWhenReady(hub, nodeId, pluginInstanceId) {
  if (hub.engine.getInstanceStatus(nodeId, pluginInstanceId) === 'ready') {
    hub.engine.openEditor(nodeId, pluginInstanceId);
    return () => {};
  }
  const off = hub.events.on('engine:instanceStatus', (message) => {
    if (message?.chainId !== nodeId || message.instanceId !== pluginInstanceId) return;
    if (message.status === 'ready') hub.engine.openEditor(nodeId, pluginInstanceId);
    if (message.status === 'ready' || message.status === 'error') off();
  });
  return off;
}
