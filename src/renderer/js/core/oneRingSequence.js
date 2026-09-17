import { VALUE_TYPE } from './commandRegistry.js';
import { ARP_SCALES } from './arpeggiatorState.js';
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
 *
 * PART TWO: THE MATERIAL
 * ----------------------
 * A node also keeps what it plays notes from (native one_ring/material.h): the
 * notes it captured or was given -- the `origin` -- and what feedback made of
 * them -- the `current` generation, null until there is one -- with the
 * capture's settings. A note is `{ pitch, velocity, channel, start, duration }`
 * in ticks, 960 to the quarter as the Sequencer counts, and a list is ordered
 * by start, pitch and channel, as the engine orders it, so the same notes read
 * the same on both sides. None of it is in the VST's state.
 *
 * Each scene also holds four voices' rules (native one_ring/voices.h): what a
 * voice does to the material's notes while the scene plays. A channel aimed at
 * `one-ring:voice:N` plays notes through that voice.
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
export const MEMORY_TARGET = 'one-ring:memory';
export const MEMORY_COMMANDS = Object.freeze([
  'CAPTURE_REPLACE', 'CAPTURE_ADD', 'CAPTURE_END', 'CLEAR', 'FREEZE', 'UNFREEZE', 'REVERT'
]);

export const TICKS_PER_BEAT = 960;
export const TICKS_PER_BAR = 4 * TICKS_PER_BEAT;
export const MATERIAL_CAPACITY = 256;
export const MAX_MATERIAL_TICKS = 64 * TICKS_PER_BAR;
export const MAX_CAPTURE_BARS = 16;
export const CAPTURE_MODE = Object.freeze({ replace: 0, add: 1 });

export const VOICE_COUNT = 4;
export const VOICE_TARGET_PREFIX = 'one-ring:voice:';
export const NOTE_ORDER = Object.freeze({ asPlayed: 0, rising: 1, falling: 2, shuffled: 3 });
export const ROOT_NAMES = Object.freeze(['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']);
/** The Arpeggiator's scales, in its order: one table for both. */
export const SCALE_NAMES = Object.freeze(Object.keys(ARP_SCALES));
export const SHORTEST_DURATION = TICKS_PER_BEAT / 16;
export const LONGEST_DURATION = 64 * TICKS_PER_BEAT;

/**
 * A voice's rules, their ranges and what changes nothing, in the order the
 * engine writes them.
 */
export const VOICE_RULES = Object.freeze({
  channel: { min: 0, max: 16, neutral: 0 },
  root: { min: 0, max: 11, neutral: 0 },
  scale: { min: 0, max: SCALE_NAMES.length - 1, neutral: 0 },
  transpose: { min: -48, max: 48, neutral: 0 },
  octave: { min: -3, max: 3, neutral: 0 },
  octaveSpread: { min: 0, max: 3, neutral: 0 },
  octaveChance: { min: 0, max: 100, neutral: 0 },
  low: { min: 0, max: 127, neutral: 0 },
  high: { min: 0, max: 127, neutral: 127 },
  velocityScale: { min: 0, max: 200, neutral: 100 },
  velocitySpread: { min: 0, max: 127, neutral: 0 },
  velocityLow: { min: 1, max: 127, neutral: 1 },
  velocityHigh: { min: 1, max: 127, neutral: 127 },
  gateScale: { min: 5, max: 400, neutral: 100 },
  gateSpread: { min: 0, max: 100, neutral: 0 },
  shortest: { min: SHORTEST_DURATION, max: LONGEST_DURATION, neutral: SHORTEST_DURATION },
  longest: { min: SHORTEST_DURATION, max: LONGEST_DURATION, neutral: LONGEST_DURATION },
  order: { min: 0, max: 3, neutral: NOTE_ORDER.asPlayed },
  density: { min: 0, max: 100, neutral: 100 }
});

export const VOICE_COMMANDS = Object.freeze([
  'PLAY', 'NOTE', 'NOTE_OFF', 'TRANSPOSE', 'OCTAVE', 'ROOT', 'SCALE', 'VELOCITY', 'GATE', 'DENSITY'
]);

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

export const emptyNoteList = () => ({ length: TICKS_PER_BAR, notes: [] });

export function emptyMaterial() {
  return { origin: emptyNoteList(), current: null, generation: 0, frozen: false };
}

export const defaultCapture = () => ({ mode: CAPTURE_MODE.replace, bars: 1 });

export function defaultVoice() {
  return Object.fromEntries(Object.entries(VOICE_RULES).map(([rule, { neutral }]) => [rule, neutral]));
}

export const defaultVoices = () => Array.from({ length: VOICE_COUNT }, defaultVoice);

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
      channels: Array.from({ length: CHANNEL_COUNT }, emptyChannel),
      voices: defaultVoices()
    })),
    capture: defaultCapture(),
    material: emptyMaterial()
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

const wholeIn = (value, low, high) => Number.isInteger(value) && value >= low && value <= high;

function readNote(raw, length, path) {
  if (!isObject(raw)) fail(`${path}: a note is an object`);
  if (!wholeIn(raw.pitch, 0, 127)) fail(`${path}.pitch: a pitch from 0 to 127`);
  if (!wholeIn(raw.velocity, 1, 127)) fail(`${path}.velocity: a velocity from 1 to 127`);
  if (!wholeIn(raw.channel, 1, 16)) fail(`${path}.channel: a channel from 1 to 16`);
  if (!wholeIn(raw.start, 0, length - 1)) fail(`${path}.start: a start from 0 to ${length - 1} ticks`);
  if (!wholeIn(raw.duration, 1, MAX_MATERIAL_TICKS)) fail(`${path}.duration: a duration from 1 to ${MAX_MATERIAL_TICKS} ticks`);
  return { pitch: raw.pitch, velocity: raw.velocity, channel: raw.channel, start: raw.start, duration: raw.duration };
}

/** Notes in the order the engine keeps them: start, pitch, channel; a stable sort. */
export function sortNotes(notes) {
  return notes
    .map((note, index) => ({ note, index }))
    .sort((a, b) => a.note.start - b.note.start || a.note.pitch - b.note.pitch
      || a.note.channel - b.note.channel || a.index - b.index)
    .map(({ note }) => note);
}

/** A note list, checked and ordered. Throws naming the first field it cannot read. */
export function readNoteList(raw, path = 'notes') {
  if (!isObject(raw)) fail(`${path}: a note list is an object`);
  if (!wholeIn(raw.length, 1, MAX_MATERIAL_TICKS)) fail(`${path}.length: a length from 1 tick to 64 bars`);
  if (!Array.isArray(raw.notes)) fail(`${path}.notes: a list of notes`);
  if (raw.notes.length > MATERIAL_CAPACITY) fail(`${path}.notes: at most ${MATERIAL_CAPACITY} notes`);
  return { length: raw.length, notes: sortNotes(raw.notes.map((note, i) => readNote(note, raw.length, `${path}.notes[${i}]`))) };
}

/** A node's material, checked; an absent one is empty. */
export function readMaterial(raw) {
  if (raw === undefined) return emptyMaterial();
  if (!isObject(raw)) fail('material: an object');
  if (!wholeIn(raw.generation, 0, 999999)) fail('material.generation: a whole number');
  if (typeof raw.frozen !== 'boolean') fail('material.frozen: true or false');
  return {
    origin: readNoteList(raw.origin, 'material.origin'),
    current: raw.current === null || raw.current === undefined ? null : readNoteList(raw.current, 'material.current'),
    generation: raw.generation,
    frozen: raw.frozen
  };
}

/** Is every rule of `voice` in its range, the lows under the highs? */
export function voiceValid(voice) {
  return isObject(voice)
    && Object.entries(VOICE_RULES).every(([rule, { min, max }]) => wholeIn(voice[rule], min, max))
    && voice.low <= voice.high && voice.velocityLow <= voice.velocityHigh && voice.shortest <= voice.longest;
}

function readVoices(raw, path) {
  if (raw === undefined) return defaultVoices();
  if (!Array.isArray(raw) || raw.length !== VOICE_COUNT) fail(`${path}: a scene has four voices`);
  return raw.map((item, v) => {
    if (!isObject(item)) fail(`${path}[${v}]: a voice is an object`);
    const voice = Object.fromEntries(Object.entries(VOICE_RULES).map(([rule, { min, max, neutral }]) => {
      const value = item[rule] ?? neutral;
      if (!wholeIn(value, min, max)) fail(`${path}[${v}].${rule}: a whole number from ${min} to ${max}`);
      return [rule, value];
    }));
    if (!voiceValid(voice)) fail(`${path}[${v}]: a lowest above its highest`);
    return voice;
  });
}

function readCapture(raw) {
  if (raw === undefined) return defaultCapture();
  if (!isObject(raw)) fail('capture: an object');
  const mode = raw.mode ?? CAPTURE_MODE.replace;
  const bars = raw.bars ?? 1;
  if (!Object.values(CAPTURE_MODE).includes(mode)) fail('capture.mode: replace or add');
  if (!wholeIn(bars, 0, MAX_CAPTURE_BARS)) fail(`capture.bars: 0 to ${MAX_CAPTURE_BARS} bars`);
  return { mode, bars };
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
      channels: scene.channels.map((channel, c) => readChannel(channel, `scenes[${s}].channels[${c}]`)),
      voices: readVoices(scene.voices, `scenes[${s}].voices`)
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
    scenes,
    capture: readCapture(raw.capture),
    material: readMaterial(raw.material)
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

/** One Ring's own targets: each channel's seven commands, the scene recall, and the material's commands. */
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
  // A Legato channel holds a capture open while its steps play.
  const memory = new Map(MEMORY_COMMANDS.map((id) => [id, {
    id, label: id, type: VALUE_TYPE.none,
    ...(id === 'CAPTURE_REPLACE' || id === 'CAPTURE_ADD' ? { releaseCommand: 'CAPTURE_END' } : {})
  }]));
  const whole = (id, minimum, maximum, extra = {}) => ({ id, label: id, type: VALUE_TYPE.integer, minimum, maximum, ...extra });
  const named = (id, names) => ({ id, label: id, type: VALUE_TYPE.choice, choices: names.map((label, i) => ({ id: i, label })) });
  const voiceCommands = () => new Map([
    whole('PLAY', -1, 63),
    // A Legato channel ties a note over the steps that repeat its value.
    whole('NOTE', 0, 255, { releaseCommand: 'NOTE_OFF' }),
    { id: 'NOTE_OFF', label: 'NOTE_OFF', type: VALUE_TYPE.none },
    whole('TRANSPOSE', -48, 48),
    whole('OCTAVE', -3, 3),
    named('ROOT', ROOT_NAMES),
    named('SCALE', SCALE_NAMES),
    whole('VELOCITY', 0, 200),
    whole('GATE', 5, 400),
    whole('DENSITY', 0, 100)
  ].map((command) => [command.id, command]));
  const voices = Array.from({ length: VOICE_COUNT }, (_, v) => ({
    id: `${VOICE_TARGET_PREFIX}${v + 1}`,
    label: `One Ring Voice ${v + 1}`,
    commands: voiceCommands()
  }));
  return [
    ...channels,
    { id: SCENES_TARGET, label: 'One Ring Scenes', commands: new Map([['RECALL', recall]]) },
    { id: MEMORY_TARGET, label: 'One Ring Memory', commands: memory },
    ...voices
  ];
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
    for (const voice of scene.voices ?? []) {
      if (!voiceValid(voice)) errors.add('Invalid voice rules');
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

/** STORE SCENE: one scene's sixteen channels and four voices copied into another; ids and names stay. */
export function storeScene(content, from, to) {
  if (!content.scenes[from] || !content.scenes[to]) throw new RangeError('no such scene');
  if (from === to) return content;
  const channels = clone(content.scenes[from].channels);
  const voices = clone(content.scenes[from].voices);
  return {
    ...content,
    scenes: content.scenes.map((scene, s) => (s === to ? { ...scene, channels, voices } : scene))
  };
}

/** One voice of a scene given whole rules, checked; the content unchanged when they do not fit. */
export function setVoice(content, scene, voice, rules) {
  const current = content.scenes[scene]?.voices?.[voice];
  if (!current || !voiceValid(rules)) return content;
  const next = Object.fromEntries(Object.keys(VOICE_RULES).map((rule) => [rule, rules[rule]]));
  if (JSON.stringify(next) === JSON.stringify(current)) return content;
  return {
    ...content,
    scenes: content.scenes.map((item, s) => (s !== scene ? item : {
      ...item,
      voices: item.voices.map((each, v) => (v === voice ? next : each))
    }))
  };
}

/** One rule of one voice of a scene, as the page turns it. */
export function setVoiceRule(content, scene, voice, rule, value) {
  const current = content.scenes[scene]?.voices?.[voice];
  if (!current || !Object.hasOwn(VOICE_RULES, rule)) return content;
  return setVoice(content, scene, voice, { ...current, [rule]: value });
}

// ---------- the material ----------

const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The notes the voices play: the current generation, or the origin. */
export function playingNotes(material) {
  return material.current ?? material.origin;
}

/** The capture's settings: `mode` (CAPTURE_MODE) and `bars` (0 until its end). */
export function setCaptureSettings(content, { mode = content.capture.mode, bars = content.capture.bars } = {}) {
  const next = readCapture({ mode, bars });
  return next.mode === content.capture.mode && next.bars === content.capture.bars ? content : { ...content, capture: next };
}

/** `list` as the new origin; the current generation goes, as after a capture. */
export function loadMaterial(content, list) {
  const origin = readNoteList(list, 'origin');
  const { material } = content;
  if (sameList(origin, material.origin) && material.current === null && material.generation === 0) return content;
  return { ...content, material: { ...material, origin, current: null, generation: 0 } };
}

/** Both lists emptied. Asked by a person, it applies to frozen material too. */
export function clearMaterial(content) {
  const { material } = content;
  const empty = emptyMaterial();
  if (sameList(material.origin, empty.origin) && material.current === null && material.generation === 0) return content;
  return { ...content, material: { ...empty, frozen: material.frozen } };
}

export function setFrozen(content, frozen) {
  return content.material.frozen === (frozen === true)
    ? content : { ...content, material: { ...content.material, frozen: frozen === true } };
}

/** The current generation dropped: the voices play the origin again. */
export function revertMaterial(content) {
  const { material } = content;
  if (material.current === null && material.generation === 0) return content;
  return { ...content, material: { ...material, current: null, generation: 0 } };
}

/**
 * A MIDI clip's notes as a material list: those sounding in the clip's window,
 * from its start, cut at its end -- what the clip plays. Throws when the clip
 * is longer than a material, or holds more notes than one keeps.
 */
export function noteListFromClip(clip) {
  const offset = Number(clip?.sourceOffsetPpq) || 0;
  const lengthPpq = Number(clip?.lengthPpq);
  if (!(lengthPpq > 0)) fail('the clip has no length');
  const length = Math.max(1, Math.round(lengthPpq * TICKS_PER_BEAT));
  if (length > MAX_MATERIAL_TICKS) fail('the clip is longer than a material (64 bars)');
  const end = offset + lengthPpq;
  const notes = [];
  for (const note of Array.isArray(clip?.notes) ? clip.notes : []) {
    const noteStart = Number(note.startPpq);
    const noteEnd = noteStart + Number(note.durationPpq);
    if (!(noteEnd > offset) || !(noteStart < end)) continue;
    const start = Math.round((Math.max(noteStart, offset) - offset) * TICKS_PER_BEAT);
    if (start >= length) continue;
    const stop = Math.round((Math.min(noteEnd, end) - offset) * TICKS_PER_BEAT);
    notes.push({
      pitch: Math.round(note.pitch),
      velocity: Math.round(note.velocity),
      channel: Math.round(note.channel),
      start,
      duration: Math.max(1, stop - start)
    });
  }
  if (notes.length > MATERIAL_CAPACITY) {
    fail(`the clip plays ${notes.length} notes; a material keeps at most ${MATERIAL_CAPACITY}`);
  }
  return readNoteList({ length, notes }, 'clip');
}
