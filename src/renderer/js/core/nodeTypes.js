/**
 * Node Type Registry.
 *
 * A node type defines the identity/capabilities of a node (label, accent,
 * icon, and the ports it exposes). Node types are immutable — an instance
 * keeps its type forever; only its content can change later.
 *
 * `accent` is the name of a CSS variable defined in `styles/base.css`, so the
 * same accent is used consistently in the Patch Bay, the sidebar, and the node
 * editor shell. Ports are declared here so a type's routing contract lives in
 * one place and can be extended later.
 *
 * Audio ports carry no samples in the renderer (the native engine owns audio),
 * but an audio connection is authoritative: it is what routes a VST chain to
 * the physical output. Control ports are declared and not yet used.
 */

export const NODE_TYPES = {
  vst: {
    id: 'vst',
    label: 'VST',
    accent: '--accent-vst',
    icon: 'chip',
    emptyLabel: 'Empty VST Node',
    ports: {
      inputs: [
        { id: 'midi-in', type: 'midi', label: 'MIDI IN' },
        { id: 'audio-in', type: 'audio', label: 'AUDIO IN' }
      ],
      outputs: [{ id: 'audio-out', type: 'audio', label: 'AUDIO OUT' }]
    }
  },
  video: {
    id: 'video',
    label: 'Video',
    accent: '--accent-video',
    icon: 'video',
    emptyLabel: 'No video assigned',
    ports: { inputs: [], outputs: [] }
  },
  image: {
    id: 'image',
    label: 'Image',
    accent: '--accent-image',
    icon: 'image',
    emptyLabel: 'No image assigned',
    ports: { inputs: [], outputs: [] }
  },
  sequencer: {
    id: 'sequencer',
    label: 'Sequencer',
    accent: '--accent-sequencer',
    icon: 'sequencer',
    emptyLabel: 'Empty Sequencer',
    ports: { inputs: [], outputs: [] }
  }
};

export function getNodeType(id) {
  return NODE_TYPES[id] || null;
}

/**
 * User-facing name for a node: the type label plus its display ordinal.
 *
 * The ordinal is NOT identity — see `nodeInstances.js`. It is the lowest
 * positive number free within the node's own type family at creation time, so
 * deleting nodes frees their numbers for reuse while stable internal IDs
 * (`vst-011`) are never reused.
 */
export function nodeDisplayName(type, ordinal) {
  return `${type.label} ${ordinal}`;
}

export function listNodeTypes() {
  return Object.values(NODE_TYPES);
}
