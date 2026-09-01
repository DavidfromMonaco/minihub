/**
 * Canonical ids of the routing nodes the application itself owns.
 *
 * A user-created node draws its id from `NodeInstanceManager` (`vst-011`), and
 * a singleton node TYPE declares `stableId` in `nodeTypes.js`. The ids below
 * are a third case: exactly one of each exists, the id is part of the
 * persisted routing contract (`graphConnections`, `graphLayout`), and code
 * addresses it directly rather than looking it up.
 *
 * They used to be re-declared privately in nine modules, under three different
 * names (`NODE_ID`, `MINILAB_NODE_ID`, or an inline literal). Renaming one
 * meant finding every copy, and a missed copy fails silently: the graph simply
 * never matches, so MIDI stops routing with no error anywhere.
 *
 * These are node IDS, not node TYPES. `'audio-output'` happens to be both the
 * id of the Audio Output node and the name of its node type; only the id
 * belongs here. Lists of node types (see `engineSync.js`) keep their literals.
 */

/** Physical MiniLab 3 controller. Has no NODE_TYPES entry: it is a hardware
 *  endpoint, not a creatable family. */
export const MINILAB_NODE_ID = 'minilab-3';

/** Physical audio output owned by the native engine. Same reasoning. Its
 *  module id is deliberately identical, which is what lets the Patch Bay find
 *  a node's editor with `hub.modules.get(node.id)`. */
export const AUDIO_OUTPUT_NODE_ID = 'audio-output';

/** Singleton node types, addressed by the `stableId` they declare in
 *  `nodeTypes.js`. Repeated here so callers have one import for "the id of the
 *  Sequencer node" instead of reaching into the type registry. Keep in sync
 *  with `NODE_TYPES[...].stableId`. */
export const SEQUENCER_NODE_ID = 'sequencer';
export const AUDIO_INPUT_NODE_ID = 'audio-input';
