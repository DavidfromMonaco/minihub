/**
 * Canonical ids of the routing nodes the application itself owns.
 *
 * A user-created node draws its id from `NodeInstanceManager` (`vst-011`), and
 * a singleton node TYPE declares `stableId` in `nodeTypes.js`. The ids below
 * are a third case: exactly one of each exists, the id is part of the
 * persisted routing contract (`networkConnections`, `networkLayout`), and code
 * addresses it directly rather than looking it up.
 *
 * They used to be re-declared privately in nine modules, under three different
 * names (`NODE_ID`, `MINILAB_NODE_ID`, or an inline literal). Renaming one
 * meant finding every copy, and a missed copy fails silently: the network simply
 * never matches, so MIDI stops routing with no error anywhere.
 *
 * These are node IDS, not node TYPES. `'audio-output'` happens to be both the
 * id of the Audio Output node and the name of its node type; only the id
 * belongs here. Lists of node types (see `engineSync.js`) keep their literals.
 */
import { LOADED_PROFILES } from '../midi/loadedProfile.js';

/**
 * The physical controllers, one node id each, in the order they load. Have no
 * NODE_TYPES entry: they are hardware endpoints, not a creatable family.
 *
 * The VALUES come from the loaded profiles, the DECLARATION stays here. Those
 * are two different things and invariant 7 only asks for the second: one place
 * code imports "the ids of the controller nodes" from. Deriving them is what
 * stops the application from having an opinion about which controller it is
 * talking to -- a profile whose `profileId` is `vega-49` makes the node
 * `vega-49`, with nothing else edited.
 *
 * It is also load-bearing for saved projects, in a way a literal hid. An id is
 * written into every `.minihub` file's connections and layout, and the profile
 * id is written into every learned binding key (`minilab-3:k1`). If the two ever
 * disagreed, projects would open with cables that match nothing and bindings
 * that resolve to nothing, silently -- so they are one string, and
 * `test/minilabProfile.test.mjs` pins that string against a frozen recording of
 * what shipped.
 *
 * This was `MINILAB_NODE_ID`, a single string, until 2026-09-05. A node id IS a
 * `profileId` (D-025), so two keyboards are two ids and they cannot collide:
 * `minilab-3` and `vega-49` are different strings, and so are `minilab-3:k1` and
 * `vega-49:k1`, the keys their learned bindings are filed under. That is what
 * makes two controllers a matter of loading two profiles rather than of merging
 * them into one node -- and it is why the constant had to go rather than be
 * kept alongside: a consumer reading it would have been a consumer that works
 * for one keyboard and silently ignores the other.
 */
export const CONTROLLER_NODE_IDS = Object.freeze(LOADED_PROFILES.map((entry) => entry.profileId));

/**
 * Is this node ID one of the controllers?
 *
 * The question the code actually asks, in place of `id === MINILAB_NODE_ID`.
 * Equality against ONE id was never really a test of identity -- it was a test of
 * membership in a set that happened to hold one element, and it silently answers
 * "no" for the second keyboard the day there is one. A cable from it would be
 * read as a cable from nowhere: not an error, just CONTROL that stops arriving.
 *
 * `Id` is in the name on purpose. `core/controllerNode.js` has an
 * `isControllerNode(node)` that takes a NODE and answers from its shape -- what a
 * hardware MIDI endpoint looks like -- and the two would be indistinguishable at
 * a call site. This one knows which keyboards are loaded; that one knows what a
 * keyboard is.
 */
export function isControllerNodeId(nodeId) {
  return CONTROLLER_NODE_IDS.includes(nodeId);
}

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
