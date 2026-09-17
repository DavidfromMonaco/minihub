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
 * the physical output. CONTROL ports carry normalized parameter-control data,
 * and commands: a plugin that sequences MiniHub (One Ring) sends them from its
 * node's CTRL OUT (`commands: true`) to what a module accepts on its CTRL IN.
 * What each module accepts is its own `controlCommands()` -- core/commandBus.js.
 */

/**
 * The CTRL IN of a module that takes commands and has no parameter a knob could
 * be bound to. A controller's knob cabled here would do nothing, so the network
 * refuses that cable rather than drawing one that reads as working.
 */
export const COMMAND_INPUT = Object.freeze({ id: 'ctrl-in', type: 'control', label: 'CTRL IN', commandsOnly: true });

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
        { id: 'ctrl-in', type: 'control', label: 'CTRL IN' }
      ],
      // MIDI OUT repeats what enters MIDI IN, so one track can play a series of
      // instruments (D-039, `midiThru.js`). It faces MIDI IN, and AUDIO OUT faces
      // AUDIO IN, the way the Sequencer node lines its rows up by signal.
      outputs: [
        { id: 'midi-out', type: 'midi', label: 'MIDI OUT' },
        { id: 'audio-out', type: 'audio', label: 'AUDIO OUT' },
        // Facing CTRL IN. The Patch Bay draws its jack only on a node whose chain
        // holds a plugin that sends commands, or that already has a cable in it.
        { id: 'ctrl-out', type: 'control', label: 'CTRL OUT', commands: true }
      ]
    }
  },
  // A mixer's and a morpher's CTRL IN sits below their AUDIO IN rows, which grow
  // as they are cabled: see `buildRoutingNode` and `_ensureDynamicAudioPorts`.
  mixer: {
    id: 'mixer', label: 'Mixer', omniBoxCategory: 'Audio', accent: '--accent-mixer', icon: 'sliders',
    emptyLabel: 'Connect AUDIO sources in Patch Bay', dynamicAudioInputs: true,
    ports: { inputs: [COMMAND_INPUT], outputs: [{ id: 'audio-out', type: 'audio', label: 'AUDIO OUT' }] }
  },
  morpher: {
    id: 'morpher', label: 'Morpher', omniBoxCategory: 'Audio', accent: '--accent-morpher', icon: 'sequencer',
    emptyLabel: 'Connect AUDIO sources in Patch Bay', dynamicAudioInputs: true,
    ports: { inputs: [COMMAND_INPUT], outputs: [{ id: 'audio-out', type: 'audio', label: 'AUDIO OUT' }] }
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
  // A sequencer of commands and of notes: sixteen channels stepping whatever
  // its CTRL OUT is cabled to (oneRingSequence.js, oneRingNodes.js), and the
  // notes it captures on its MIDI IN and plays from its MIDI OUT. Its commands'
  // jack is drawn always, since the node sends commands by construction. It
  // makes no sound of its own, so it has no audio port.
  'one-ring': {
    id: 'one-ring', label: 'One Ring', omniBoxCategory: 'MIDI', accent: '--accent-sequencer', icon: 'ring',
    emptyLabel: 'Cable CTRL OUT or MIDI OUT to what it plays',
    ports: {
      inputs: [{ id: 'midi-in', type: 'midi', label: 'MIDI IN' }],
      outputs: [
        { id: 'ctrl-out', type: 'control', label: 'CTRL OUT', commands: true },
        { id: 'midi-out', type: 'midi', label: 'MIDI OUT' }
      ]
    }
  },
  arpeggiator: {
    id: 'arpeggiator', label: 'Arpeggiator', omniBoxCategory: 'MIDI', accent: '--accent-sequencer', icon: 'sequencer',
    emptyLabel: 'Hold notes and start transport',
    ports: {
      inputs: [{ id: 'midi-in', type: 'midi', label: 'MIDI IN' }, COMMAND_INPUT],
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
        { id: 'audio-in', type: 'audio', label: 'AUDIO IN' },
        COMMAND_INPUT
      ],
      outputs: [
        { id: 'midi-out', type: 'midi', label: 'MIDI OUT' },
        { id: 'audio-out', type: 'audio', label: 'AUDIO OUT' }
      ]
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
