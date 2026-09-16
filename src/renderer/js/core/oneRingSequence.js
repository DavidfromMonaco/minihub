import { VALUE_TYPE } from './commandRegistry.js';
import { OneRingRandom, RANDOM_STREAM } from './oneRingRandom.js';

/**
 * One Ring's sequence, as a One Ring node keeps it.
 *
 * THE CONTENT IS THE VST'S STATE, MADE SPARSE
 * -------------------------------------------
 * One Ring was a VST before it was a node, and a project may hold sequences it
 * saved: One Ring 0.4's state, version 1 -- four scenes of sixteen channels of
 * sixty-four cells, every cell written out. That state is the format, so a
 * sequence moves between the VST and the node without loss (`fromVstState`,
 * `toVstState`). Written out whole it is about 700 KB, and a node's content is
 * copied into every undo step and every settings save. So a channel carries a
 * `blank` -- the cell every unlisted index holds -- and lists, with their
 * `index`, only the cells that differ from it. The blank is not a detail: choosing
 * a command gives all 64 cells that command's default value, so a content that
 * listed every cell differing from an empty one would list them all again.
 *
 * The engine reads this same content (native one_ring/state_json.cpp) and runs
 * it; nothing here plays anything. What is here is what the VST's editor did to
 * a sequence: its checks, MUTATE, NEW SEED, a command change, STORE SCENE --
 * with the same rules, and for MUTATE the same random draws (oneRingRandom.js).
 *
 * Every function returns a new content and leaves its argument alone: a node's
 * content is an undo step, and a step that changes afterwards is not one.
 */

export const CHANNEL_COUNT = 16;
export const MAX_STEPS = 64;
export const SCENE_IDS = Object.freeze(['A', 'B', 'C', 'D']);
export const LENGTHS = Object.freeze([4, 8, 16, 32, 64]);
/** The editor's resolutions, as the denominator of 1/N. */
export const RESOLUTIONS = Object.freeze([4, 8, 16, 32]);
/** 0 repeats forever. */
export const REPEATS = Object.freeze([1, 2, 3, 4, 8, 0]);
export const STEP_MODE = Object.freeze({ trigger: 0, legato: 1 });
export const SCENE_TIMING = Object.freeze({ immediate: 0, nextBar: 1 });
export const SCENE_POSITION = Object.freeze({ restart: 0, keep: 1 });
export const VALUE_MODE = Object.freeze({ fixed: 0, range: 1, choice: 2 });
export const CONDITION = Object.freeze({ always: 0, everyNth: 1, first: 2, last: 3, ifActive: 4, ifInactive: 5 });
export const MUTABLE = Object.freeze({ enabled: 1, probability: 2, value: 4 });
export const ALL_MUTABLE = MUTABLE.enabled | MUTABLE.probability | MUTABLE.value;
export const SWING_MAX = 0.95;
export const HUMANIZE_MAX = 0.45;
export const OFFSET_LIMIT = 64;

export const CHANNEL_TARGET_PREFIX = 'one-ring:channel:';
export const SCENES_TARGET = 'one-ring:scenes';
export const CHANNEL_COMMANDS = Object.freeze(['START', 'STOP', 'RESTART', 'RESET', 'TOGGLE', 'ENABLE', 'DISABLE']);

const UINT64_MAX = (1n << 64n) - 1n;
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

const clone = (value) => structuredClone(value);
const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const fail = (message) => { throw new Error(message); };

// ---------- empty things ----------

export const emptyValue = () => ({ type: VALUE_TYPE.none });

export function emptySource() {
  return { mode: VALUE_MODE.fixed, fixed: emptyValue(), min: emptyValue(), max: emptyValue(), choices: [] };
}

export function emptyCell() {
  return { enabled: false, probability: 100, value: emptySource(), locked: false, lockedFields: 0, conditions: [] };
}

export function emptyAction() {
  return { target: '', command: '', value: emptySource() };
}

export function emptyChannel() {
  return {
    target: emptyAction(), length: 16, numerator: 1, denominator: 16, mode: STEP_MODE.trigger, repeats: 0,
    enabled: true, offset: 0, swing: 0, humanize: 0, mutableFields: ALL_MUTABLE,
    blank: emptyCell(), steps: [], follow: []
  };
}

/** What One Ring holds when it is first loaded: four empty scenes, seed 1. */
export function createSequence() {
  return {
    version: 1,
    seed: '1',
    mutation: '0',
    selectedScene: 0,
    sceneTiming: SCENE_TIMING.immediate,
    scenePosition: SCENE_POSITION.restart,
    scenes: SCENE_IDS.map((id) => ({
      id,
      name: `Scene ${id}`,
      channels: Array.from({ length: CHANNEL_COUNT }, emptyChannel)
    }))
  };
}

// ---------- reading ----------
//
// The same checks the engine and the VST make, so a state either side refuses is
// refused here first, with the field it failed on.

function readValue(raw, path) {
  if (!isObject(raw)) return emptyValue();
  const type = raw.type ?? VALUE_TYPE.none;
  switch (type) {
    case VALUE_TYPE.none: return emptyValue();
    case VALUE_TYPE.boolean:
      if (typeof raw.value !== 'boolean') fail(`${path}: a boolean value is required`);
      return { type, value: raw.value };
    case VALUE_TYPE.number:
      if (!Number.isFinite(raw.value)) fail(`${path}: a finite value is required`);
      return { type, value: raw.value };
    case VALUE_TYPE.integer:
    case VALUE_TYPE.choice:
      if (!Number.isInteger(raw.value) || raw.value < INT32_MIN || raw.value > INT32_MAX) {
        fail(`${path}: a 32-bit integer value is required`);
      }
      return { type, value: raw.value };
    default: return fail(`${path}: unknown value type`);
  }
}

function readSource(raw, path) {
  if (!isObject(raw)) return emptySource();
  const mode = raw.mode ?? VALUE_MODE.fixed;
  if (!Object.values(VALUE_MODE).includes(mode)) fail(`${path}: invalid value mode`);
  return {
    mode,
    fixed: readValue(raw.fixed, `${path}.fixed`),
    min: readValue(raw.min, `${path}.min`),
    max: readValue(raw.max, `${path}.max`),
    choices: Array.isArray(raw.choices) ? raw.choices.map((item, i) => readValue(item, `${path}.choices[${i}]`)) : []
  };
}

function readAction(raw, path) {
  if (!isObject(raw)) fail(`${path}: an action is required`);
  return {
    target: String(raw.target ?? ''),
    command: String(raw.command ?? ''),
    value: readSource(raw.value, `${path}.value`)
  };
}

// A field a cell leaves out keeps the value of the cell it starts from.
function readCell(raw, from, path) {
  if (!isObject(raw)) fail(`${path}: a cell is required`);
  const cell = clone(from);
  if ('enabled' in raw) cell.enabled = raw.enabled === true;
  if ('probability' in raw) cell.probability = Number(raw.probability);
  if ('value' in raw) cell.value = readSource(raw.value, `${path}.value`);
  if ('locked' in raw) cell.locked = raw.locked === true;
  if ('lockedFields' in raw) cell.lockedFields = Number(raw.lockedFields) >>> 0;
  if (Array.isArray(raw.conditions)) {
    cell.conditions = raw.conditions.map((condition, i) => {
      const kind = condition?.kind;
      if (!Number.isInteger(kind) || kind < CONDITION.always || kind > CONDITION.ifInactive) {
        fail(`${path}.conditions[${i}]: invalid condition`);
      }
      return { kind, interval: Number(condition.interval ?? 0) >>> 0, channel: Number(condition.channel ?? 0) >>> 0 };
    });
  }
  return cell;
}

// A field left out reads as 0, as the engine and the VST read it: the two sides
// accept and refuse the same states. `sequenceErrors` says what 0 breaks.
function readChannel(raw, path) {
  if (!isObject(raw)) fail(`${path}: a channel is required`);
  const mode = raw.mode ?? STEP_MODE.trigger;
  if (mode !== STEP_MODE.trigger && mode !== STEP_MODE.legato) fail(`${path}: invalid step mode`);
  const channel = {
    target: readAction(raw.target, `${path}.target`),
    length: Number(raw.length ?? 0),
    numerator: Number(raw.numerator ?? 0),
    denominator: Number(raw.denominator ?? 0),
    mode,
    repeats: Number(raw.repeats ?? 0),
    enabled: raw.enabled === true,
    offset: Number(raw.offset ?? 0),
    swing: Number(raw.swing ?? 0),
    humanize: Number(raw.humanize ?? 0),
    mutableFields: Number(raw.mutableFields ?? 0) >>> 0,
    blank: emptyCell(),
    steps: [],
    follow: Array.isArray(raw.follow) ? raw.follow.map((item, i) => readAction(item, `${path}.follow[${i}]`)) : []
  };
  const steps = raw.steps;
  if (!Array.isArray(steps)) fail(`${path}: a channel needs its cells`);
  const sparse = steps.length === 0 || (isObject(steps[0]) && 'index' in steps[0]);
  if (!sparse) {
    if (steps.length !== MAX_STEPS) fail(`${path}: a channel must preserve 64 authored cells`);
    return withCells(channel, steps.map((item, i) => readCell(item, emptyCell(), `${path}.steps[${i}]`)));
  }
  const blank = isObject(raw.blank) ? readCell(raw.blank, emptyCell(), `${path}.blank`) : emptyCell();
  const cells = Array.from({ length: MAX_STEPS }, () => clone(blank));
  const seen = new Set();
  steps.forEach((item, i) => {
    const index = item?.index;
    if (!Number.isInteger(index) || index < 0 || index >= MAX_STEPS) fail(`${path}.steps[${i}]: an index from 0 to 63 is required`);
    if (seen.has(index)) fail(`${path}.steps[${i}]: cell ${index} is listed twice`);
    seen.add(index);
    cells[index] = readCell(item, blank, `${path}.steps[${i}]`);
  });
  return withCells(channel, cells);
}

function readSeed(raw, path) {
  const text = String(raw ?? '');
  if (!/^\d{1,20}$/.test(text) || BigInt(text) > UINT64_MAX) fail(`${path}: a seed below 18446744073709551616`);
  return BigInt(text).toString();
}

/**
 * A sequence from a VST state or a node's content, checked and put in the
 * node's form. Throws an Error naming the first field it cannot read.
 */
export function readSequence(raw) {
  if (!isObject(raw)) fail('a One Ring state is an object');
  if (raw.version !== 1) fail('version: unsupported One Ring state version');
  const sceneTiming = raw.sceneTiming ?? SCENE_TIMING.immediate;
  const scenePosition = raw.scenePosition ?? SCENE_POSITION.restart;
  if (!Object.values(SCENE_TIMING).includes(sceneTiming) || !Object.values(SCENE_POSITION).includes(scenePosition)) {
    fail('sceneTiming: invalid scene behavior');
  }
  if (!Array.isArray(raw.scenes) || raw.scenes.length === 0) fail('scenes: missing scenes');
  const scenes = raw.scenes.map((scene, s) => {
    if (!isObject(scene)) fail(`scenes[${s}]: a scene is required`);
    if (!Array.isArray(scene.channels) || scene.channels.length !== CHANNEL_COUNT) {
      fail(`scenes[${s}]: a scene must contain 16 channels`);
    }
    return {
      id: String(scene.id ?? ''),
      name: String(scene.name ?? ''),
      channels: scene.channels.map((channel, c) => readChannel(channel, `scenes[${s}].channels[${c}]`))
    };
  });
  const selectedScene = Number(raw.selectedScene);
  return {
    version: 1,
    seed: readSeed(raw.seed, 'seed'),
    mutation: readSeed(raw.mutation, 'mutation'),
    selectedScene: Number.isInteger(selectedScene) ? selectedScene : 0,
    sceneTiming,
    scenePosition,
    scenes
  };
}

/** A VST's saved state as a node's content. */
export const fromVstState = readSequence;

/**
 * A One Ring VST's sequence, from the component stream of its saved state
 * (juceState.js, `readVst3State`).
 *
 * The VST writes its state as JSON, and JUCE's wrapper adds its own data after
 * it -- and, when the plugin may replace a VST2, a header before it. So the
 * sequence is the first JSON object in the stream that reads as a One Ring
 * state, ending where JUCE's data starts: at a zero byte, which a JSON text
 * never holds. Throws when there is none, or when the one found is malformed.
 */
export function sequenceFromComponentState(bytes) {
  if (!(bytes instanceof Uint8Array)) fail('no plugin state to read');
  const decoder = new TextDecoder();
  let from = bytes.indexOf(0x7b);
  for (let attempt = 0; from >= 0 && attempt < 64; attempt += 1) {
    const zero = bytes.indexOf(0, from);
    const text = decoder.decode(bytes.subarray(from, zero < 0 ? bytes.length : zero));
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (_) {
      parsed = null;
    }
    if (isObject(parsed) && Array.isArray(parsed.scenes)) return readSequence(parsed);
    from = bytes.indexOf(0x7b, from + 1);
  }
  return fail('not a One Ring state');
}

/** A node's content as the VST writes its state: every cell, in the VST's key order. */
export function toVstState(content) {
  return {
    version: 1,
    seed: content.seed,
    mutation: content.mutation,
    selectedScene: content.selectedScene,
    sceneTiming: content.sceneTiming,
    scenePosition: content.scenePosition,
    scenes: content.scenes.map((scene) => ({
      id: scene.id,
      name: scene.name,
      channels: scene.channels.map((channel) => ({
        target: clone(channel.target),
        length: channel.length,
        numerator: channel.numerator,
        denominator: channel.denominator,
        mode: channel.mode,
        repeats: channel.repeats,
        enabled: channel.enabled,
        offset: channel.offset,
        swing: channel.swing,
        humanize: channel.humanize,
        mutableFields: channel.mutableFields,
        steps: cellsOf(channel),
        follow: clone(channel.follow)
      }))
    }))
  };
}

// ---------- cells ----------

const cellKey = (cell) => JSON.stringify(cell);

/** The cell at `index`: its listed cell, or the channel's blank. A copy. */
export function cellAt(channel, index) {
  const listed = channel.steps.find((step) => step.index === index);
  if (!listed) return clone(channel.blank);
  const { index: _index, ...cell } = listed;
  return clone(cell);
}

/** All 64 cells of a channel, as copies. */
export function cellsOf(channel) {
  const cells = Array.from({ length: MAX_STEPS }, () => clone(channel.blank));
  for (const step of channel.steps) {
    const { index, ...cell } = step;
    cells[index] = clone(cell);
  }
  return cells;
}

/**
 * The channel holding exactly `cells`. Its blank becomes the cell most of them
 * share -- the empty cell on a tie, then the first met -- so the same cells
 * always give the same content, and only the others are listed.
 */
export function withCells(channel, cells) {
  const keys = cells.map(cellKey);
  const counts = new Map();
  for (const key of keys) counts.set(key, (counts.get(key) || 0) + 1);
  const most = Math.max(...counts.values());
  const emptyKey = cellKey(emptyCell());
  const blankKey = counts.get(emptyKey) === most ? emptyKey : [...counts].find(([, count]) => count === most)[0];
  const steps = [];
  keys.forEach((key, index) => {
    if (key !== blankKey) steps.push({ index, ...clone(cells[index]) });
  });
  return { ...channel, blank: JSON.parse(blankKey), steps };
}

/** The channel with cell `index` replaced. */
export function setCell(channel, index, cell) {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_STEPS) throw new RangeError(`no cell ${index}`);
  const cells = cellsOf(channel);
  cells[index] = readCell(cell, emptyCell(), `cell ${index}`);
  return withCells(channel, cells);
}

// ---------- targets and checks ----------

/** One Ring's own targets: each channel's seven commands, and the scene recall. */
export function oneRingTargets(content) {
  const channels = Array.from({ length: CHANNEL_COUNT }, (_, i) => ({
    id: `${CHANNEL_TARGET_PREFIX}${i + 1}`,
    label: `One Ring Channel / CH${i + 1}`,
    commands: new Map(CHANNEL_COMMANDS.map((id) => [id, {
      id, label: id, type: VALUE_TYPE.none, ...(id === 'START' ? { releaseCommand: 'STOP' } : {})
    }]))
  }));
  const recall = {
    id: 'RECALL',
    label: 'RECALL',
    type: VALUE_TYPE.choice,
    choices: content.scenes.map((scene, i) => ({ id: i, label: scene.name }))
  };
  return [...channels, { id: SCENES_TARGET, label: 'One Ring Scenes', commands: new Map([['RECALL', recall]]) }];
}

/**
 * A lookup over what the node may command: One Ring's own targets, then the
 * compiled targets CommandBus reached through the node's CTRL OUT
 * (`{ id, commands: Map }`). Answers a command's descriptor, or null.
 */
export function targetFinder(content, externalTargets = []) {
  const all = [...oneRingTargets(content), ...externalTargets];
  return (target, command) => all.find((item) => item.id === target)?.commands?.get(command) ?? null;
}

/** Does `value` fit what `descriptor` declares? The engine's rule, type for type. */
export function valueAccepted(descriptor, value) {
  if (!descriptor || value?.type !== descriptor.type) return false;
  switch (descriptor.type) {
    case VALUE_TYPE.none: return true;
    case VALUE_TYPE.boolean: return typeof value.value === 'boolean';
    case VALUE_TYPE.integer:
      return Number.isInteger(value.value) && value.value >= descriptor.minimum && value.value <= descriptor.maximum;
    case VALUE_TYPE.number:
      return Number.isFinite(value.value) && value.value >= descriptor.minimum && value.value <= descriptor.maximum;
    case VALUE_TYPE.choice: return (descriptor.choices || []).some((item) => item.id === value.value);
    default: return false;
  }
}

/** Does a cell's value -- fixed, a range or a list of choices -- fit the command? */
export function sourceAccepted(descriptor, source) {
  if (source.mode === VALUE_MODE.fixed) return valueAccepted(descriptor, source.fixed);
  if (source.mode === VALUE_MODE.choice) {
    return source.choices.length > 0 && source.choices.every((value) => valueAccepted(descriptor, value));
  }
  if (descriptor.type !== VALUE_TYPE.integer && descriptor.type !== VALUE_TYPE.number) return false;
  return valueAccepted(descriptor, source.min) && valueAccepted(descriptor, source.max)
    && source.min.value <= source.max.value;
}

/**
 * What is wrong with a sequence, by the VST's rules (its model.cpp). `find` is
 * a `targetFinder`: a target nobody answers for is not wrong, since the engine
 * keeps it authored and counts it when it plays.
 */
export function sequenceErrors(content, find) {
  const errors = new Set();
  if (content?.version !== 1) errors.add('Unsupported project version');
  if (!Object.values(SCENE_TIMING).includes(content?.sceneTiming)
      || !Object.values(SCENE_POSITION).includes(content?.scenePosition)) errors.add('Invalid scene policy');
  const scenes = Array.isArray(content?.scenes) ? content.scenes : [];
  if (!scenes.length || !Number.isInteger(content.selectedScene) || content.selectedScene < 0
      || content.selectedScene >= scenes.length) errors.add('Missing selected scene');
  const actionValid = (action, source) => {
    if (!action.target && !action.command) return true;
    const descriptor = find(action.target, action.command);
    return !descriptor || sourceAccepted(descriptor, source);
  };
  const checkCell = (channel, cell) => {
    if (!Number.isFinite(cell.probability) || cell.probability < 0 || cell.probability > 100) {
      errors.add('Probability must be between 0 and 100');
    }
    if (!actionValid(channel.target, cell.value)) errors.add('Invalid step value');
    for (const condition of cell.conditions) {
      if (!(condition.kind >= CONDITION.always && condition.kind <= CONDITION.ifInactive)) errors.add('Invalid condition');
      if (condition.kind === CONDITION.everyNth && condition.interval === 0) errors.add('Loop interval must be positive');
      if ((condition.kind === CONDITION.ifActive || condition.kind === CONDITION.ifInactive)
          && condition.channel >= CHANNEL_COUNT) errors.add('Condition channel is outside CH1-CH16');
    }
  };
  const ids = new Set();
  for (const scene of scenes) {
    if (!scene.id || ids.has(scene.id)) errors.add('Missing or duplicate scene ID');
    ids.add(scene.id);
    for (const channel of scene.channels) {
      if (channel.mode !== STEP_MODE.trigger && channel.mode !== STEP_MODE.legato) errors.add('Invalid step mode');
      if (!LENGTHS.includes(channel.length)) errors.add('Channel length must be 4, 8, 16, 32 or 64');
      if (!channel.numerator || !channel.denominator) errors.add('Invalid resolution');
      if (![0, 1, 2, 3, 4, 8].includes(channel.repeats)) errors.add('Invalid repeat count');
      if (!Number.isFinite(channel.offset) || !Number.isFinite(channel.swing) || !Number.isFinite(channel.humanize)
          || channel.swing < 0 || channel.swing > SWING_MAX || channel.humanize < 0 || channel.humanize > HUMANIZE_MAX) {
        errors.add('Invalid timing parameters');
      }
      const descriptor = find(channel.target.target, channel.target.command);
      if (channel.mode === STEP_MODE.legato && descriptor && !descriptor.releaseCommand) {
        errors.add('Target has not declared a legato release');
      }
      // Unlisted cells are copies of the blank: checking it once checks them all.
      if (channel.steps.length < MAX_STEPS) checkCell(channel, channel.blank);
      for (const step of channel.steps) checkCell(channel, step);
      for (const action of channel.follow) {
        if (!actionValid(action, action.value)) errors.add('Invalid follow action');
      }
    }
  }
  return [...errors];
}

// ---------- what the editor does ----------

/** The value a cell takes when its channel's command changes -- the VST editor's default. */
export function defaultSource(descriptor) {
  const source = emptySource();
  switch (descriptor?.type) {
    case VALUE_TYPE.boolean: source.fixed = { type: VALUE_TYPE.boolean, value: false }; break;
    case VALUE_TYPE.integer: source.fixed = { type: VALUE_TYPE.integer, value: Math.trunc(descriptor.minimum) }; break;
    case VALUE_TYPE.number: source.fixed = { type: VALUE_TYPE.number, value: descriptor.minimum }; break;
    case VALUE_TYPE.choice:
      if (descriptor.choices?.length) source.fixed = { type: VALUE_TYPE.choice, value: descriptor.choices[0].id };
      break;
    default: break;
  }
  return source;
}

/**
 * The channel aimed at another target or command. As in the VST's editor, every
 * cell takes the new command's default value and the channel goes back to
 * Trigger; which cells are active is kept.
 */
export function retarget(channel, target, command, descriptor) {
  const value = defaultSource(descriptor);
  const cells = cellsOf(channel).map((cell) => ({ ...cell, value: clone(value) }));
  return withCells({ ...channel, target: { ...emptyAction(), target, command }, mode: STEP_MODE.trigger }, cells);
}

/** Every cell emptied, holding the command's default value. */
export function clearCells(channel, descriptor) {
  const value = defaultSource(descriptor);
  return withCells(channel, Array.from({ length: MAX_STEPS }, () => ({ ...emptyCell(), value: clone(value) })));
}

function sampleValue(source, random) {
  if (source.mode === VALUE_MODE.fixed) return source.fixed;
  if (source.mode === VALUE_MODE.choice) {
    return source.choices.length ? source.choices[Number(random.below(source.choices.length))] : emptyValue();
  }
  const { min, max } = source;
  if (min.type === VALUE_TYPE.integer) {
    if (max.type !== VALUE_TYPE.integer || max.value < min.value) return emptyValue();
    const width = BigInt(max.value) - BigInt(min.value) + 1n;
    return { type: VALUE_TYPE.integer, value: Number(BigInt(min.value) + random.below(width)) };
  }
  if (min.type !== VALUE_TYPE.number || max.type !== VALUE_TYPE.number || max.value < min.value) return emptyValue();
  const u = random.unit();
  // The engine's convex interpolation, operation for operation.
  return { type: VALUE_TYPE.number, value: (1 - u) * min.value + u * max.value };
}

/**
 * MUTATE on one channel: the VST's `mutate`, draw for draw. A locked cell is
 * skipped; every other cell draws all its fields even when some are locked, so
 * protecting one field never changes what the others become.
 */
export function mutateChannel(channel, seed, mutation, channelIndex) {
  const cells = cellsOf(channel);
  for (let i = 0; i < channel.length; i += 1) {
    const cell = cells[i];
    if (cell.locked) continue;
    const random = new OneRingRandom({ seed, execution: mutation, loop: 0, channel: channelIndex, step: i },
      RANDOM_STREAM.mutation);
    const enabled = random.probability(50);
    const probability = Number(random.below(101));
    const value = sampleValue(cell.value, random);
    const other = sampleValue(cell.value, random);
    const fields = channel.mutableFields & ~cell.lockedFields;
    if (fields & MUTABLE.enabled) cell.enabled = enabled;
    if (fields & MUTABLE.probability) cell.probability = probability;
    if (!(fields & MUTABLE.value)) continue;
    if (cell.value.mode === VALUE_MODE.range) {
      if (value.type === VALUE_TYPE.integer || value.type === VALUE_TYPE.number) {
        // std::min and std::max, including which operand wins a tie.
        const low = other.value < value.value ? other.value : value.value;
        const high = value.value < other.value ? other.value : value.value;
        cell.value = { ...cell.value, min: { type: value.type, value: low }, max: { type: value.type, value: high } };
      }
    } else if (cell.value.mode === VALUE_MODE.choice && cell.value.choices.length) {
      const rotation = Number(random.below(cell.value.choices.length));
      const choices = cell.value.choices;
      cell.value = { ...cell.value, choices: [...choices.slice(rotation), ...choices.slice(0, rotation)] };
    }
  }
  return withCells(channel, cells);
}

/**
 * MUTATE: the mutation count goes up by one, then one channel of the scene --
 * or all sixteen -- mutates with it.
 */
export function mutateSequence(content, { scene = content.selectedScene, channel } = {}) {
  if (!content.scenes[scene]) throw new RangeError(`no scene ${scene}`);
  if (channel !== undefined && !(Number.isInteger(channel) && channel >= 0 && channel < CHANNEL_COUNT)) {
    throw new RangeError(`no channel ${channel}`);
  }
  const mutation = ((BigInt(content.mutation) + 1n) & UINT64_MAX).toString();
  const scenes = content.scenes.map((item, s) => {
    if (s !== scene) return item;
    return {
      ...item,
      channels: item.channels.map((current, c) => (channel === undefined || channel === c
        ? mutateChannel(current, content.seed, mutation, c)
        : current))
    };
  });
  return { ...content, mutation, scenes };
}

/** A decimal seed, checked, or null. */
export function parseSeed(text) {
  const value = String(text ?? '').trim();
  if (!/^\d{1,20}$/.test(value) || BigInt(value) > UINT64_MAX) return null;
  return BigInt(value).toString();
}

/** NEW SEED: a new random family -- or the given seed -- and the mutation count back to zero. */
export function reseed(content, seed) {
  let value;
  if (seed === undefined) {
    const draw = new BigUint64Array(1);
    globalThis.crypto.getRandomValues(draw);
    value = draw[0].toString();
  } else {
    value = parseSeed(seed);
    if (value === null) throw new RangeError('a seed is a whole number below 18446744073709551616');
  }
  return { ...content, seed: value, mutation: '0' };
}

/** STORE SCENE: one scene's sixteen channels copied into another; ids and names stay. */
export function storeScene(content, from, to) {
  if (!content.scenes[from] || !content.scenes[to]) throw new RangeError('no such scene');
  if (from === to) return content;
  const channels = clone(content.scenes[from].channels);
  return {
    ...content,
    scenes: content.scenes.map((scene, s) => (s === to ? { ...scene, channels } : scene))
  };
}
