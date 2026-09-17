import { escapeHtml } from '../../core/html.js';
import {
  CHANNEL_TARGET_PREFIX, MAX_CAPTURE_BARS, MAX_FEEDBACK_DELAY_BARS, MAX_FEEDBACK_LIMIT, MAX_WRITER_BARS,
  MEMORY_TARGET, OFFSET_LIMIT, SCENES_TARGET, VOICE_RULES, VOICE_TARGET_PREFIX, WRITER_TARGET
} from '../../core/oneRingSequence.js';
import { HUMANIZE_PERCENT, SWING_PERCENT } from '../../core/oneRingEdits.js';
import { pearlDragKnob, pearlLcd, pearlLegend, pearlSelector } from '../../ui/omniPearl.js';

/**
 * The pieces every tab of the One Ring page is drawn with: how a target and a
 * command are named, the selects, the levers, and the knobs.
 *
 * WHY THE KNOBS ARE ONE TABLE
 * ---------------------------
 * A knob is drawn by a tab and turned by the panel, which reads nothing but its
 * name back from the page. So each knob says here, once, its range, how it
 * reads, what it edits (`edit`: the channel, the cell, the capture, a voice's
 * rule or the writer), the region it sits in -- which a redraw must leave alone
 * while the knob is being turned -- and where its value comes from in a view.
 */

export const glyphs = {
  play: '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M5 3.5v11l9-5.5z"/></svg>',
  stop: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="1"/></svg>',
  lock: '<svg class="op-glyph" viewBox="0 0 10 10" aria-hidden="true"><rect x="2" y="4.5" width="6" height="4.5" rx="0.8"/><path d="M3.5 4.5V3a1.5 1.5 0 0 1 3 0v1.5"/></svg>',
  condition: '<svg class="op-glyph" viewBox="0 0 10 10" aria-hidden="true"><path d="M5 1.2 8.8 5 5 8.8 1.2 5z"/></svg>',
  random: '<svg class="op-glyph" viewBox="0 0 10 10" aria-hidden="true"><path d="M1 6.5c1.2-3 2.4-3 3.6 0s2.4 3 4.4-2"/></svg>'
};

export const pad2 = (n) => String(n).padStart(2, '0');
export const channelName = (index) => `CH ${pad2(index + 1)}`;
export const act = (name, arg) => `data-ring-act="${name}"${arg === undefined ? '' : ` data-ring-arg="${escapeHtml(arg)}"`}`;
const titleCase = (text) => {
  const words = String(text).replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
};

const NOTE_LETTERS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
/** A MIDI note as the Sequencer names it: 60 is C4. */
export const noteName = (pitch) => `${NOTE_LETTERS[((pitch % 12) + 12) % 12]}${Math.floor(pitch / 12) - 1}`;

const LETTER_STEPS = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
/** A note typed as a name (`C4`, `f#2`, `Bb-1`) or a number; null otherwise. */
export function parseNote(text) {
  const raw = String(text ?? '').trim();
  if (/^\d{1,3}$/.test(raw)) return Number(raw);
  const match = /^([a-g])([#b]?)\s*(-?\d)$/i.exec(raw);
  if (!match) return null;
  const accidental = match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0;
  return LETTER_STEPS[match[1].toLowerCase()] + accidental + (Number(match[3]) + 1) * 12;
}

// ---------- targets ----------

/** How the page names a target: One Ring's own the way its panel reads, the others by their node. */
export function targetLabel(target) {
  if (target.id === SCENES_TARGET) return 'One Ring · Scenes';
  if (target.id === MEMORY_TARGET) return 'One Ring · Memory';
  if (target.id === WRITER_TARGET) return 'One Ring · Writer';
  if (target.id.startsWith(VOICE_TARGET_PREFIX)) return `One Ring · Voice ${target.id.slice(VOICE_TARGET_PREFIX.length)}`;
  if (target.id.startsWith(CHANNEL_TARGET_PREFIX)) {
    return `One Ring · ${channelName(Number(target.id.slice(CHANNEL_TARGET_PREFIX.length)) - 1)}`;
  }
  return target.label;
}

export function commandLabel(target, descriptor) {
  return target && (target.id === SCENES_TARGET || target.id === MEMORY_TARGET || target.id === WRITER_TARGET
    || target.id.startsWith(CHANNEL_TARGET_PREFIX) || target.id.startsWith(VOICE_TARGET_PREFIX))
    ? titleCase(descriptor.label)
    : descriptor.label;
}

/** A target and command as one line of text, and whether either is gone. */
export function describeAction(view, action) {
  if (!action.target && !action.command) return { text: 'no target', empty: true, missing: false, descriptor: null };
  const target = view.findTarget(action.target);
  const descriptor = target?.commands.get(action.command) ?? null;
  const commandText = !action.command ? 'no command' : descriptor ? commandLabel(target, descriptor) : action.command;
  return {
    text: `${target ? targetLabel(target) : action.target} · ${commandText}`,
    empty: false,
    missing: !target || (!!action.command && !descriptor),
    descriptor
  };
}

// ---------- fields ----------

export function optionTag(value, label, selected, disabled = false) {
  return `<option value="${escapeHtml(value)}"${selected ? ' selected' : ''}${disabled ? ' disabled' : ''}>${escapeHtml(label)}</option>`;
}

export function selectBox(inner, attrs, ariaLabel, extra = '') {
  return `<span class="op-select ${extra}"><select class="op-select-native" aria-label="${escapeHtml(ariaLabel)}" ${attrs}>${inner}</select><span class="op-select-chevron"></span></span>`;
}

export function targetSelect(view, value, attrs, ariaLabel) {
  const external = view.targets.external;
  const known = view.findTarget(value);
  const cabled = external.length
    ? external.map((target) => optionTag(target.id, targetLabel(target), target.id === value)).join('')
    : optionTag('', 'Nothing cabled to CTRL OUT', false, true);
  const own = view.targets.internal.map((target) => optionTag(target.id, targetLabel(target), target.id === value)).join('');
  const lost = value && !known ? optionTag(value, `${value} (not cabled)`, true) : '';
  return selectBox(`${optionTag('', '— No target —', !value)}${lost}
    <optgroup label="Cabled to CTRL OUT">${cabled}</optgroup><optgroup label="One Ring">${own}</optgroup>`,
  attrs, ariaLabel, 'op-select--wide');
}

export function commandSelect(view, targetId, value, attrs, ariaLabel) {
  const target = view.findTarget(targetId);
  const commands = target ? [...target.commands.values()] : [];
  const listed = commands.some((item) => item.id === value);
  const options = commands.map((item) => optionTag(item.id, commandLabel(target, item), item.id === value)).join('');
  const lost = value && !listed ? optionTag(value, `${value} (unknown)`, true) : '';
  return selectBox(`${optionTag('', targetId ? '— Command —' : '— Choose a target —', !value)}${lost}${options}`,
    `${commands.length ? '' : 'disabled '}${attrs}`, ariaLabel, 'op-select--wide');
}

/**
 * A lever between two printed positions: `name` with 0 or 1 when a position is
 * clicked, `name-toggle` when the switch is.
 */
export function lever(name, left, right, on, { disabled = false } = {}) {
  return `<span class="op-lever">${pearlLegend(left, { state: on ? '' : 'on', attrs: act(name, 0), disabled })}
    <label class="op-switch op-switch--sm"><input class="op-native" type="checkbox" aria-label="${escapeHtml(`${left} or ${right}`)}"${on ? ' checked' : ''}${disabled ? ' disabled' : ''} ${act(`${name}-toggle`)}><span class="op-switch-track"><span class="op-switch-thumb"></span></span></label>
    ${pearlLegend(right, { state: on ? 'on' : '', attrs: act(name, 1), disabled })}</span>`;
}

/** A labelled field above a control. */
export function field(label, control, extra = '') {
  return `<div class="op-ring-field ${extra}"><span class="op-label">${escapeHtml(label)}</span>${control}</div>`;
}

export function selectorControl(name, label, options, value, { arg } = {}) {
  const attrs = `${act(name, arg)} data-ring-focus="${name}${arg === undefined ? '' : `-${arg}`}"`;
  return `<div class="op-ring-control">${pearlSelector({ options, value, optionAttr: 'data-ring-option', ariaLabel: label, attrs })}${pearlLegend(label)}</div>`;
}

// ---------- knobs ----------

const percent = (v) => `${v} %`;
const signed = (v, unit) => `${v > 0 ? '+' : ''}${v} ${unit}`;
const bars = (v) => `${v} bar${v === 1 ? '' : 's'}`;

function voiceKnob(rule, label, text, extra = {}) {
  const { min, max, neutral } = VOICE_RULES[rule];
  return { min, max, reset: neutral, text, label, region: 'voices', edit: 'voice', rule, value: (view) => view.voiceRules[rule], ...extra };
}

export const KNOBS = Object.freeze({
  offset: {
    min: -OFFSET_LIMIT, max: OFFSET_LIMIT, bipolar: true, reset: 0, text: (v) => signed(v, 'st'), label: 'Offset',
    region: 'channel', edit: 'channel', value: (view) => Math.round(view.channel.offset)
  },
  swing: {
    min: 0, max: SWING_PERCENT, reset: 0, text: percent, label: 'Swing',
    region: 'channel', edit: 'channel', value: (view) => Math.round(view.channel.swing * 100)
  },
  humanize: {
    min: 0, max: HUMANIZE_PERCENT, reset: 0, text: percent, label: 'Humanize',
    region: 'channel', edit: 'channel', value: (view) => Math.round(view.channel.humanize * 100)
  },
  probability: {
    min: 0, max: 100, reset: 100, text: percent, label: 'Probability',
    region: 'cell', edit: 'cell', value: (view) => Math.round(view.cell.probability)
  },
  'capture-bars': {
    min: 0, max: MAX_CAPTURE_BARS, reset: 1, text: (v) => (v === 0 ? 'to END' : bars(v)), label: 'Length',
    parse: (text) => (/end/i.test(String(text)) ? 0 : undefined),
    region: 'capture', edit: 'capture', value: (view) => view.content.capture.bars
  },
  'voice-transpose': voiceKnob('transpose', 'Transpose', (v) => signed(v, 'st'), { bipolar: true }),
  'voice-octave': voiceKnob('octave', 'Octave', (v) => signed(v, 'oct'), { bipolar: true }),
  'voice-octaveSpread': voiceKnob('octaveSpread', 'Spread', (v) => `± ${v} oct`),
  'voice-octaveChance': voiceKnob('octaveChance', 'Chance', percent),
  'voice-low': voiceKnob('low', 'Lowest', noteName, { parse: parseNote }),
  'voice-high': voiceKnob('high', 'Highest', noteName, { parse: parseNote }),
  'voice-velocityScale': voiceKnob('velocityScale', 'Velocity', percent),
  'voice-velocitySpread': voiceKnob('velocitySpread', 'Spread', (v) => `± ${v}`),
  'voice-velocityLow': voiceKnob('velocityLow', 'Softest', String),
  'voice-velocityHigh': voiceKnob('velocityHigh', 'Loudest', String),
  'voice-gateScale': voiceKnob('gateScale', 'Gate', percent),
  'voice-gateSpread': voiceKnob('gateSpread', 'Spread', (v) => `± ${v} %`),
  'voice-density': voiceKnob('density', 'Density', percent),
  'writer-bars': {
    min: 1, max: MAX_WRITER_BARS, reset: 4, text: bars, label: 'Window',
    region: 'writer', edit: 'writer', field: 'bars', value: (view) => view.writer.bars
  },
  'writer-delay': {
    min: 0, max: MAX_FEEDBACK_DELAY_BARS, reset: 0, text: (v) => (v === 0 ? 'none' : bars(v)), label: 'Delay',
    parse: (text) => (/none/i.test(String(text)) ? 0 : undefined),
    region: 'writer', edit: 'writer', field: 'delayBars', value: (view) => view.writer.delayBars
  },
  'writer-limit': {
    min: 1, max: MAX_FEEDBACK_LIMIT, reset: 16, text: (v) => `${v} ×`, label: 'Limit',
    region: 'writer', edit: 'writer', field: 'limit', value: (view) => view.writer.limit
  }
});

/** A knob, its typed field and its legend. */
export function knobControl(name, view, { disabled = false } = {}) {
  const knob = KNOBS[name];
  const value = knob.value(view);
  return `<div class="op-ring-control${disabled ? ' is-disabled' : ''}" data-ring-knob-control="${name}">
      ${pearlDragKnob({ value, min: knob.min, max: knob.max, bipolar: knob.bipolar, ariaLabel: knob.label, text: knob.text(value), attrs: `data-ring-knob="${name}"` })}
      ${pearlLcd({ value: knob.text(value), input: true, size: 'sm', ariaLabel: `${knob.label}, typed`, disabled, attrs: `${act('knob-value', name)} data-ring-knob-lcd="${name}" data-ring-focus="knob-${name}"` })}
      ${pearlLegend(knob.label)}
    </div>`;
}
