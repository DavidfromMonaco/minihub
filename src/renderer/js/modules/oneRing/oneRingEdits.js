import { VALUE_TYPE } from '../../core/commandRegistry.js';
import {
  CHANNEL_COUNT, CONDITION, HUMANIZE_MAX, LENGTHS, MAX_STEPS, MUTABLE, OFFSET_LIMIT, REPEATS, RESOLUTIONS,
  SCENE_POSITION, SCENE_TIMING, STEP_MODE, SWING_MAX, VALUE_MODE,
  cellAt, emptySource, emptyValue, retarget, setCell
} from '../../core/oneRingSequence.js';

/**
 * What the One Ring page does to a sequence.
 *
 * Each function takes a content and gives back a new one, the way the VST's
 * editor changed its project -- same fields, same rules -- and gives back the
 * content it was handed when the edit is refused or changes nothing, so the
 * page writes nothing then. None of them touches the page or the engine.
 */

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
// Whole percentages, as the VST's sliders gave them. 0.45 * 100 is not 45 in
// floating point, and a humanize a hair over 0.45 is a sequence the engine refuses.
export const SWING_PERCENT = Math.round(SWING_MAX * 100);
export const HUMANIZE_PERCENT = Math.round(HUMANIZE_MAX * 100);

/** The scene the page shows: the one playing, or the one the file opens in. */
export function shownScene(content, status) {
  if (content.scenes[status?.scene]) return status.scene;
  return content.scenes[content.selectedScene] ? content.selectedScene : 0;
}

function mapChannel(content, scene, index, change) {
  const channel = content.scenes[scene]?.channels[index];
  if (!channel) return content;
  const next = change(channel);
  if (next === channel) return content;
  return {
    ...content,
    scenes: content.scenes.map((item, s) => (s !== scene ? item : {
      ...item,
      channels: item.channels.map((current, c) => (c === index ? next : current))
    }))
  };
}

// ---------- the channel ----------

/**
 * One of a channel's settings. `value` is what the control gives: a length, a
 * resolution's denominator, a repeat count (0 forever), a step mode, a boolean,
 * a whole number of steps, or a percentage. Legato needs `descriptor` to declare
 * a release, as the VST's editor required.
 */
export function setChannelSetting(content, scene, index, setting, value, { descriptor = null } = {}) {
  return mapChannel(content, scene, index, (channel) => {
    const put = (field, next) => (channel[field] === next ? channel : { ...channel, [field]: next });
    switch (setting) {
      case 'length': return LENGTHS.includes(value) ? put('length', value) : channel;
      case 'rate':
        if (!RESOLUTIONS.includes(value) || (channel.numerator === 1 && channel.denominator === value)) return channel;
        return { ...channel, numerator: 1, denominator: value };
      case 'repeats': return REPEATS.includes(value) ? put('repeats', value) : channel;
      case 'mode':
        if (value === STEP_MODE.trigger) return put('mode', value);
        return value === STEP_MODE.legato && descriptor?.releaseCommand ? put('mode', value) : channel;
      case 'enabled': return put('enabled', value === true);
      case 'offset':
        return Number.isFinite(value) ? put('offset', clamp(Math.round(value), -OFFSET_LIMIT, OFFSET_LIMIT)) : channel;
      case 'swing':
        return Number.isFinite(value) ? put('swing', clamp(Math.round(value), 0, SWING_PERCENT) / 100) : channel;
      case 'humanize':
        return Number.isFinite(value) ? put('humanize', clamp(Math.round(value), 0, HUMANIZE_PERCENT) / 100) : channel;
      default: return channel;
    }
  });
}

/** MUTATE may change this field of the channel's cells, or no longer may. */
export function toggleMutable(content, scene, index, field) {
  if (!Object.values(MUTABLE).includes(field)) return content;
  return mapChannel(content, scene, index, (channel) => ({ ...channel, mutableFields: (channel.mutableFields ^ field) >>> 0 }));
}

/**
 * Another target. As in the VST's editor the command is cleared -- a target's
 * commands are its own -- the cells lose their values and the channel goes
 * back to Trigger. '' aims the channel at nothing.
 */
export function setChannelTarget(content, scene, index, target) {
  return mapChannel(content, scene, index, (channel) => (channel.target.target === target && !channel.target.command
    ? channel
    : retarget(channel, String(target || ''), '', null)));
}

/** Another command of the same target: every cell takes its default value. */
export function setChannelCommand(content, scene, index, command, descriptor) {
  return mapChannel(content, scene, index, (channel) => (channel.target.command === command
    ? channel
    : retarget(channel, channel.target.target, String(command || ''), descriptor)));
}

// ---------- the cell ----------

/** Cell `cellIndex` of the channel, changed by `change(cell) -> cell`. */
export function editCell(content, scene, index, cellIndex, change) {
  if (!Number.isInteger(cellIndex) || cellIndex < 0 || cellIndex >= MAX_STEPS) return content;
  return mapChannel(content, scene, index, (channel) => {
    const cell = cellAt(channel, cellIndex);
    const next = change(cell);
    if (next === cell || JSON.stringify(next) === JSON.stringify(cell)) return channel;
    return setCell(channel, cellIndex, next);
  });
}

export const toggleActive = (cell) => ({ ...cell, enabled: !cell.enabled });

export function setProbability(cell, percent) {
  return Number.isFinite(percent) ? { ...cell, probability: clamp(Math.round(percent), 0, 100) } : cell;
}

export const toggleLocked = (cell) => ({ ...cell, locked: !cell.locked });

export function toggleLockedField(cell, field) {
  return Object.values(MUTABLE).includes(field) ? { ...cell, lockedFields: (cell.lockedFields ^ field) >>> 0 } : cell;
}

const isNumeric = (descriptor) => descriptor?.type === VALUE_TYPE.integer || descriptor?.type === VALUE_TYPE.number;

/** The VST's reading of a descriptor bound as a value of the descriptor's type. */
function boundValue(descriptor, bound) {
  if (descriptor.type === VALUE_TYPE.integer) return { type: VALUE_TYPE.integer, value: Math.trunc(bound) };
  return { type: VALUE_TYPE.number, value: bound };
}

/**
 * Fixed, a range, or a list. As the VST's editor did: the range starts as the
 * whole of the target's, the list as the fixed value alone. A range needs a
 * target that takes a number.
 */
export function setValueMode(cell, mode, descriptor) {
  if (!Object.values(VALUE_MODE).includes(mode) || cell.value.mode === mode) return cell;
  if (mode === VALUE_MODE.range && !isNumeric(descriptor)) return cell;
  const value = { ...cell.value, mode };
  if (isNumeric(descriptor)) {
    value.min = boundValue(descriptor, descriptor.minimum);
    value.max = boundValue(descriptor, descriptor.maximum);
  }
  if (descriptor) value.choices = [structuredClone(cell.value.fixed)];
  return { ...cell, value };
}

/**
 * A typed value from what was typed, checked against the command, or null.
 * A decimal comma is read as a point, since this is typed on French keyboards
 * too.
 */
export function parseValue(descriptor, text) {
  const raw = String(text ?? '').trim();
  switch (descriptor?.type) {
    case VALUE_TYPE.boolean: {
      const word = raw.toLowerCase();
      if (['1', 'true', 'on', 'yes'].includes(word)) return { type: VALUE_TYPE.boolean, value: true };
      if (['0', 'false', 'off', 'no'].includes(word)) return { type: VALUE_TYPE.boolean, value: false };
      return null;
    }
    case VALUE_TYPE.integer: {
      if (!/^[-+]?\d+$/.test(raw)) return null;
      const value = Number(raw);
      return Number.isSafeInteger(value) && value >= descriptor.minimum && value <= descriptor.maximum
        ? { type: VALUE_TYPE.integer, value } : null;
    }
    case VALUE_TYPE.number: {
      if (!/^[-+]?(\d+([.,]\d*)?|[.,]\d+)$/.test(raw)) return null;
      const value = Number(raw.replace(',', '.'));
      return Number.isFinite(value) && value >= descriptor.minimum && value <= descriptor.maximum
        ? { type: VALUE_TYPE.number, value } : null;
    }
    case VALUE_TYPE.choice: {
      const id = Number(raw);
      return raw !== '' && (descriptor.choices || []).some((item) => item.id === id)
        ? { type: VALUE_TYPE.choice, value: id } : null;
    }
    default: return null;
  }
}

/** A value as the page prints it. */
export function formatValue(value, descriptor) {
  switch (value?.type) {
    case VALUE_TYPE.boolean: return value.value ? 'on' : 'off';
    case VALUE_TYPE.integer: return String(value.value);
    case VALUE_TYPE.number: return String(Number(value.value.toFixed(4)));
    case VALUE_TYPE.choice: {
      const label = descriptor?.choices?.find((item) => item.id === value.value)?.label;
      return label ?? `#${value.value}`;
    }
    default: return '';
  }
}

/** A list as typed: split on semicolons when there are any, else on commas. */
export function parseValueList(descriptor, text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const parts = raw.split(raw.includes(';') ? ';' : ',').map((part) => part.trim()).filter(Boolean);
  const values = parts.map((part) => parseValue(descriptor, part));
  return values.length && values.every(Boolean) ? values : null;
}

export function setFixedValue(cell, value) {
  return value ? { ...cell, value: { ...cell.value, fixed: value } } : cell;
}

/**
 * One end of the range. The other end follows when it is passed, as the two
 * ends of a hardware range do, so the range is never empty.
 */
export function setRangeEnd(cell, end, value) {
  if (!value || (end !== 'min' && end !== 'max')) return cell;
  const source = { ...cell.value, [end]: value };
  const other = end === 'min' ? 'max' : 'min';
  const current = source[other];
  if (current?.type !== value.type
      || (end === 'min' ? current.value < value.value : current.value > value.value)) {
    source[other] = { ...value };
  }
  return { ...cell, value: source };
}

export function setChoices(cell, values) {
  return Array.isArray(values) && values.length ? { ...cell, value: { ...cell.value, choices: values } } : cell;
}

/** A choice of a list target in or out of the cell's list; the list is never left empty. */
export function toggleChoice(cell, id) {
  const choices = cell.value.choices.filter((item) => !(item.type === VALUE_TYPE.choice && item.value === id));
  if (choices.length === cell.value.choices.length) choices.push({ type: VALUE_TYPE.choice, value: id });
  return choices.length ? { ...cell, value: { ...cell.value, choices } } : cell;
}

// ---------- conditions ----------

/** What the page offers to add, in the VST's order. */
export const CONDITION_CHOICES = Object.freeze([
  { id: 'every-2', label: 'Every 2nd loop', kind: CONDITION.everyNth, interval: 2 },
  { id: 'every-3', label: 'Every 3rd loop', kind: CONDITION.everyNth, interval: 3 },
  { id: 'every-4', label: 'Every 4th loop', kind: CONDITION.everyNth, interval: 4 },
  { id: 'first', label: 'First loop only', kind: CONDITION.first },
  { id: 'last', label: 'Last loop', kind: CONDITION.last },
  { id: 'if-active', label: 'If a channel is active', kind: CONDITION.ifActive, channel: true },
  { id: 'if-inactive', label: 'If a channel is inactive', kind: CONDITION.ifInactive, channel: true }
]);

/** The condition a choice stands for; `channel` (0-15) for the two that watch one. */
export function conditionFor(choiceId, channel = 0) {
  const choice = CONDITION_CHOICES.find((item) => item.id === choiceId);
  if (!choice) return null;
  if (choice.channel && !(Number.isInteger(channel) && channel >= 0 && channel < CHANNEL_COUNT)) return null;
  // The engine's defaults for what a kind does not read: interval 2, channel 0.
  return { kind: choice.kind, interval: choice.interval ?? 2, channel: choice.channel ? channel : 0 };
}

const ordinal = (n) => {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] || 'th'}`;
};

const channelName = (index) => `CH ${String(index + 1).padStart(2, '0')}`;

export function conditionLabel(condition) {
  switch (condition?.kind) {
    case CONDITION.everyNth: return `Every ${ordinal(condition.interval)} loop`;
    case CONDITION.first: return 'First loop';
    case CONDITION.last: return 'Last loop';
    case CONDITION.ifActive: return `If ${channelName(condition.channel)} active`;
    case CONDITION.ifInactive: return `If ${channelName(condition.channel)} inactive`;
    default: return 'Always';
  }
}

export function addCondition(cell, condition) {
  if (!condition) return cell;
  const key = JSON.stringify(condition);
  if (cell.conditions.some((item) => JSON.stringify(item) === key)) return cell;
  return { ...cell, conditions: [...cell.conditions, condition] };
}

export function removeCondition(cell, position) {
  if (!Number.isInteger(position) || position < 0 || position >= cell.conditions.length) return cell;
  return { ...cell, conditions: cell.conditions.filter((_, i) => i !== position) };
}

/** A cell in a sentence, for the page's header line. */
export function describeCell(cell, channel, descriptor) {
  if (!cell.enabled) return 'Off: the channel is silent here';
  const parts = [];
  for (const condition of cell.conditions) {
    switch (condition.kind) {
      case CONDITION.everyNth: parts.push(`every ${ordinal(condition.interval)} loop`); break;
      case CONDITION.first: parts.push('on the first loop'); break;
      case CONDITION.last: parts.push(channel.repeats ? 'on the last loop' : 'on the last loop, which never comes'); break;
      case CONDITION.ifActive: parts.push(`when ${channelName(condition.channel)} plays`); break;
      case CONDITION.ifInactive: parts.push(`when ${channelName(condition.channel)} is silent`); break;
      default: break;
    }
  }
  if (cell.probability < 100) parts.push(`${cell.probability} % of the time`);
  else if (!parts.length) parts.push('every time');
  const { value } = cell;
  if (descriptor && descriptor.type !== VALUE_TYPE.none) {
    if (value.mode === VALUE_MODE.range) {
      parts.push(`a value from ${formatValue(value.min, descriptor)} to ${formatValue(value.max, descriptor)}`);
    } else if (value.mode === VALUE_MODE.choice) {
      parts.push(`one of ${value.choices.length} values`);
    } else if (value.fixed.type !== VALUE_TYPE.none) {
      parts.push(`value ${formatValue(value.fixed, descriptor)}`);
    }
  }
  return `Plays ${parts.join(', ')}`;
}

// ---------- follow actions ----------

/** An action to add: a target, one of its commands, and the value it takes. */
export function followAction(target, command, value = null) {
  if (!target || !command) return null;
  return { target: String(target), command: String(command), value: { ...emptySource(), fixed: value ?? emptyValue() } };
}

export function addFollowAction(content, scene, index, action) {
  if (!action) return content;
  return mapChannel(content, scene, index, (channel) => ({ ...channel, follow: [...channel.follow, action] }));
}

export function removeFollowAction(content, scene, index, position) {
  return mapChannel(content, scene, index, (channel) => (
    Number.isInteger(position) && position >= 0 && position < channel.follow.length
      ? { ...channel, follow: channel.follow.filter((_, i) => i !== position) }
      : channel));
}

// ---------- the scenes ----------

export function setSceneTiming(content, timing) {
  return Object.values(SCENE_TIMING).includes(timing) && content.sceneTiming !== timing
    ? { ...content, sceneTiming: timing } : content;
}

export function setScenePosition(content, position) {
  return Object.values(SCENE_POSITION).includes(position) && content.scenePosition !== position
    ? { ...content, scenePosition: position } : content;
}

/** The scene the file opens in, chosen while nothing plays it. */
export function selectScene(content, scene) {
  return content.scenes[scene] && content.selectedScene !== scene ? { ...content, selectedScene: scene } : content;
}
