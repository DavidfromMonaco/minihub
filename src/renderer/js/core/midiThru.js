/**
 * Where MIDI entering a VST node goes next: everything its MIDI OUT cables
 * reach.
 *
 * A VST node's MIDI OUT repeats what enters its MIDI IN, so a track -- or a
 * keyboard, or an arpeggiator -- wired into one instrument plays every
 * instrument cabled after it (DECISIONS.md D-039).
 *
 * WHY ONE FUNCTION, AND WHY IT IS NOT `emitData`
 * ---------------------------------------------
 * Three things ask this question and deliver the answer three different ways:
 * the VST node's `onInput` for live playing, the sequencer's native plan for
 * playback and export, and the arpeggiator's native destinations. A series they
 * disagree about is an instrument you hear while monitoring and lose in the
 * bounce. A view of what a track drives, when there is one, reads it too.
 *
 * The obvious implementation -- a VST re-emitting what it receives through
 * `network.emitData` -- was the wrong one. The Sequencer's MIDI IN assumes only
 * a controller ever emits into it (`isCanonicalMidiIngress`), so a VST cabled
 * there would have recorded every take twice; and two cables converging on one
 * instrument would have played its notes twice, once per path. Walking the
 * cables here answers each node once and never offers the Sequencer anything.
 */

/** The node types a series delivers to. A VST passes MIDI on; an arpeggiator
 *  and a One Ring make notes of their own and a hardware output is the
 *  hardware, so the walk stops at them. Anything else -- the Sequencer -- is
 *  never a recipient. */
const RECIPIENT_TYPES = new Set(['vst', 'arpeggiator', 'one-ring', 'midi-output']);

/**
 * Everything MIDI entering `nodeId` reaches through MIDI OUT cables, beyond the
 * node itself.
 *
 * @returns {{ id: string, kind: string, via: string }[]} breadth-first, each
 *   node once. `kind` is the node type. `via` is the node whose MIDI OUT cable
 *   reaches it first: the cable a live delivery travels, and the parent when
 *   the series is drawn. Empty unless `nodeId` is a VST node.
 */
export function midiThruReach(network, nodeId) {
  if (network?.getNode?.(nodeId)?.type !== 'vst') return [];
  const reached = [];
  const seen = new Set([nodeId]);
  const pending = [nodeId];
  while (pending.length) {
    const from = pending.shift();
    const midiOutputs = new Set((network.getNode(from)?.outputs || [])
      .filter((port) => port.type === 'midi').map((port) => port.id));
    for (const connection of network.connectionsFrom(from)) {
      if (!midiOutputs.has(connection.from.portId)) continue;
      const target = network.getNode(connection.to.nodeId);
      if (!target || seen.has(target.id) || !RECIPIENT_TYPES.has(target.type)) continue;
      // `seen` is also what keeps this finite on a network that somehow holds a
      // cycle: `connect()` refuses one, but a walk that trusts that is a walk
      // that hangs the renderer on every note the day it does not.
      seen.add(target.id);
      reached.push({ id: target.id, kind: target.type, via: from });
      if (target.type === 'vst') pending.push(target.id);
    }
  }
  return reached;
}
