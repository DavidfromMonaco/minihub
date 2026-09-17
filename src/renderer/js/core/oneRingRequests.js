import { VALUE_TYPE } from './commandRegistry.js';
import {
  CAPTURE_MODE, CHANNEL_COMMANDS, CHANNEL_COUNT, CONDITION, LENGTHS, MAX_CAPTURE_BARS, MAX_FEEDBACK_DELAY_BARS,
  MAX_FEEDBACK_LIMIT, MAX_MATERIAL_TICKS, MAX_STEPS, MAX_WRITER_BARS, MUTABLE, NOTE_ORDER, OFFSET_LIMIT, REPEATS,
  RESOLUTIONS, ROOT_NAMES, SCALE_NAMES, SCENE_POSITION, SCENE_TIMING, STEP_MODE, TICKS_PER_BEAT, VALUE_MODE,
  VOICE_COUNT, VOICE_RULES, WRITE_MODE, setVoice, voiceValid,
  cellsOf, clearCells, clearMaterial, defaultSource, defaultWriter, emptyCell, loadMaterial, mutateSequence,
  noteListFromClip, oneRingTargets, parseSeed, readNoteList, readSequence, reseed, retarget, revertMaterial,
  sequenceErrors, setCaptureSettings, setFrozen, setWriterSettings, storeScene,
  SCENE_BANKS, addScene, sceneIndex, scenePlace, storeSceneAt
} from './oneRingSequence.js';
import {
  HUMANIZE_PERCENT, SWING_PERCENT,
  addCondition, editCell, editChannel, selectScene, setChannelSetting, setProbability, setSceneTiming,
  setScenePosition, shownScene
} from './oneRingEdits.js';

/**
 * A One Ring node, programmed by requests in One Ring's own words.
 *
 * WHY THE VST'S VOCABULARY
 * ------------------------
 * One Ring took requests before it was a node (D-043): `describe`, `status`,
 * `targets`, `get`, `set`, `run`, `stop`, `channel`, `scene`, `copy-scene`,
 * `mutate` and `new-seed`. The node answers the same words in the same shapes,
 * so whatever programmed the VST programs the node. The answers are read from
 * the node's content and from what its runtime last reported, and every edit
 * goes through the functions the page uses (oneRingEdits.js,
 * oneRingSequence.js): a request can do nothing to a sequence the page could not.
 *
 * WHAT IS PLAYED AND WHAT IS WRITTEN
 * ----------------------------------
 * `run`, `stop`, `channel` and `scene` go to the runtime, as the page's keys
 * do; with no runtime, `scene` chooses the scene the file opens in, as
 * performance. `set`, `copy-scene`, `mutate` and `new-seed` write the content:
 * one undo step each (D-032). A `set` is built whole and checked whole before
 * anything is written, and a refusal names the field it failed on.
 *
 * THE MATERIAL (PART TWO)
 * -----------------------
 * `material` reads what the node plays notes from; `set-material` loads notes,
 * or a clip's; `clear`, `freeze`, `unfreeze` and `revert` edit it as the page
 * does, whatever the engine is doing. `capture` and `capture-end` go to the
 * runtime: a capture asked here waits for the next bar of what plays. Notes are
 * written in quarter notes, as a clip's are; the node keeps them in ticks.
 *
 * THE VOICES
 * ----------
 * `voices` reads a scene's four voices' rules, and what the running node plays
 * by now; `set-voice` edits one voice's rules as the page does. A channel plays
 * notes by aiming at `one-ring:voice:N`, through `set`, like any command.
 *
 * THE SCENES
 * ----------
 * A scene is named by its place, `A1` to `D8` (`A` alone being `A1`, as the
 * VST's scenes now read), by its index or by its name. It exists once it is
 * made: `new-scene`, or `copy-scene` into a free place. `scene` recalls one
 * that exists; the page makes one when an empty place is chosen.
 *
 * THE WRITER
 * ----------
 * `writer` reads where generations go and what became of them; `set-writer`
 * edits the writer's settings -- a clip it names must be a MIDI clip, a
 * destination a node that takes a track's notes. `write` and `feedback` go to
 * the runtime, as a step aimed at `one-ring:writer` does: `write` writes what
 * the voices played over the window, now.
 */

export const REQUEST_KINDS = Object.freeze([
  'describe', 'status', 'targets', 'get', 'set', 'run', 'stop', 'channel', 'scene', 'copy-scene', 'new-scene', 'mutate',
  'new-seed',
  'material', 'set-material', 'capture', 'capture-end', 'clear', 'freeze', 'unfreeze', 'revert',
  'voices', 'set-voice', 'writer', 'set-writer', 'write', 'feedback'
]);

const TYPE_NAMES = Object.freeze(['none', 'boolean', 'integer', 'number', 'choice']);
const FIELD_BITS = Object.freeze({ enabled: MUTABLE.enabled, probability: MUTABLE.probability, value: MUTABLE.value });
const TIMING_NAMES = Object.freeze({ [SCENE_TIMING.immediate]: 'immediate', [SCENE_TIMING.nextBar]: 'next-bar' });
const POSITION_NAMES = Object.freeze({ [SCENE_POSITION.restart]: 'restart', [SCENE_POSITION.keep]: 'keep' });
const CAPTURE_NAMES = Object.freeze({ [CAPTURE_MODE.replace]: 'replace', [CAPTURE_MODE.add]: 'add' });
const WRITE_NAMES = Object.freeze({
  [WRITE_MODE.newTrack]: 'new-track', [WRITE_MODE.replace]: 'replace', [WRITE_MODE.add]: 'add'
});
// What a Sequencer track's Destination may be (sequencerModule.js).
const MIDI_DESTINATION_TYPES = Object.freeze(['vst', 'arpeggiator', 'one-ring']);
const ORDER_NAMES = Object.freeze({
  [NOTE_ORDER.asPlayed]: 'as-played', [NOTE_ORDER.rising]: 'rising',
  [NOTE_ORDER.falling]: 'falling', [NOTE_ORDER.shuffled]: 'shuffled'
});
// A voice as a request writes it: names where the page shows names, durations in quarter notes.
const TICK_RULES = new Set(['shortest', 'longest']);
// Far beyond any loop a sequence reaches, and far inside the engine's 32 bits.
const MAX_INTERVAL = 9999;

/** How values are written, as `describe` tells it. */
const VALUES = Object.freeze({
  value: 'a number, true or false, or a choice as its label or its id -- what the command declares',
  random: '{"min": a, "max": b} for a number or a whole number; {"oneOf": [ ... ]} for any command',
  conditions: '"first", "last", {"every": n}, {"ifActive": channel}, {"ifInactive": channel}',
  scene: 'a place from "A1" to "D8" ("A" is "A1"), an index from 0, or a name such as "Scene A1"; a place has a '
    + 'scene once one is made there (new-scene, copy-scene)',
  notes: 'a note is {pitch 0-127, velocity 1-127, channel 1-16, startPpq, durationPpq}, in quarter notes from the '
    + 'material\'s start; a material lasts lengthPpq, at most 256 quarter notes, and keeps at most 256 notes',
  capture: '{"mode": "replace" or "add", "bars": 1-16, or 0 until capture-end}; a capture asked here starts at '
    + 'the next bar of what plays, or at once when nothing plays',
  voice: 'channel 0-16 (0 keeps each note\'s own), root "C".."B", scale by name, transpose -48..48, octave -3..3, '
    + 'octaveSpread 0-3, octaveChance 0-100, low/high 0-127, velocityScale 0-200, velocitySpread 0-127, '
    + 'velocityLow/velocityHigh 1-127, gateScale 5-400, gateSpread 0-100, shortestPpq/longestPpq 0.0625-64, '
    + 'order "as-played" "rising" "falling" "shuffled", density 0-100; a channel aimed at one-ring:voice:1-4 '
    + 'plays notes: PLAY -1..63 (a slot of the material, -1 its own), NOTE 0-255 (a note, in the voice\'s order)',
  writer: '{"mode": "new-track", "replace" or "add"; "clipId": the MIDI clip replace and add write into; '
    + '"destination": the node a new track plays, or ""; "bars": 1-16, the window a WRITE takes; "feedback": '
    + 'true or false; "feedbackMode": "replace" or "add"; "delayBars": 0-64 between two feedbacks; "limit": '
    + '1-999 feedbacks}; a channel aimed at one-ring:writer plays WRITE, FEEDBACK_ON and FEEDBACK_OFF',
  channel: 'channel 1-16, target, command, length 4/8/16/32/64, resolution "1/4" "1/8" "1/16" "1/32", '
    + 'repeats 1/2/3/4/8 or "loop", mode "trigger" or "legato", enabled, offset -64 to 64 steps, '
    + 'swing 0-95 and humanize 0-45 (percent), mutable ["enabled", "probability", "value"], '
    + 'follow [{target, command, value}], clearSteps, steps [{step 1-64, enabled, value, '
    + 'probability 0-100, conditions, locked, lockedFields}]'
});

class Refusal extends Error {}

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const failed = (reason, message) => (message ? { ok: false, reason, message } : { ok: false, reason });
const refuse = (path, message) => { throw new Refusal(path ? `${path}: ${message}` : message); };

// ---------- reading what a request names ----------

/** A place as a request writes it, `a3` or `A`, as the content writes it; or null. */
function placeOf(ref) {
  if (typeof ref !== 'string') return null;
  const text = ref.trim().toUpperCase();
  const place = SCENE_BANKS.includes(text) ? `${text}1` : text;
  return scenePlace(place) ? place : null;
}

function sceneAt(content, ref, path) {
  if (Number.isInteger(ref) && content.scenes[ref]) return ref;
  if (typeof ref === 'string') {
    const place = placeOf(ref);
    const text = ref.trim().toLowerCase();
    const found = place
      ? sceneIndex(content, place)
      : content.scenes.findIndex((scene) => scene.name.toLowerCase() === text);
    if (found >= 0) return found;
    if (place) refuse(path, `no scene at ${place} yet: new-scene makes one`);
  }
  return refuse(path, `no scene ${JSON.stringify(ref)}: ${VALUES.scene}`);
}

/** Every scene, in the deck's order. */
function scenesOut(content) {
  return content.scenes
    .map((scene, index) => ({ index, id: scene.id, name: scene.name, order: scenePlace(scene.id)?.order ?? index }))
    .sort((a, b) => a.order - b.order)
    .map(({ order: _order, ...scene }) => scene);
}

function channelAt(ref, path) {
  return Number.isInteger(ref) && ref >= 1 && ref <= CHANNEL_COUNT ? ref - 1 : refuse(path, 'a channel from 1 to 16');
}

function expected(descriptor) {
  switch (descriptor.type) {
    case VALUE_TYPE.boolean: return 'true or false';
    case VALUE_TYPE.integer: return `a whole number from ${descriptor.minimum} to ${descriptor.maximum}`;
    case VALUE_TYPE.number: return `a number from ${descriptor.minimum} to ${descriptor.maximum}`;
    case VALUE_TYPE.choice: return `one of ${(descriptor.choices || []).map((item) => JSON.stringify(item.label)).join(', ')}`;
    default: return 'no value';
  }
}

/** A value as a request writes it, typed for the command, or a refusal. */
function typedValue(descriptor, raw, path) {
  const { type } = descriptor;
  switch (type) {
    case VALUE_TYPE.none:
      if (raw === undefined || raw === null) return { type };
      break;
    case VALUE_TYPE.boolean:
      if (typeof raw === 'boolean') return { type, value: raw };
      break;
    case VALUE_TYPE.integer:
      if (Number.isInteger(raw) && raw >= descriptor.minimum && raw <= descriptor.maximum) return { type, value: raw };
      break;
    case VALUE_TYPE.number:
      if (Number.isFinite(raw) && raw >= descriptor.minimum && raw <= descriptor.maximum) return { type, value: raw };
      break;
    case VALUE_TYPE.choice: {
      const choices = descriptor.choices || [];
      const found = typeof raw === 'string'
        ? choices.find((item) => item.label === raw) ?? choices.find((item) => item.label.toLowerCase() === raw.toLowerCase())
        : choices.find((item) => item.id === raw);
      if (found) return { type, value: found.id };
      break;
    }
    default: break;
  }
  return refuse(path, `${descriptor.id} takes ${expected(descriptor)}`);
}

/** A fixed value, a range or a list, over what the cell held: the other modes' fields stay. */
function sourceFrom(descriptor, raw, path, current) {
  if (isObject(raw) && ('min' in raw || 'max' in raw)) {
    if (descriptor.type !== VALUE_TYPE.integer && descriptor.type !== VALUE_TYPE.number) {
      refuse(path, `${descriptor.id} takes no range`);
    }
    const min = typedValue(descriptor, raw.min, `${path}.min`);
    const max = typedValue(descriptor, raw.max, `${path}.max`);
    if (min.value > max.value) refuse(path, 'min is above max');
    return { ...current, mode: VALUE_MODE.range, min, max };
  }
  if (isObject(raw) && 'oneOf' in raw) {
    if (!Array.isArray(raw.oneOf) || !raw.oneOf.length) refuse(`${path}.oneOf`, 'a list of at least one value');
    return { ...current, mode: VALUE_MODE.choice, choices: raw.oneOf.map((item, i) => typedValue(descriptor, item, `${path}.oneOf[${i}]`)) };
  }
  return { ...current, mode: VALUE_MODE.fixed, fixed: typedValue(descriptor, raw, path) };
}

function conditionFrom(raw, path) {
  const plain = (kind) => ({ kind, interval: 2, channel: 0 });
  if (raw === 'always') return plain(CONDITION.always);
  if (raw === 'first') return plain(CONDITION.first);
  if (raw === 'last') return plain(CONDITION.last);
  if (isObject(raw)) {
    if ('every' in raw) {
      if (!Number.isInteger(raw.every) || raw.every < 1 || raw.every > MAX_INTERVAL) {
        refuse(`${path}.every`, `a whole number of loops from 1 to ${MAX_INTERVAL}`);
      }
      return { kind: CONDITION.everyNth, interval: raw.every, channel: 0 };
    }
    if ('ifActive' in raw) return { kind: CONDITION.ifActive, interval: 2, channel: channelAt(raw.ifActive, `${path}.ifActive`) };
    if ('ifInactive' in raw) {
      return { kind: CONDITION.ifInactive, interval: 2, channel: channelAt(raw.ifInactive, `${path}.ifInactive`) };
    }
  }
  return refuse(path, `a condition is ${VALUES.conditions}`);
}

function fieldsFrom(raw, path) {
  if (!Array.isArray(raw)) refuse(path, 'a list of "enabled", "probability" and "value"');
  let bits = 0;
  raw.forEach((name, i) => {
    if (!Object.hasOwn(FIELD_BITS, name)) refuse(`${path}[${i}]`, '"enabled", "probability" or "value"');
    bits |= FIELD_BITS[name];
  });
  return bits >>> 0;
}

function captureFrom(raw, content, path) {
  if (!isObject(raw)) refuse(path, VALUES.capture);
  const mode = raw.mode === undefined ? content.capture.mode
    : Object.keys(CAPTURE_NAMES).map(Number).find((key) => CAPTURE_NAMES[key] === raw.mode);
  if (mode === undefined) refuse(`${path}.mode`, '"replace" or "add"');
  const bars = raw.bars === undefined ? content.capture.bars : raw.bars;
  if (!Number.isInteger(bars) || bars < 0 || bars > MAX_CAPTURE_BARS) refuse(`${path}.bars`, `0 to ${MAX_CAPTURE_BARS} bars`);
  return { mode, bars };
}

function nameIn(names, value, path) {
  const found = Object.keys(names).map(Number).find((key) => names[key] === value);
  return found === undefined ? refuse(path, Object.values(names).map((name) => JSON.stringify(name)).join(', ')) : found;
}

function wholeIn(value, min, max, path, unit) {
  return Number.isInteger(value) && value >= min && value <= max ? value : refuse(path, `${min} to ${max} ${unit}`);
}

function writerFrom(hub, raw, current, path) {
  if (!isObject(raw)) refuse(path, VALUES.writer);
  const next = { ...current };
  for (const [key, value] of Object.entries(raw)) {
    const at = `${path}.${key}`;
    switch (key) {
      case 'kind':
        break;
      case 'mode':
        next.mode = nameIn(WRITE_NAMES, value, at);
        break;
      case 'feedbackMode':
        next.feedbackMode = nameIn(CAPTURE_NAMES, value, at);
        break;
      case 'clipId': {
        if (typeof value !== 'string') refuse(at, 'a clip id, or ""');
        if (value) {
          const found = hub.sequencer?.model?._clip?.(value);
          if (!found) refuse(at, `no clip ${JSON.stringify(value)}`);
          if (found.track?.type !== 'midi') refuse(at, 'not a MIDI clip');
        }
        next.clipId = value;
        break;
      }
      case 'destination': {
        if (typeof value !== 'string') refuse(at, 'a node id, or ""');
        if (value && !MIDI_DESTINATION_TYPES.includes(hub.nodes?.get?.(value)?.type)) {
          refuse(at, `no node ${JSON.stringify(value)} a track can play: a VST, an arpeggiator or a One Ring`);
        }
        next.destination = value;
        break;
      }
      case 'bars':
        next.bars = wholeIn(value, 1, MAX_WRITER_BARS, at, 'bars');
        break;
      case 'delayBars':
        next.delayBars = wholeIn(value, 0, MAX_FEEDBACK_DELAY_BARS, at, 'bars');
        break;
      case 'limit':
        next.limit = wholeIn(value, 1, MAX_FEEDBACK_LIMIT, at, 'feedbacks');
        break;
      case 'feedback':
        if (typeof value !== 'boolean') refuse(at, 'true or false');
        next.feedback = value;
        break;
      default:
        refuse(at, `not a writer setting: ${VALUES.writer}`);
    }
  }
  return next;
}

const ticksOf = (ppq) => Math.round(ppq * TICKS_PER_BEAT);

function noteListFrom(raw, path) {
  if (!isObject(raw)) refuse(path, 'an object');
  const { lengthPpq } = raw;
  if (!Number.isFinite(lengthPpq) || lengthPpq <= 0 || ticksOf(lengthPpq) > MAX_MATERIAL_TICKS) {
    refuse(`${path}.lengthPpq`, 'a length from a tick to 256 quarter notes');
  }
  if (!Array.isArray(raw.notes)) refuse(`${path}.notes`, 'a list of notes');
  const notes = raw.notes.map((note, i) => {
    const at = `${path}.notes[${i}]`;
    if (!isObject(note)) refuse(at, VALUES.notes);
    if (!Number.isFinite(note.startPpq) || !Number.isFinite(note.durationPpq)) refuse(at, VALUES.notes);
    return {
      pitch: note.pitch,
      velocity: note.velocity ?? 100,
      channel: note.channel ?? 1,
      start: ticksOf(note.startPpq),
      duration: ticksOf(note.durationPpq)
    };
  });
  return readNoteList({ length: ticksOf(lengthPpq), notes }, path);
}

const listOut = (list) => ({
  lengthPpq: list.length / TICKS_PER_BEAT,
  notes: list.notes.map((note) => ({
    pitch: note.pitch,
    velocity: note.velocity,
    channel: note.channel,
    startPpq: note.start / TICKS_PER_BEAT,
    durationPpq: note.duration / TICKS_PER_BEAT
  }))
});

const percentIn = (raw, high, path) => (Number.isFinite(raw) && raw >= 0 && raw <= high
  ? raw : refuse(path, `a percentage from 0 to ${high}`));

function resolutionFrom(raw, path) {
  const denominator = typeof raw === 'string' && /^1\/\d+$/.test(raw.trim()) ? Number(raw.trim().slice(2)) : raw;
  return RESOLUTIONS.includes(denominator) ? denominator : refuse(path, 'a resolution of "1/4", "1/8", "1/16" or "1/32"');
}

// ---------- writing what the node holds ----------

function valueOut(value, descriptor) {
  switch (value?.type) {
    case VALUE_TYPE.boolean:
    case VALUE_TYPE.integer:
    case VALUE_TYPE.number:
      return value.value;
    case VALUE_TYPE.choice:
      return descriptor?.choices?.find((item) => item.id === value.value)?.label ?? value.value;
    default: return null;
  }
}

function sourceOut(source, descriptor) {
  if (source.mode === VALUE_MODE.range) return { min: valueOut(source.min, descriptor), max: valueOut(source.max, descriptor) };
  if (source.mode === VALUE_MODE.choice) return { oneOf: source.choices.map((value) => valueOut(value, descriptor)) };
  return valueOut(source.fixed, descriptor);
}

function conditionOut(condition) {
  switch (condition.kind) {
    case CONDITION.everyNth: return { every: condition.interval };
    case CONDITION.first: return 'first';
    case CONDITION.last: return 'last';
    case CONDITION.ifActive: return { ifActive: condition.channel + 1 };
    case CONDITION.ifInactive: return { ifInactive: condition.channel + 1 };
    default: return 'always';
  }
}

const fieldsOut = (bits) => Object.keys(FIELD_BITS).filter((name) => bits & FIELD_BITS[name]);

function stepOut(cell, index, descriptor) {
  const out = { step: index + 1, enabled: cell.enabled };
  const value = sourceOut(cell.value, descriptor);
  if (value !== null) out.value = value;
  if (cell.probability !== 100) out.probability = cell.probability;
  if (cell.conditions.length) out.conditions = cell.conditions.map(conditionOut);
  if (cell.locked) out.locked = true;
  if (cell.lockedFields) out.lockedFields = fieldsOut(cell.lockedFields);
  return out;
}

function actionOut(action, find) {
  const value = sourceOut(action.value, find(action.target, action.command));
  return { target: action.target, command: action.command, ...(value !== null ? { value } : {}) };
}

/** A channel in the shape `set` takes, its steps limited to those programmed. */
function channelOut(channel, index, find) {
  const descriptor = find(channel.target.target, channel.target.command);
  // A cell is programmed when it is neither an empty one nor what choosing the
  // command gives every cell.
  const plain = new Set([JSON.stringify(emptyCell()), JSON.stringify({ ...emptyCell(), value: defaultSource(descriptor) })]);
  const out = {
    channel: index + 1,
    target: channel.target.target,
    command: channel.target.command,
    length: channel.length,
    resolution: `${channel.numerator}/${channel.denominator}`,
    repeats: channel.repeats === 0 ? 'loop' : channel.repeats,
    mode: channel.mode === STEP_MODE.legato ? 'legato' : 'trigger',
    enabled: channel.enabled,
    offset: channel.offset,
    swing: Math.round(channel.swing * 100),
    humanize: Math.round(channel.humanize * 100),
    mutable: fieldsOut(channel.mutableFields),
    steps: cellsOf(channel)
      .map((cell, i) => (plain.has(JSON.stringify(cell)) ? null : stepOut(cell, i, descriptor)))
      .filter(Boolean),
    follow: channel.follow.map((action) => actionOut(action, find))
  };
  // Authored for a target the CTRL OUT no longer reaches: kept, and said.
  if (channel.target.command && !descriptor) out.reachable = false;
  return out;
}

const sceneOut = (content, index) => (index >= 0 && content.scenes[index]
  ? { index, id: content.scenes[index].id, name: content.scenes[index].name }
  : null);

function commandOut(descriptor) {
  const out = { id: descriptor.id, label: descriptor.label, type: TYPE_NAMES[descriptor.type] ?? 'none' };
  if (descriptor.type === VALUE_TYPE.integer || descriptor.type === VALUE_TYPE.number) {
    out.min = descriptor.minimum;
    out.max = descriptor.maximum;
  }
  if (descriptor.type === VALUE_TYPE.choice) out.choices = (descriptor.choices || []).map(({ id, label }) => ({ id, label }));
  if (descriptor.releaseCommand) out.release = descriptor.releaseCommand;
  return out;
}

// ---------- the node ----------

function contextOf(hub, nodeId) {
  const node = hub.nodes.get(nodeId);
  const content = node.content;
  const external = hub.commands?.targetsFrom?.(nodeId) ?? [];
  const targets = [...oneRingTargets(content), ...external];
  const byId = new Map(targets.map((target) => [target.id, target]));
  const find = (target, command) => (command ? byId.get(target)?.commands?.get(command) ?? null : null);
  const status = hub.oneRing?.statusOf?.(nodeId) ?? null;
  return { node, content, targets, byId, find, status, scene: shownScene(content, status) };
}

function materialAnswer(content, status) {
  const { capture, material } = content;
  return {
    ok: true,
    capture: {
      mode: CAPTURE_NAMES[capture.mode],
      bars: capture.bars,
      state: status?.capture ?? 'off',
      taken: status?.captured ?? 0
    },
    origin: listOut(material.origin),
    current: material.current ? listOut(material.current) : null,
    generation: material.generation,
    frozen: material.frozen,
    refused: status?.captureRefused ?? 0
  };
}

function writerAnswer(hub, nodeId, content, status) {
  const writer = content.writer ?? defaultWriter();
  const session = hub.oneRing?.writesOf?.(nodeId) ?? { written: 0, refused: 0, lastRefusal: '', last: null };
  return {
    ok: true,
    writer: {
      mode: WRITE_NAMES[writer.mode],
      clipId: writer.clipId,
      destination: writer.destination,
      bars: writer.bars,
      feedback: writer.feedback,
      feedbackMode: CAPTURE_NAMES[writer.feedbackMode],
      delayBars: writer.delayBars,
      limit: writer.limit,
      written: writer.written
    },
    // What the running node did: generations sent, those lost on the way or
    // made of nothing, and feedback as it stands now.
    engine: {
      writes: status?.writes ?? 0,
      dropped: status?.writesDropped ?? 0,
      empty: status?.writesEmpty ?? 0,
      feedback: status?.feedback ?? false,
      feedbackStopped: status?.feedbackStopped ?? false
    },
    // What this session wrote into the Sequencer, and what it could not.
    written: session.written,
    refused: session.refused,
    lastRefusal: session.lastRefusal,
    last: session.last
  };
}

function voiceOut(voice) {
  const out = {};
  for (const rule of Object.keys(VOICE_RULES)) {
    if (rule === 'root') out.root = ROOT_NAMES[voice.root];
    else if (rule === 'scale') out.scale = SCALE_NAMES[voice.scale];
    else if (rule === 'order') out.order = ORDER_NAMES[voice.order];
    else if (TICK_RULES.has(rule)) out[`${rule}Ppq`] = voice[rule] / TICKS_PER_BEAT;
    else out[rule] = voice[rule];
  }
  return out;
}

function voiceFrom(raw, current, path) {
  if (!isObject(raw)) refuse(path, VALUES.voice);
  const next = { ...current };
  const named = (key, names) => {
    const index = typeof raw[key] === 'string'
      ? names.findIndex((name) => name.toLowerCase() === raw[key].toLowerCase()) : raw[key];
    if (!Number.isInteger(index) || index < 0 || index >= names.length) {
      refuse(`${path}.${key}`, `one of ${names.map((name) => JSON.stringify(name)).join(', ')}`);
    }
    return index;
  };
  for (const key of Object.keys(raw)) {
    if (key === 'voice' || key === 'scene' || key === 'kind') continue;
    if (key === 'root') next.root = named('root', ROOT_NAMES);
    else if (key === 'scale') next.scale = named('scale', SCALE_NAMES);
    else if (key === 'order') next.order = named('order', Object.values(ORDER_NAMES));
    else if (key === 'shortestPpq' || key === 'longestPpq') {
      const rule = key.slice(0, -3);
      if (!Number.isFinite(raw[key])) refuse(`${path}.${key}`, 'a duration in quarter notes');
      next[rule] = Math.round(raw[key] * TICKS_PER_BEAT);
      const { min, max } = VOICE_RULES[rule];
      if (next[rule] < min || next[rule] > max) refuse(`${path}.${key}`, `from ${min / TICKS_PER_BEAT} to ${max / TICKS_PER_BEAT}`);
    } else if (Object.hasOwn(VOICE_RULES, key) && !TICK_RULES.has(key)) {
      const { min, max } = VOICE_RULES[key];
      if (!Number.isInteger(raw[key]) || raw[key] < min || raw[key] > max) {
        refuse(`${path}.${key}`, `a whole number from ${min} to ${max}`);
      }
      next[key] = raw[key];
    } else {
      refuse(`${path}.${key}`, `not a voice rule: ${VALUES.voice}`);
    }
  }
  if (!voiceValid(next)) refuse(path, 'a lowest above its highest');
  return next;
}

function statusAnswer(hub, nodeId, context) {
  const { content, status } = context;
  const ready = Number.isSafeInteger(hub.oneRing?.generationOf?.(nodeId));
  const writing = writerAnswer(hub, nodeId, content, status);
  return {
    ok: true,
    ready,
    running: status?.playing === true,
    bpm: status?.bpm ?? 0,
    beat: status?.beat ?? 0,
    scene: sceneOut(content, context.scene),
    pendingScene: sceneOut(content, status?.pendingScene ?? -1),
    channels: Array.from({ length: CHANNEL_COUNT }, (_, i) => ({
      channel: i + 1,
      active: status?.active?.[i] === true,
      step: Number.isInteger(status?.playheads?.[i]) && status.playheads[i] >= 0 ? status.playheads[i] + 1 : null
    })),
    refused: status?.rejected ?? 0,
    guarded: status?.guarded ?? 0,
    lastRefusal: hub.oneRing?.refusalOf?.(nodeId) ?? '',
    capture: status?.capture ?? 'off',
    material: {
      originNotes: content.material.origin.notes.length,
      currentNotes: content.material.current ? content.material.current.notes.length : null,
      generation: content.material.generation,
      frozen: content.material.frozen
    },
    writer: {
      mode: writing.writer.mode,
      feedback: writing.engine.feedback,
      feedbackStopped: writing.engine.feedbackStopped,
      writes: writing.engine.writes,
      written: writing.written,
      refused: writing.refused,
      lastRefusal: writing.lastRefusal
    }
  };
}

function targetsAnswer(context, only) {
  const listed = only === undefined ? context.targets : context.targets.filter((target) => target.id === only);
  return {
    ok: true,
    targets: listed.map((target) => ({
      id: target.id,
      label: target.label,
      commands: [...target.commands.values()].map(commandOut)
    }))
  };
}

function applyStep(cell, raw, descriptor, path) {
  if (!isObject(raw)) refuse(path, 'a step is an object');
  let next = cell;
  if ('enabled' in raw) {
    if (typeof raw.enabled !== 'boolean') refuse(`${path}.enabled`, 'true or false');
    next = { ...next, enabled: raw.enabled };
  }
  if ('probability' in raw) next = setProbability(next, percentIn(raw.probability, 100, `${path}.probability`));
  if ('value' in raw) {
    if (!descriptor) refuse(`${path}.value`, 'the channel has no command reachable from CTRL OUT to take a value');
    next = { ...next, value: sourceFrom(descriptor, raw.value, `${path}.value`, next.value) };
  }
  if ('conditions' in raw) {
    if (!Array.isArray(raw.conditions)) refuse(`${path}.conditions`, 'a list of conditions');
    next = raw.conditions.reduce((current, item, i) => addCondition(current, conditionFrom(item, `${path}.conditions[${i}]`)),
      { ...next, conditions: [] });
  }
  if ('locked' in raw) {
    if (typeof raw.locked !== 'boolean') refuse(`${path}.locked`, 'true or false');
    next = { ...next, locked: raw.locked };
  }
  if ('lockedFields' in raw) next = { ...next, lockedFields: fieldsFrom(raw.lockedFields, `${path}.lockedFields`) };
  return next;
}

function applyChannel(content, scene, raw, path, context) {
  if (!isObject(raw)) refuse(path, 'a channel is an object');
  const index = channelAt(raw.channel, `${path}.channel`);
  const { find, byId } = context;
  let next = content;
  const current = () => next.scenes[scene].channels[index];
  if ('target' in raw || 'command' in raw) {
    const before = current().target;
    const target = 'target' in raw ? String(raw.target ?? '') : before.target;
    // A target's commands are its own: another target starts with none.
    const command = 'command' in raw ? String(raw.command ?? '') : (target === before.target ? before.command : '');
    if (target !== before.target || command !== before.command) {
      if (target && !byId.has(target)) {
        refuse(`${path}.target`, `${target} is not reachable: cable One Ring's CTRL OUT to it, then read targets again`);
      }
      const descriptor = find(target, command);
      if (command && !descriptor) refuse(`${path}.command`, `${target || 'no target'} has no command ${command}`);
      next = editChannel(next, scene, index, (channel) => retarget(channel, target, command, descriptor));
    }
  }
  const descriptor = find(current().target.target, current().target.command);
  const setting = (name, value) => { next = setChannelSetting(next, scene, index, name, value, { descriptor }); };
  if ('length' in raw) {
    if (!LENGTHS.includes(raw.length)) refuse(`${path}.length`, 'a length of 4, 8, 16, 32 or 64');
    setting('length', raw.length);
  }
  if ('resolution' in raw) setting('rate', resolutionFrom(raw.resolution, `${path}.resolution`));
  if ('repeats' in raw) {
    const repeats = raw.repeats === 'loop' ? 0 : raw.repeats;
    if (!REPEATS.includes(repeats)) refuse(`${path}.repeats`, '1, 2, 3, 4, 8 or "loop"');
    setting('repeats', repeats);
  }
  if ('mode' in raw) {
    if (raw.mode !== 'trigger' && raw.mode !== 'legato') refuse(`${path}.mode`, '"trigger" or "legato"');
    if (raw.mode === 'legato' && !descriptor?.releaseCommand) {
      refuse(`${path}.mode`, `${current().target.command || 'the channel'} declares no release, which legato needs`);
    }
    setting('mode', raw.mode === 'legato' ? STEP_MODE.legato : STEP_MODE.trigger);
  }
  if ('enabled' in raw) {
    if (typeof raw.enabled !== 'boolean') refuse(`${path}.enabled`, 'true or false');
    setting('enabled', raw.enabled);
  }
  if ('offset' in raw) {
    if (!Number.isInteger(raw.offset) || Math.abs(raw.offset) > OFFSET_LIMIT) {
      refuse(`${path}.offset`, `a whole number of steps from -${OFFSET_LIMIT} to ${OFFSET_LIMIT}`);
    }
    setting('offset', raw.offset);
  }
  if ('swing' in raw) setting('swing', percentIn(raw.swing, SWING_PERCENT, `${path}.swing`));
  if ('humanize' in raw) setting('humanize', percentIn(raw.humanize, HUMANIZE_PERCENT, `${path}.humanize`));
  if ('mutable' in raw) {
    const bits = fieldsFrom(raw.mutable, `${path}.mutable`);
    next = editChannel(next, scene, index, (channel) => (channel.mutableFields === bits ? channel : { ...channel, mutableFields: bits }));
  }
  if ('follow' in raw) {
    if (!Array.isArray(raw.follow)) refuse(`${path}.follow`, 'a list of actions');
    const follow = raw.follow.map((item, i) => {
      const at = `${path}.follow[${i}]`;
      if (!isObject(item)) refuse(at, 'an action is {target, command, value}');
      const action = find(String(item.target ?? ''), String(item.command ?? ''));
      if (!action) refuse(at, `${item.target} ${item.command} is not a command One Ring reaches`);
      const value = sourceFrom(action, action.type === VALUE_TYPE.none ? null : item.value, `${at}.value`,
        defaultSource(action));
      return { target: String(item.target), command: String(item.command), value };
    });
    next = editChannel(next, scene, index, (channel) => ({ ...channel, follow }));
  }
  if (raw.clearSteps === true) next = editChannel(next, scene, index, (channel) => clearCells(channel, descriptor));
  if ('steps' in raw) {
    if (!Array.isArray(raw.steps)) refuse(`${path}.steps`, 'a list of steps');
    raw.steps.forEach((item, i) => {
      const at = `${path}.steps[${i}]`;
      const step = item?.step;
      if (!Number.isInteger(step) || step < 1 || step > MAX_STEPS) refuse(`${at}.step`, 'a step from 1 to 64');
      next = editCell(next, scene, index, step - 1, (cell) => applyStep(cell, item, descriptor, at));
    });
  }
  return { next, index };
}

/** The content, written as an edit when it changed; a refusal when it would not read back. */
function write(hub, nodeId, context, next) {
  if (next === context.content) return false;
  const errors = sequenceErrors(next, context.find);
  if (errors.length) refuse('', errors.join('; '));
  try {
    readSequence(next);
  } catch (error) {
    refuse('', String(error?.message || error));
  }
  return hub.nodes.setContent(nodeId, next);
}

function playResult(result) {
  return Promise.resolve(result).then((answer) => (answer?.ok === false
    ? failed(answer.reason === 'invalid-command' ? 'invalid-request' : answer.reason || 'refused', answer.message)
    : { ok: true }));
}

/**
 * Answer one request to the One Ring node `nodeId`. Throws nothing: a refusal
 * is an answer, `{ ok: false, reason, message }`.
 */
export async function handleOneRingRequest(hub, nodeId, body) {
  if (hub.nodes?.get?.(nodeId)?.type !== 'one-ring') return failed('node-not-found');
  if (!isObject(body)) return failed('invalid-request', 'a request is an object, such as {"kind": "describe"}');
  const kind = typeof body.kind === 'string' ? body.kind : '';
  if (!REQUEST_KINDS.includes(kind)) return failed('unknown-request', `kinds: ${REQUEST_KINDS.join(', ')}`);
  const context = contextOf(hub, nodeId);
  const { content } = context;
  try {
    switch (kind) {
      case 'describe':
        return {
          ok: true,
          node: { id: nodeId, name: context.node.name },
          kinds: [...REQUEST_KINDS],
          values: VALUES,
          scenes: scenesOut(content),
          status: statusAnswer(hub, nodeId, context),
          targets: targetsAnswer(context).targets
        };
      case 'status':
        return statusAnswer(hub, nodeId, context);
      case 'targets':
        return targetsAnswer(context, body.target === undefined ? undefined : String(body.target));
      case 'get': {
        const scene = body.scene === undefined ? context.scene : sceneAt(content, body.scene, 'scene');
        const channels = content.scenes[scene].channels.map((channel, i) => channelOut(channel, i, context.find));
        return {
          ok: true,
          seed: content.seed,
          mutation: content.mutation,
          sceneTiming: TIMING_NAMES[content.sceneTiming],
          scenePosition: POSITION_NAMES[content.scenePosition],
          selectedScene: content.selectedScene,
          scenes: scenesOut(content),
          scene: sceneOut(content, scene),
          channels: body.channel === undefined ? channels : [channels[channelAt(body.channel, 'channel')]]
        };
      }
      case 'set': {
        const scene = body.scene === undefined ? context.scene : sceneAt(content, body.scene, 'scene');
        let next = content;
        if ('seed' in body) {
          const seed = parseSeed(body.seed);
          if (seed === null) refuse('seed', 'a whole number below 18446744073709551616');
          if (seed !== next.seed) next = reseed(next, seed);
        }
        if ('sceneTiming' in body) {
          const timing = Object.keys(TIMING_NAMES).find((key) => TIMING_NAMES[key] === body.sceneTiming);
          if (timing === undefined) refuse('sceneTiming', '"immediate" or "next-bar"');
          next = setSceneTiming(next, Number(timing));
        }
        if ('scenePosition' in body) {
          const position = Object.keys(POSITION_NAMES).find((key) => POSITION_NAMES[key] === body.scenePosition);
          if (position === undefined) refuse('scenePosition', '"restart" or "keep"');
          next = setScenePosition(next, Number(position));
        }
        if ('capture' in body) next = setCaptureSettings(next, captureFrom(body.capture, next, 'capture'));
        if ('writer' in body) next = setWriterSettings(next, writerFrom(hub, body.writer, next.writer ?? defaultWriter(), 'writer'));
        const changed = [];
        if ('channels' in body) {
          if (!Array.isArray(body.channels)) refuse('channels', 'a list of channels');
          body.channels.forEach((raw, i) => {
            const result = applyChannel(next, scene, raw, `channels[${i}]`, context);
            next = result.next;
            if (!changed.includes(result.index)) changed.push(result.index);
          });
        }
        const written = write(hub, nodeId, context, next);
        const after = hub.nodes.get(nodeId).content;
        return {
          ok: true,
          changed: written,
          scene: sceneOut(after, scene),
          channels: changed.map((index) => channelOut(after.scenes[scene].channels[index], index, context.find))
        };
      }
      case 'run':
      case 'stop':
        return await playResult(hub.oneRing.command(nodeId, kind));
      case 'channel': {
        const index = channelAt(body.channel, 'channel');
        const name = String(body.command ?? '');
        if (!CHANNEL_COMMANDS.includes(name)) refuse('command', CHANNEL_COMMANDS.join(', '));
        return await playResult(hub.oneRing.command(nodeId, 'channel', { channel: index + 1, name }));
      }
      case 'scene': {
        const scene = sceneAt(content, body.scene, 'scene');
        if (Number.isSafeInteger(hub.oneRing?.generationOf?.(nodeId))) {
          return await playResult(hub.oneRing.command(nodeId, 'scene', { scene }));
        }
        // Nothing plays it: the scene the file opens in, as the page chooses it.
        const next = selectScene(content, scene);
        if (next !== content) {
          const put = () => hub.nodes.setContent(nodeId, next);
          if (typeof hub.perform === 'function') hub.perform(put);
          else put();
        }
        return { ok: true, scene: sceneOut(content, scene) };
      }
      case 'copy-scene': {
        const from = sceneAt(content, body.from, 'from');
        const place = placeOf(body.to);
        const next = place
          ? storeSceneAt(content, from, place)
          : storeScene(content, from, sceneAt(content, body.to, 'to'));
        const changed = write(hub, nodeId, context, next);
        const after = hub.nodes.get(nodeId).content;
        const to = place ? sceneIndex(after, place) : sceneAt(after, body.to, 'to');
        return { ok: true, changed, scene: sceneOut(after, to) };
      }
      case 'new-scene': {
        const place = placeOf(body.scene);
        if (!place) refuse('scene', 'a place from "A1" to "D8"');
        if (sceneIndex(content, place) >= 0) refuse('scene', `${place} already has a scene: copy-scene writes over it`);
        const next = body.from === undefined
          ? addScene(content, place)
          : storeSceneAt(content, sceneAt(content, body.from, 'from'), place);
        write(hub, nodeId, context, next);
        const after = hub.nodes.get(nodeId).content;
        return { ok: true, changed: true, scene: sceneOut(after, sceneIndex(after, place)) };
      }
      case 'mutate': {
        const scene = body.scene === undefined ? context.scene : sceneAt(content, body.scene, 'scene');
        const channel = body.channel === undefined ? undefined : channelAt(body.channel, 'channel');
        const next = mutateSequence(content, { scene, channel });
        write(hub, nodeId, context, next);
        const after = hub.nodes.get(nodeId).content;
        const indices = channel === undefined ? [...Array(CHANNEL_COUNT).keys()] : [channel];
        return {
          ok: true,
          mutation: after.mutation,
          scene: sceneOut(after, scene),
          channels: indices.map((index) => channelOut(after.scenes[scene].channels[index], index, context.find))
        };
      }
      case 'material':
        return materialAnswer(content, context.status);
      case 'set-material': {
        let list;
        if ('clipId' in body) {
          const found = hub.sequencer?.model?._clip?.(String(body.clipId));
          if (!found) refuse('clipId', `no clip ${JSON.stringify(body.clipId)}`);
          if (found.track?.type !== 'midi') refuse('clipId', 'not a MIDI clip');
          try {
            list = noteListFromClip(found.clip);
          } catch (error) {
            refuse('clipId', String(error?.message || error));
          }
        } else {
          list = noteListFrom(body, 'material');
        }
        write(hub, nodeId, context, loadMaterial(content, list));
        return materialAnswer(hub.nodes.get(nodeId).content, context.status);
      }
      case 'capture': {
        if ('mode' in body || 'bars' in body) {
          write(hub, nodeId, context, setCaptureSettings(content, captureFrom(body, content, 'capture')));
        }
        const { capture } = hub.nodes.get(nodeId).content;
        const name = capture.mode === CAPTURE_MODE.add ? 'CAPTURE_ADD' : 'CAPTURE_REPLACE';
        const played = await playResult(hub.oneRing.memory(nodeId, name));
        return played.ok ? { ok: true, capture: { mode: CAPTURE_NAMES[capture.mode], bars: capture.bars } } : played;
      }
      case 'capture-end':
        return await playResult(hub.oneRing.memory(nodeId, 'CAPTURE_END'));
      case 'clear':
      case 'freeze':
      case 'unfreeze':
      case 'revert': {
        const edit = { clear: clearMaterial, revert: revertMaterial,
          freeze: (held) => setFrozen(held, true), unfreeze: (held) => setFrozen(held, false) }[kind];
        write(hub, nodeId, context, edit(content));
        return materialAnswer(hub.nodes.get(nodeId).content, context.status);
      }
      case 'voices': {
        const scene = body.scene === undefined ? context.scene : sceneAt(content, body.scene, 'scene');
        const live = context.status?.voices ?? null;
        return {
          ok: true,
          scene: sceneOut(content, scene),
          voices: content.scenes[scene].voices.map(voiceOut),
          playing: live && scene === context.scene ? live.map(voiceOut) : null,
          sounding: context.status?.sounding ?? Array(VOICE_COUNT).fill(0),
          refused: context.status?.notesRefused ?? 0
        };
      }
      case 'set-voice': {
        const scene = body.scene === undefined ? context.scene : sceneAt(content, body.scene, 'scene');
        const index = Number.isInteger(body.voice) && body.voice >= 1 && body.voice <= VOICE_COUNT
          ? body.voice - 1 : refuse('voice', `a voice from 1 to ${VOICE_COUNT}`);
        const next = voiceFrom(body, content.scenes[scene].voices[index], 'voice');
        const written = write(hub, nodeId, context, setVoice(content, scene, index, next));
        return {
          ok: true,
          changed: written,
          scene: sceneOut(content, scene),
          voice: voiceOut(hub.nodes.get(nodeId).content.scenes[scene].voices[index])
        };
      }
      case 'writer':
        return writerAnswer(hub, nodeId, content, context.status);
      case 'set-writer': {
        const next = writerFrom(hub, body, content.writer ?? defaultWriter(), 'writer');
        const written = write(hub, nodeId, context, setWriterSettings(content, next));
        return { ...writerAnswer(hub, nodeId, hub.nodes.get(nodeId).content, context.status), changed: written };
      }
      case 'write':
        return await playResult(hub.oneRing.writer(nodeId, 'WRITE'));
      case 'feedback': {
        if (typeof body.on !== 'boolean') refuse('on', 'true to turn feedback on, false to turn it off');
        return await playResult(hub.oneRing.writer(nodeId, body.on ? 'FEEDBACK_ON' : 'FEEDBACK_OFF'));
      }
      case 'new-seed': {
        let seed;
        if (body.seed !== undefined) {
          seed = parseSeed(body.seed);
          if (seed === null) refuse('seed', 'a whole number below 18446744073709551616');
        }
        write(hub, nodeId, context, reseed(content, seed));
        return { ok: true, seed: hub.nodes.get(nodeId).content.seed };
      }
      default:
        return failed('unknown-request');
    }
  } catch (error) {
    if (error instanceof Refusal) return failed('refused', error.message);
    return failed('refused', String(error?.message || error));
  }
}
