import { choice, integer, number, toggle } from './commandRegistry.js';
import {
  ARP_LENGTHS, ARP_MODES, ARP_OFFSET_MAX, ARP_OFFSET_MIN, ARP_RATES, ARP_ROOTS, ARP_SCALES
} from './arpeggiatorState.js';

/**
 * What the node types' CTRL IN accepts: the commands a plugin cabled to it may
 * send (commandBus.js, commandRegistry.js).
 *
 * Every command here is something the node's own page already does -- a knob, a
 * switch, a slider -- written through the same `setContent` the agent channel
 * uses, so the engine is told by the republish `engineSync` performs and nothing
 * here speaks to it directly. A command does not invent behaviour a node lacks:
 * the arpeggiator has no hold and no on/off, so it is offered neither.
 *
 * Each `execute` reads the node again when it runs. The command list is compiled
 * once per change, and a closure over the content of that moment would write an
 * old pattern back over an edit made since.
 */

const ARP_STEP_COUNT = 32;
const MORPHER_STEP_COUNT = 32;
const MORPHER_LENGTHS = [4, 8, 16, 32];
const SEED_MAX = 2147483647;

/** Merge `changes` into a node's content. False only when the node is gone. */
function writeContent(hub, nodeId, changes) {
  const node = hub.nodes.get(nodeId);
  if (!node) return false;
  hub.nodes.setContent(nodeId, { ...node.content, ...changes });
  return true;
}

function arpeggiatorCommands(hub, nodeId) {
  const node = hub.nodes.get(nodeId);
  if (!node) return [];
  const write = (changes) => writeContent(hub, nodeId, changes);
  const writeStep = (index, field, value) => {
    const pattern = hub.nodes.get(nodeId)?.content?.customPattern;
    if (!Array.isArray(pattern) || !pattern[index]) return false;
    return write({ customPattern: pattern.map((step, i) => (i === index ? { ...step, [field]: value } : step)) });
  };
  const commands = [
    choice('RATE', 'Rate', ARP_RATES, (rate) => write({ rate })),
    choice('MODE', 'Mode', ARP_MODES, (mode) => write({ mode })),
    choice('ROOT', 'Root', ARP_ROOTS.map((_, index) => index), (root) => write({ root }), (index) => ARP_ROOTS[index]),
    choice('SCALE', 'Scale', Object.keys(ARP_SCALES), (scale) => write({ scale })),
    choice('STEPS', 'Steps', ARP_LENGTHS, (patternLength) => write({ patternLength })),
    toggle('SNAP', 'Snap to Scale', (snapToScale) => write({ snapToScale })),
    integer('SEED', 'Random seed', 0, SEED_MAX, (randomSeed) => write({ randomSeed }))
  ];
  for (let index = 0; index < ARP_STEP_COUNT; index += 1) {
    const step = index + 1;
    commands.push(
      integer(`STEP_${step}_PITCH`, `Step ${step} pitch`, ARP_OFFSET_MIN, ARP_OFFSET_MAX,
        (value) => writeStep(index, 'semitoneOffset', value)),
      integer(`STEP_${step}_VELOCITY`, `Step ${step} velocity`, 1, 127, (value) => writeStep(index, 'velocity', value)),
      number(`STEP_${step}_GATE`, `Step ${step} gate`, 0.05, 1, (value) => writeStep(index, 'gate', value)),
      toggle(`STEP_${step}_REST`, `Step ${step} rest`, (value) => writeStep(index, 'rest', value)),
      toggle(`STEP_${step}_TIE`, `Step ${step} tie`, (value) => writeStep(index, 'tie', value))
    );
  }
  return [{ id: nodeId, label: node.name, commands }];
}

/** An input's level and mute, shared by the Mixer and the Morpher. */
function audioInputCommands(hub, nodeId, inputs) {
  const writeInput = (inputId, changes) => {
    const current = hub.nodes.get(nodeId)?.content?.inputs;
    if (!Array.isArray(current) || !current.some((input) => input.id === inputId)) return false;
    return writeContent(hub, nodeId, {
      inputs: current.map((input) => (input.id === inputId ? { ...input, ...changes } : input))
    });
  };
  return inputs.flatMap((input, index) => [
    number(`${input.id}:LEVEL`, `Input ${index + 1} level`, 0, 2, (level) => writeInput(input.id, { level })),
    toggle(`${input.id}:MUTE`, `Input ${index + 1} mute`, (muted) => writeInput(input.id, { muted }))
  ]);
}

function mixerCommands(hub, nodeId) {
  const node = hub.nodes.get(nodeId);
  if (!node) return [];
  return [{
    id: nodeId,
    label: node.name,
    commands: [
      ...audioInputCommands(hub, nodeId, node.content?.inputs || []),
      number('MASTER', 'Master', 0, 2, (masterLevel) => writeContent(hub, nodeId, { masterLevel }))
    ]
  }];
}

function morpherCommands(hub, nodeId) {
  const node = hub.nodes.get(nodeId);
  if (!node) return [];
  const writeStep = (index, value) => {
    const steps = hub.nodes.get(nodeId)?.content?.steps;
    if (!Array.isArray(steps)) return false;
    return writeContent(hub, nodeId, { steps: steps.map((step, i) => (i === index ? value : step)) });
  };
  return [{
    id: nodeId,
    label: node.name,
    commands: [
      ...audioInputCommands(hub, nodeId, node.content?.inputs || []),
      choice('STEPS', 'Steps', MORPHER_LENGTHS, (stepCount) => writeContent(hub, nodeId, { stepCount })),
      ...Array.from({ length: MORPHER_STEP_COUNT }, (_, index) => number(
        `STEP_${index + 1}`, `Step ${index + 1}`, 0, 1, (value) => writeStep(index, value)
      ))
    ]
  }];
}

// Parameters are read from the engine, which answers asynchronously. The list
// is kept per running instance and asked for again when the instance changes.
const discoveries = new WeakMap(); // hub -> Map(`${nodeId}\u001f${pluginInstanceId}` -> entry)

const isWritableParameter = (parameter) => parameter && parameter.readOnly !== true
  && typeof parameter.parameterId === 'string' && /^(0|[1-9][0-9]{0,9})$/.test(parameter.parameterId);

function knownParameters(hub, nodeId, plugin, generation) {
  let cache = discoveries.get(hub);
  if (!cache) {
    cache = new Map();
    discoveries.set(hub, cache);
  }
  const key = `${nodeId}\u001f${plugin.id}`;
  let entry = cache.get(key);
  if (!entry || entry.failed || entry.generation !== generation || entry.pluginId !== plugin.pluginId) {
    entry = { generation, pluginId: plugin.pluginId, parameters: [], failed: false };
    cache.set(key, entry);
    const pending = entry;
    Promise.resolve(hub.engine.getVstParameters?.(nodeId, plugin.id))
      .then((response) => {
        if (cache.get(key) !== pending) return;
        if (response?.status !== 'ok' || response.pluginId !== plugin.pluginId) {
          // Asked again at the next change of the node, never in a loop.
          pending.failed = true;
          return;
        }
        pending.parameters = (Array.isArray(response.parameters) ? response.parameters : []).filter(isWritableParameter);
        hub.events.emit('commands:providerChanged', { nodeId });
      })
      .catch(() => { pending.failed = true; });
  }
  return entry.parameters;
}

function vstCommands(hub, nodeId) {
  const node = hub.nodes.get(nodeId);
  if (!node) return [];
  const plugins = Array.isArray(node.content?.plugins) ? node.content.plugins : [];
  const cache = discoveries.get(hub);
  if (cache) {
    for (const key of cache.keys()) {
      const [owner, pluginInstanceId] = key.split('\u001f');
      if (owner === nodeId && !plugins.some((plugin) => plugin.id === pluginInstanceId)) cache.delete(key);
    }
  }
  return plugins.flatMap((plugin) => {
    const generation = hub.engine.getInstanceGeneration?.(nodeId, plugin.id);
    if (hub.engine.getInstanceStatus?.(nodeId, plugin.id) !== 'ready' || !Number.isSafeInteger(generation)) return [];
    const setParameter = (parameterId, normalizedValue) => {
      const result = hub.engine.setVstParameter(nodeId, plugin.id, plugin.pluginId, parameterId, normalizedValue);
      return result?.ok === false ? result : true;
    };
    const parameters = knownParameters(hub, nodeId, plugin, generation).map((parameter) => {
      const label = parameter.name || `Parameter ${parameter.parameterId}`;
      // A stepped parameter is addressed by its steps, the way its own knob clicks.
      return Number.isInteger(parameter.stepCount) && parameter.stepCount > 0
        ? integer(`PARAM:${parameter.parameterId}`, label, 0, parameter.stepCount,
          (step) => setParameter(parameter.parameterId, step / parameter.stepCount))
        : number(`PARAM:${parameter.parameterId}`, label, 0, 1,
          (value) => setParameter(parameter.parameterId, value));
    });
    return [{
      id: `${nodeId}:${plugin.id}`,
      label: `${node.name} / ${plugin.name || plugin.id}`,
      // The running instance, not the chain entry: a release is never sent to
      // the plugin that replaced the one that accepted the hold.
      lifetime: [plugin.pluginId, generation],
      commands: [
        toggle('BYPASS', 'Bypass', (bypassed) => hub.nodes.setPluginBypass(nodeId, plugin.id, bypassed)),
        ...parameters
      ]
    }];
  });
}

/** Command providers by node type, attached to each node's module by nodeInstances.js. */
export const NODE_COMMANDS = Object.freeze({
  arpeggiator: arpeggiatorCommands,
  mixer: mixerCommands,
  morpher: morpherCommands,
  vst: vstCommands
});
