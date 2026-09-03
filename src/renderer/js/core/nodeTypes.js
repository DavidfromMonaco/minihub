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
 * the physical output. CONTROL ports carry normalized parameter-control data.
 * PRESET ports carry nothing: the cable itself is the statement "this Preset
 * node targets that VST node", and never reaches the native engine (graph.js).
 */

export const NODE_TYPES = {
  vst: {
    id: 'vst',
    label: 'VST',
    omniBoxCategory: 'Plugin',
    accent: '--accent-vst',
    icon: 'chip',
    emptyLabel: 'Empty VST Node',
    ports: {
      inputs: [
        { id: 'midi-in', type: 'midi', label: 'MIDI IN' },
        { id: 'audio-in', type: 'audio', label: 'AUDIO IN' },
        { id: 'ctrl-in', type: 'control', label: 'CTRL IN' },
        { id: 'preset-in', type: 'preset', label: 'PRESET' }
      ],
      outputs: [{ id: 'audio-out', type: 'audio', label: 'AUDIO OUT' }]
    }
  },
  mixer: {
    id: 'mixer', label: 'Mixer', omniBoxCategory: 'Audio', accent: '--accent-mixer', icon: 'sliders',
    emptyLabel: 'Connect AUDIO sources in Patch Bay', dynamicAudioInputs: true,
    ports: { inputs: [], outputs: [{ id: 'audio-out', type: 'audio', label: 'AUDIO OUT' }] }
  },
  morpher: {
    id: 'morpher', label: 'Morpher', omniBoxCategory: 'Audio', accent: '--accent-morpher', icon: 'sequencer',
    emptyLabel: 'Connect AUDIO sources in Patch Bay', dynamicAudioInputs: true,
    ports: { inputs: [], outputs: [{ id: 'audio-out', type: 'audio', label: 'AUDIO OUT' }] }
  },
  'audio-input': {
    id: 'audio-input',
    label: 'Audio Input',
    omniBoxCategory: 'Audio',
    accent: '--accent-mixer',
    icon: 'speaker',
    emptyLabel: 'Physical audio input routed by the native engine',
    singleton: true,
    stableId: 'audio-input',
    deletable: true,
    copyable: false,
    ports: {
      inputs: [],
      outputs: [{ id: 'audio-out', type: 'audio', label: 'AUDIO OUT' }]
    }
  },
  arpeggiator: {
    id: 'arpeggiator', label: 'Arpeggiator', omniBoxCategory: 'MIDI', accent: '--accent-sequencer', icon: 'sequencer',
    emptyLabel: 'Hold notes and start transport',
    ports: {
      inputs: [{ id: 'midi-in', type: 'midi', label: 'MIDI IN' }],
      outputs: [{ id: 'midi-out', type: 'midi', label: 'MIDI OUT' }]
    }
  },
  sequencer: {
    id: 'sequencer',
    label: 'Sequencer',
    omniBoxCategory: 'MIDI',
    accent: '--accent-sequencer',
    icon: 'sequencer',
    emptyLabel: 'Open the Sequencer page to arrange tracks and clips',
    // Product-safe lifecycle contract. The controller and the fixed Sequencer
    // page both address this canonical id, so the project owns at most one
    // routing instance and the generic delete/copy flows must not touch it.
    singleton: true,
    stableId: 'sequencer',
    fixedModuleId: 'sequencer',
    deletable: true,
    copyable: false,
    ports: {
      inputs: [
        { id: 'midi-in', type: 'midi', label: 'MIDI IN' },
        { id: 'audio-in', type: 'audio', label: 'AUDIO IN' }
      ],
      outputs: [
        { id: 'midi-out', type: 'midi', label: 'MIDI OUT' },
        { id: 'audio-out', type: 'audio', label: 'AUDIO OUT' }
      ]
    }
  },
  preset: {
    id: 'preset',
    label: 'Preset',
    omniBoxCategory: 'Plugin',
    accent: '--accent-preset',
    icon: 'preset',
    emptyLabel: 'Cable PRESET into a VST node to choose its presets',
    // No input: a preset relation only ever runs from this node to a VST node,
    // which is also why the graph never has to check it for cycles.
    ports: {
      inputs: [],
      outputs: [{ id: 'preset-out', type: 'preset', label: 'PRESET' }]
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
  return type.singleton ? type.label : `${type.label} ${ordinal}`;
}

export function listNodeTypes() {
  return Object.values(NODE_TYPES);
}

/** Populated OmniBox families in deliberate UI order. Media placeholders are
 * not OmniBoxes and therefore do not appear here. */
export function listOmniBoxCategories() {
  const order = ['MIDI', 'Audio', 'Plugin'];
  return order.map((label) => ({
    label,
    types: listNodeTypes().filter((type) => type.omniBoxCategory === label)
  })).filter((category) => category.types.length > 0);
}
