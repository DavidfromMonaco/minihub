import { escapeHtml } from '../../core/html.js';
import { VALUE_TYPE } from '../../core/commandRegistry.js';
import {
  CHANNEL_COUNT, CHANNEL_TARGET_PREFIX, LENGTHS, MAX_STEPS, MEMORY_TARGET, MUTABLE, OFFSET_LIMIT, REPEATS, RESOLUTIONS,
  SCENES_TARGET, SCENE_POSITION, SCENE_TIMING, STEP_MODE, VALUE_MODE, VOICE_TARGET_PREFIX, cellsOf
} from '../../core/oneRingSequence.js';
import {
  pearlDragKnob, pearlKeycap, pearlLcd, pearlLed, pearlLegend, pearlScribble, pearlSelector
} from '../../ui/omniPearl.js';
import { icon } from '../../ui/icons.js';
import {
  CONDITION_CHOICES, HUMANIZE_PERCENT, SWING_PERCENT, conditionLabel, describeCell, formatValue
} from '../../core/oneRingEdits.js';

/**
 * The One Ring page's markup: the faceplate the author approved on 2026-09-17
 * (docs/design-references/one-ring-faceplate.png), drawn from a `view`
 * (oneRingPanel.js builds it) and nothing else.
 *
 * A region is redrawn only when its markup changes, so nothing here depends on
 * the runtime's status, which arrives ten times a second: what moves with it --
 * the display, the LEDs, the playheads -- carries a `data-ring-*` hook that the
 * panel updates in place. Every control names what it does with `data-ring-act`
 * (and `data-ring-arg`), which is all the panel reads back.
 */

const glyphs = {
  play: '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M5 3.5v11l9-5.5z"/></svg>',
  stop: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="1"/></svg>',
  lock: '<svg class="op-glyph" viewBox="0 0 10 10" aria-hidden="true"><rect x="2" y="4.5" width="6" height="4.5" rx="0.8"/><path d="M3.5 4.5V3a1.5 1.5 0 0 1 3 0v1.5"/></svg>',
  condition: '<svg class="op-glyph" viewBox="0 0 10 10" aria-hidden="true"><path d="M5 1.2 8.8 5 5 8.8 1.2 5z"/></svg>',
  random: '<svg class="op-glyph" viewBox="0 0 10 10" aria-hidden="true"><path d="M1 6.5c1.2-3 2.4-3 3.6 0s2.4 3 4.4-2"/></svg>'
};

const pad2 = (n) => String(n).padStart(2, '0');
export const channelName = (index) => `CH ${pad2(index + 1)}`;
const act = (name, arg) => `data-ring-act="${name}"${arg === undefined ? '' : ` data-ring-arg="${escapeHtml(arg)}"`}`;
const titleCase = (text) => {
  const words = String(text).replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
};

// ---------- targets ----------

/** How the page names a target: One Ring's own the way its panel reads, the others by their node. */
export function targetLabel(target) {
  if (target.id === SCENES_TARGET) return 'One Ring · Scenes';
  if (target.id === MEMORY_TARGET) return 'One Ring · Memory';
  if (target.id.startsWith(VOICE_TARGET_PREFIX)) return `One Ring · Voice ${target.id.slice(VOICE_TARGET_PREFIX.length)}`;
  if (target.id.startsWith(CHANNEL_TARGET_PREFIX)) {
    return `One Ring · ${channelName(Number(target.id.slice(CHANNEL_TARGET_PREFIX.length)) - 1)}`;
  }
  return target.label;
}

export function commandLabel(target, descriptor) {
  return target && (target.id === SCENES_TARGET || target.id === MEMORY_TARGET
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

function optionTag(value, label, selected, disabled = false) {
  return `<option value="${escapeHtml(value)}"${selected ? ' selected' : ''}${disabled ? ' disabled' : ''}>${escapeHtml(label)}</option>`;
}

function selectBox(inner, attrs, ariaLabel, extra = '') {
  return `<span class="op-select ${extra}"><select class="op-select-native" aria-label="${escapeHtml(ariaLabel)}" ${attrs}>${inner}</select><span class="op-select-chevron"></span></span>`;
}

function targetSelect(view, value, attrs, ariaLabel) {
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

function commandSelect(view, targetId, value, attrs, ariaLabel) {
  const target = view.findTarget(targetId);
  const commands = target ? [...target.commands.values()] : [];
  const listed = commands.some((item) => item.id === value);
  const options = commands.map((item) => optionTag(item.id, commandLabel(target, item), item.id === value)).join('');
  const lost = value && !listed ? optionTag(value, `${value} (unknown)`, true) : '';
  return selectBox(`${optionTag('', targetId ? '— Command —' : '— Choose a target —', !value)}${lost}${options}`,
    `${commands.length ? '' : 'disabled '}${attrs}`, ariaLabel, 'op-select--wide');
}

// ---------- deck ----------

function renderDeck(view) {
  const { content, scene, ready } = view;
  const transport = `<div class="op-ring-group">
      <span class="op-label">Transport</span>
      <div class="op-ring-keys">
        <div class="op-ring-keyset">${pearlKeycap({ svg: glyphs.play, size: 'lg', title: 'Run', disabled: !ready, attrs: `${act('run')} data-ring-live-run` })}${pearlLegend('Run')}</div>
        <div class="op-ring-keyset">${pearlKeycap({ svg: glyphs.stop, size: 'lg', title: 'Stop', disabled: !ready, attrs: act('stop') })}${pearlLegend('Stop')}</div>
      </div>
    </div>`;
  const dots = Array.from({ length: CHANNEL_COUNT }, (_, i) => `<i data-ring-dot="${i}"></i>`).join('');
  const display = `<div class="op-ring-group">
      <div class="op-display" role="status" aria-live="off">
        <div class="op-display-big"><small>SCENE</small><span data-ring-live="scene">${escapeHtml(content.scenes[scene].id)}</span></div>
        <div class="op-display-big op-display-right"><small>BAR</small><span data-ring-live="bar">—</span><small>BPM</small><span data-ring-live="bpm">—</span></div>
        <div class="op-display-line"><span class="accent" data-ring-live="state">${ready ? '■ STOPPED' : 'NOT IN THE ENGINE'}</span><span class="gap" data-ring-live="pending"></span></div>
        <div class="op-display-line op-display-right"><span class="dim">REFUSED</span> <span data-ring-live="refused">0</span><span class="dim gap">GUARDED</span> <span data-ring-live="guarded">0</span></div>
        <div class="op-display-dots" aria-hidden="true">${dots}</div>
        <div class="op-display-line op-display-right"><span class="dim">LAST REFUSAL</span> <span data-ring-live="refusal">—</span></div>
      </div>
    </div>`;
  const keys = content.scenes.map((item, i) => {
    const state = i === scene ? 'lit' : view.storeArmed ? 'armed' : '';
    const title = view.storeArmed && i !== scene ? `Store ${content.scenes[scene].id} into ${item.id}` : item.name;
    return `<div class="op-ring-keyset">${pearlKeycap({ label: item.id, size: 'sq', state, title, pressed: i === scene, attrs: `${act('scene', i)} data-ring-scene="${i}"` })}<span class="op-legend accent" data-ring-scene-legend="${i}">${view.storeArmed && i !== scene ? 'Store here' : '&nbsp;'}</span></div>`;
  }).join('');
  const store = `<div class="op-ring-keyset op-ring-store">${pearlKeycap({ label: 'Store', size: 'sq word', state: view.storeArmed ? 'lit' : '', title: 'Store this scene into another', pressed: view.storeArmed, attrs: act('store') })}${pearlLegend(view.storeArmed ? 'Pick a scene' : 'then a scene', { state: view.storeArmed ? 'on' : '' })}</div>`;
  const scenes = `<div class="op-ring-group">
      <span class="op-label">Scenes</span>
      <div class="op-ring-keys">${keys}${store}</div>
    </div>`;
  const nextBar = content.sceneTiming === SCENE_TIMING.nextBar;
  const keep = content.scenePosition === SCENE_POSITION.keep;
  const lever = (name, left, right, on) => `${pearlLegend(left, { state: on ? '' : 'on', attrs: act(name, 0) })}
    <label class="op-switch op-switch--sm"><input class="op-native" type="checkbox" aria-label="${escapeHtml(`${left} or ${right}`)}"${on ? ' checked' : ''} ${act(`${name}-toggle`)}><span class="op-switch-track"><span class="op-switch-thumb"></span></span></label>
    ${pearlLegend(right, { state: on ? 'on' : '', attrs: act(name, 1) })}`;
  const recall = `<div class="op-ring-group">
      <span class="op-label">Scene recall</span>
      <div class="op-ring-recall">
        ${pearlLegend('Timing')}${lever('timing', 'Now', 'Next bar', nextBar)}
        ${pearlLegend('Channels')}${lever('position', 'Restart', 'Keep', keep)}
      </div>
    </div>`;
  const random = `<div class="op-ring-group op-ring-group--grow">
      <span class="op-label">Random</span>
      <div class="op-ring-keys">
        <div class="op-ring-keyset">${pearlLcd({ value: view.seedText ?? content.seed, input: true, size: 'seed', invalid: view.seedError, ariaLabel: 'Seed', attrs: `${act('seed')} inputmode="numeric" maxlength="20" data-ring-focus="seed"` })}${pearlLegend(view.seedError ? 'A whole number below 2^64' : `Seed · mutation ${content.mutation}`, { state: view.seedError ? 'error' : '' })}</div>
        ${pearlKeycap({ label: 'New seed', attrs: act('new-seed') })}
      </div>
      <div class="op-ring-keys">
        ${pearlKeycap({ label: `Mutate ${channelName(view.channelIndex)}`, attrs: act('mutate-channel'), title: `Vary ${channelName(view.channelIndex)} within its locks` })}
        ${pearlKeycap({ label: 'Mutate all', attrs: act('mutate-all'), title: 'Vary all sixteen channels within their locks' })}
      </div>
    </div>`;
  return `${transport}${display}${scenes}${recall}${random}`;
}

// ---------- channel list ----------

function miniStrip(channel, index) {
  const cells = cellsOf(channel);
  let x = 5;
  const rects = [];
  for (let k = 0; k < MAX_STEPS; k += 1) {
    if (k > 0 && k % 16 === 0) x += 3;
    const cls = k >= channel.length ? 'out' : cells[k].enabled ? 'on' : 'off';
    rects.push(`<rect class="${cls}" x="${x}" data-cell="${k}"></rect>`);
    x += 4;
  }
  return `<svg class="op-ring-mini" viewBox="0 0 275 28" preserveAspectRatio="none" aria-hidden="true" data-ring-mini="${index}"><rect class="well" x="0.5" y="0.5" width="274" height="27" rx="4"></rect>${rects.join('')}</svg>`;
}

function renderChannels(view) {
  const rows = view.sceneData.channels.map((channel, i) => {
    const described = describeAction(view, channel.target);
    const selected = i === view.channelIndex;
    const classes = ['op-ring-row', selected ? 'is-selected' : '', channel.enabled ? '' : 'is-disabled'].filter(Boolean).join(' ');
    const label = `${channelName(i)}: ${described.text}${channel.enabled ? '' : ', off'}`;
    return `<li><button type="button" class="${classes}" aria-pressed="${selected}" aria-label="${escapeHtml(label)}" ${act('channel', i)}>
        <span class="op-keycap${selected ? ' is-white' : ''}">${pearlLed(false, `data-ring-led="${i}"`)}${pad2(i + 1)}</span>
        ${pearlScribble(described.text, { empty: described.empty, missing: described.missing, title: described.text })}
        ${miniStrip(channel, i)}
      </button></li>`;
  }).join('');
  return `<div class="op-panel-head"><span class="op-label accent">Channels</span><span class="op-hint">Scene ${escapeHtml(view.sceneData.id)} · a lit LED plays · click a channel to edit it</span></div>
    <ol class="op-ring-rows">${rows}</ol>`;
}

// ---------- the channel being edited ----------

const LENGTH_OPTIONS = LENGTHS.map((value) => ({ value, label: String(value) }));
const RATE_OPTIONS = RESOLUTIONS.map((value) => ({ value, label: `1/${value}` }));
const REPEAT_OPTIONS = REPEATS.map((value) => ({ value, label: value === 0 ? '∞' : String(value) }));

export const KNOBS = Object.freeze({
  offset: { min: -OFFSET_LIMIT, max: OFFSET_LIMIT, bipolar: true, reset: 0, text: (v) => `${v > 0 ? '+' : ''}${v} st`, label: 'Offset' },
  swing: { min: 0, max: SWING_PERCENT, reset: 0, text: (v) => `${v} %`, label: 'Swing' },
  humanize: { min: 0, max: HUMANIZE_PERCENT, reset: 0, text: (v) => `${v} %`, label: 'Humanize' },
  probability: { min: 0, max: 100, reset: 100, text: (v) => `${v} %`, label: 'Probability' }
});

/** A knob setting's value as the page holds it: steps, or a whole percentage. */
export function knobValue(name, channel, cell) {
  if (name === 'offset') return Math.round(channel.offset);
  if (name === 'swing') return Math.round(channel.swing * 100);
  if (name === 'humanize') return Math.round(channel.humanize * 100);
  return Math.round(cell.probability);
}

function knobControl(name, value) {
  const knob = KNOBS[name];
  return `<div class="op-ring-control" data-ring-knob-control="${name}">
      ${pearlDragKnob({ value, min: knob.min, max: knob.max, bipolar: knob.bipolar, ariaLabel: knob.label, text: knob.text(value), attrs: `data-ring-knob="${name}"` })}
      ${pearlLcd({ value: knob.text(value), input: true, size: 'sm', ariaLabel: `${knob.label}, typed`, attrs: `${act('knob-value', name)} data-ring-knob-lcd="${name}" data-ring-focus="knob-${name}"` })}
      ${pearlLegend(knob.label)}
    </div>`;
}

function selectorControl(name, label, options, value) {
  return `<div class="op-ring-control">${pearlSelector({ options, value, optionAttr: 'data-ring-option', ariaLabel: label, attrs: `${act(name)} data-ring-focus="${name}"` })}${pearlLegend(label)}</div>`;
}

function renderPad(view, cell, k) {
  const { channel } = view;
  const out = k >= channel.length;
  const random = cell.value.mode !== VALUE_MODE.fixed;
  const classes = ['op-pad', out ? 'is-out' : '', k % 4 === 0 ? 'is-beat' : '', k === view.cellIndex ? 'is-selected' : '']
    .filter(Boolean).join(' ');
  const lit = cell.enabled ? `<rect class="on" width="${Math.max(0, Math.min(100, cell.probability))}" height="4" rx="1"></rect>` : '';
  const flags = [
    cell.conditions.length ? glyphs.condition : '',
    random ? glyphs.random : '',
    cell.locked ? glyphs.lock : ''
  ].join('');
  const state = [cell.enabled ? `on, ${cell.probability} %` : 'off', out ? 'past the length' : '',
    cell.conditions.length ? 'with conditions' : '', random ? 'random value' : '', cell.locked ? 'locked' : '']
    .filter(Boolean).join(', ');
  return `<button type="button" class="${classes}" aria-label="${escapeHtml(`Cell ${k + 1}, ${state}`)}" aria-pressed="${k === view.cellIndex}" ${act('pad', k)} data-ring-pad="${k}">
      <svg class="op-pad-bar" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true"><rect class="off" width="100" height="4" rx="1"></rect>${lit}</svg>
      <span class="op-pad-num">${k + 1}</span>${flags ? `<span class="op-pad-flags">${flags}</span>` : ''}
    </button>`;
}

function renderChannel(view) {
  const { channel, channelIndex: index } = view;
  const name = channelName(index);
  const descriptor = view.find(channel.target.target, channel.target.command);
  const legato = !!descriptor?.releaseCommand;
  const mutable = [['Active', MUTABLE.enabled], ['Prob', MUTABLE.probability], ['Value', MUTABLE.value]]
    .map(([label, bit]) => pearlKeycap({ label, size: 'sm', led: (channel.mutableFields & bit) !== 0, pressed: (channel.mutableFields & bit) !== 0, title: `MUTATE may change the cells' ${label.toLowerCase()}`, attrs: act('mutable', bit) }))
    .join('');
  const head = `<div class="op-ring-chan-head">
      <span class="op-ring-chan-id">${name}</span>
      <div class="op-ring-field"><span class="op-label">Target</span>${targetSelect(view, channel.target.target, `${act('target')} data-ring-focus="target"`, `${name} target`)}</div>
      <div class="op-ring-field"><span class="op-label">Command</span>${commandSelect(view, channel.target.target, channel.target.command, `${act('command')} data-ring-focus="command"`, `${name} command`)}</div>
      <div class="op-ring-field"><span class="op-label">Play ${name}</span><span class="op-keycap-row">${pearlKeycap({ label: 'Restart', size: 'sm', disabled: !view.ready, attrs: act('restart-channel') })}${pearlKeycap({ label: 'Stop', size: 'sm', disabled: !view.ready, attrs: act('stop-channel') })}</span></div>
      <span class="op-spacer"></span>
      <div class="op-ring-field"><span class="op-label">Mutate may change</span><span class="op-keycap-row">${mutable}</span></div>
      <div class="op-ring-field"><span class="op-label">Channel on</span>
        <label class="op-switch"><input class="op-native" type="checkbox" aria-label="${name} on"${channel.enabled ? ' checked' : ''} ${act('enabled')}><span class="op-switch-track"><span class="op-switch-thumb"></span></span></label></div>
    </div>`;
  const legatoOn = channel.mode === STEP_MODE.legato;
  const mode = `<div class="op-ring-control op-ring-control--lever">
      <span class="op-lever">${pearlLegend('Trigger', { state: legatoOn ? '' : 'on', attrs: act('mode', STEP_MODE.trigger) })}
        <label class="op-switch op-switch--sm"><input class="op-native" type="checkbox" aria-label="Legato"${legatoOn ? ' checked' : ''}${legato || legatoOn ? '' : ' disabled'} ${act('mode-toggle')}><span class="op-switch-track"><span class="op-switch-thumb"></span></span></label>
        ${pearlLegend('Legato', { state: legatoOn ? 'on' : legato ? '' : 'unavailable', attrs: act('mode', STEP_MODE.legato), disabled: !legato })}</span>
      ${pearlLegend(legato || legatoOn ? 'Step mode' : 'Step mode · no release')}
    </div>`;
  const controls = `<div class="op-ring-controls">
      ${selectorControl('length', 'Length', LENGTH_OPTIONS, channel.length)}
      ${selectorControl('rate', 'Rate', RATE_OPTIONS, channel.numerator === 1 ? channel.denominator : '')}
      ${selectorControl('repeats', 'Repeat', REPEAT_OPTIONS, channel.repeats)}
      <span class="op-ring-sep"></span>${mode}<span class="op-ring-sep"></span>
      ${knobControl('offset', knobValue('offset', channel))}
      ${knobControl('swing', knobValue('swing', channel))}
      ${knobControl('humanize', knobValue('humanize', channel))}
    </div>`;
  const cells = cellsOf(channel);
  const pads = [0, 16, 32, 48].map((start) => {
    const beats = [0, 4, 8, 12].map((beat) => `<div class="op-ring-beat">${[0, 1, 2, 3].map((k) => renderPad(view, cells[start + beat + k], start + beat + k)).join('')}</div>`).join('');
    return `<span class="op-ring-rowmark">${start + 1}</span>${beats}`;
  }).join('');
  const legend = `<div class="op-ring-padlegend">
      <span class="op-legend"><i class="op-swatch"></i>on</span>
      <span class="op-legend"><i class="op-swatch is-half"></i>probability</span>
      <span class="op-legend"><i class="op-swatch is-head"></i>playing</span>
      <span class="op-legend"><i class="op-swatch is-ring"></i>selected</span>
      <span class="op-legend">${glyphs.condition}condition</span>
      <span class="op-legend">${glyphs.random}random value</span>
      <span class="op-legend">${glyphs.lock}locked</span>
      <span class="op-spacer"></span>
      <span class="op-legend">click selects · double-click turns on or off</span>
    </div>`;
  return `${head}${controls}<div class="op-ring-pads">${pads}</div>${legend}`;
}

// ---------- the selected cell ----------

function valueFields(view, cell, descriptor) {
  const source = cell.value;
  if (!descriptor) {
    return `<span class="op-ring-valuefields">${pearlLcd({ value: view.channel.target.target ? 'choose a command' : 'choose a target', dim: true })}</span>`;
  }
  if (descriptor.type === VALUE_TYPE.none) {
    return `<span class="op-ring-valuefields">${pearlLcd({ value: 'this command takes no value', dim: true })}</span>`;
  }
  const field = (value, action, label, focus) => `<span class="op-ring-keyset">${pearlLcd({ value, input: true, size: 'value', ariaLabel: label, attrs: `${act(action)} data-ring-focus="${focus}"` })}${pearlLegend(label)}</span>`;
  const range = descriptor.type === VALUE_TYPE.integer || descriptor.type === VALUE_TYPE.number
    ? `${descriptor.minimum} – ${descriptor.maximum}`
    : descriptor.type === VALUE_TYPE.boolean ? 'on / off' : `${descriptor.choices.length} choices`;
  const bounds = `<span class="op-ring-keyset">${pearlLcd({ value: range, dim: true })}${pearlLegend('Target takes')}</span>`;
  if (source.mode === VALUE_MODE.range) {
    return `<span class="op-ring-valuefields">${field(formatValue(source.min, descriptor), 'value-min', 'Min', 'value-min')}${field(formatValue(source.max, descriptor), 'value-max', 'Max', 'value-max')}${bounds}</span>`;
  }
  if (source.mode === VALUE_MODE.choice) {
    if (descriptor.type === VALUE_TYPE.choice) {
      const chosen = new Set(source.choices.filter((item) => item.type === VALUE_TYPE.choice).map((item) => item.value));
      const keys = descriptor.choices.map((choice) => pearlKeycap({ label: choice.label, size: 'sm', led: chosen.has(choice.id), pressed: chosen.has(choice.id), attrs: act('value-choice', choice.id) })).join('');
      return `<span class="op-ring-valuefields"><span class="op-ring-keyset"><span class="op-keycap-row">${keys}</span>${pearlLegend('Picked from, at random')}</span></span>`;
    }
    const text = source.choices.map((item) => formatValue(item, descriptor)).join('; ');
    return `<span class="op-ring-valuefields"><span class="op-ring-keyset">${pearlLcd({ value: text, input: true, size: 'list', ariaLabel: 'Values, separated by semicolons', attrs: `${act('value-list')} data-ring-focus="value-list"` })}${pearlLegend('Values · separated by ;')}</span>${bounds}</span>`;
  }
  if (descriptor.type === VALUE_TYPE.choice) {
    const options = descriptor.choices.map((choice) => optionTag(choice.id, choice.label, source.fixed.type === VALUE_TYPE.choice && source.fixed.value === choice.id)).join('');
    const none = source.fixed.type === VALUE_TYPE.choice ? '' : optionTag('', '— Choose —', true);
    return `<span class="op-ring-valuefields"><span class="op-ring-keyset">${selectBox(`${none}${options}`, `${act('value-fixed')} data-ring-focus="value-fixed"`, 'Value', 'op-select--wide')}${pearlLegend('Value')}</span></span>`;
  }
  if (descriptor.type === VALUE_TYPE.boolean) {
    const on = source.fixed.type === VALUE_TYPE.boolean && source.fixed.value;
    return `<span class="op-ring-valuefields"><span class="op-ring-keyset"><span class="op-keycap-row">${pearlKeycap({ label: 'Off', size: 'sm', state: on ? '' : 'lit', pressed: !on, attrs: act('value-fixed', 'off') })}${pearlKeycap({ label: 'On', size: 'sm', state: on ? 'lit' : '', pressed: on, attrs: act('value-fixed', 'on') })}</span>${pearlLegend('Value')}</span></span>`;
  }
  return `<span class="op-ring-valuefields">${field(formatValue(source.fixed, descriptor), 'value-fixed', 'Value', 'value-fixed')}${bounds}</span>`;
}

function renderCell(view) {
  const { cell, channel, cellIndex } = view;
  const descriptor = view.find(channel.target.target, channel.target.command);
  const takesValue = descriptor && descriptor.type !== VALUE_TYPE.none;
  const numeric = descriptor?.type === VALUE_TYPE.integer || descriptor?.type === VALUE_TYPE.number;
  const modes = [['Fixed', VALUE_MODE.fixed, takesValue], ['Range', VALUE_MODE.range, numeric], ['List', VALUE_MODE.choice, takesValue]]
    .map(([label, mode, allowed]) => pearlKeycap({ label, size: 'sm', state: cell.value.mode === mode ? 'lit' : '', pressed: cell.value.mode === mode, disabled: !allowed, attrs: act('value-mode', mode) }))
    .join('');
  const chips = cell.conditions.map((condition, i) => `<span class="op-chip">${escapeHtml(conditionLabel(condition))}<button type="button" class="op-x" aria-label="${escapeHtml(`Remove ${conditionLabel(condition)}`)}" ${act('cond-remove', i)}>×</button></span>`).join('');
  const addOptions = CONDITION_CHOICES.map((choice) => optionTag(choice.id, choice.label, false)).join('');
  const channels = Array.from({ length: CHANNEL_COUNT }, (_, i) => optionTag(i, channelName(i), i === view.conditionChannel)).join('');
  const add = `<span class="op-ring-condadd">
      ${selectBox(`${optionTag('', '+ Add a condition', true)}${addOptions}`, `${act('cond-add')} data-ring-focus="cond-add"`, 'Add a condition')}
      ${selectBox(channels, `${act('cond-channel')} data-ring-focus="cond-channel"`, 'The channel a condition watches')}
    </span>`;
  const locks = [['Active', MUTABLE.enabled], ['Prob', MUTABLE.probability], ['Value', MUTABLE.value]]
    .map(([label, bit]) => pearlKeycap({ label, size: 'sm', led: (cell.lockedFields & bit) !== 0, pressed: (cell.lockedFields & bit) !== 0, title: `MUTATE leaves this cell's ${label.toLowerCase()} alone`, attrs: act('lock-field', bit) }))
    .join('');
  return `<div class="op-panel-head"><span class="op-label accent">Cell ${cellIndex + 1}</span><span class="op-hint">${channelName(view.channelIndex)} · ${escapeHtml(describeCell(cell, channel, descriptor))}${cellIndex >= channel.length ? ' · past the channel\'s length, not played' : ''}</span></div>
    <div class="op-ring-cellgrid">
      <div class="op-ring-control">${pearlKeycap({ label: cell.enabled ? 'On' : 'Off', size: 'lg', state: cell.enabled ? 'lit' : '', pressed: cell.enabled, attrs: act('active') })}${pearlLegend('Active')}</div>
      ${knobControl('probability', knobValue('probability', channel, cell))}
      <div class="op-ring-field"><span class="op-label">Value</span><span class="op-keycap-row">${modes}</span>${valueFields(view, cell, descriptor)}</div>
      <div class="op-ring-cellwide">
        <div class="op-ring-field"><span class="op-label">Conditions · all of them, then the probability</span><div class="op-chips">${chips}${add}</div></div>
        <span class="op-spacer"></span>
        <div class="op-ring-field"><span class="op-label">Locks</span><span class="op-keycap-row">${pearlKeycap({ label: 'Lock cell', size: 'sm', led: cell.locked, pressed: cell.locked, title: 'MUTATE leaves this cell alone', attrs: act('lock-cell') })}${locks}</span></div>
      </div>
    </div>`;
}

// ---------- follow actions ----------

function draftValueControl(view, descriptor) {
  const draft = view.followDraft;
  if (!descriptor || descriptor.type === VALUE_TYPE.none) return pearlLcd({ value: '—', dim: true });
  if (descriptor.type === VALUE_TYPE.choice) {
    const options = descriptor.choices.map((choice) => optionTag(choice.id, choice.label, String(choice.id) === String(draft.value))).join('');
    return selectBox(options, `${act('follow-value')} data-ring-focus="follow-value"`, 'Value');
  }
  if (descriptor.type === VALUE_TYPE.boolean) {
    return selectBox(`${optionTag('on', 'On', draft.value !== 'off')}${optionTag('off', 'Off', draft.value === 'off')}`, `${act('follow-value')} data-ring-focus="follow-value"`, 'Value');
  }
  return pearlLcd({ value: draft.value ?? '', input: true, ariaLabel: `Value, ${descriptor.minimum} to ${descriptor.maximum}`, attrs: `${act('follow-value')} placeholder="${escapeHtml(`${descriptor.minimum}–${descriptor.maximum}`)}" data-ring-focus="follow-value"` });
}

function renderFollow(view) {
  const { channel } = view;
  const hint = channel.repeats === 0
    ? 'never run: the channel loops forever until it has a repeat count'
    : `after ${channel.repeats} ${channel.repeats === 1 ? 'loop' : 'loops'}, in this order`;
  const rows = channel.follow.map((action, i) => {
    const described = describeAction(view, action);
    const value = formatValue(action.value.fixed, described.descriptor);
    return `<li><span class="op-ring-follow-index">${i + 1}</span>${pearlScribble(described.text, { missing: described.missing, accent: value, title: `${described.text}${value ? ` ${value}` : ''}` })}<button type="button" class="op-x" aria-label="${escapeHtml(`Remove action ${i + 1}`)}" ${act('follow-remove', i)}>×</button></li>`;
  }).join('');
  const draft = view.followDraft;
  const descriptor = view.find(draft.target, draft.command);
  const ready = !!(draft.target && draft.command && descriptor);
  return `<div class="op-panel-head"><span class="op-label accent">Follow actions</span><span class="op-hint">${escapeHtml(hint)}</span></div>
    <ol>${rows || '<li class="op-ring-follow-empty">No follow actions.</li>'}</ol>
    <div class="op-ring-followadd">
      ${targetSelect(view, draft.target, `${act('follow-target')} data-ring-focus="follow-target"`, 'Action target')}
      ${commandSelect(view, draft.target, draft.command, `${act('follow-command')} data-ring-focus="follow-command"`, 'Action command')}
      ${draftValueControl(view, descriptor)}
      ${pearlKeycap({ label: '+ Add', size: 'sm', disabled: !ready, attrs: act('follow-add') })}
    </div>`;
}

// ---------- the page ----------

/** Each region's inner markup, by name. */
export function renderRegions(view) {
  return {
    deck: renderDeck(view),
    channels: renderChannels(view),
    channel: renderChannel(view),
    cell: renderCell(view),
    follow: renderFollow(view)
  };
}

export function renderPage(view, regions = renderRegions(view)) {
  return `<div class="omni-pearl op-module op-ring" data-one-ring>
    <div class="op-module-header"><span class="op-module-glyph">${icon(view.icon, 22)}</span>
      <h1 class="op-module-title">${escapeHtml(view.name)}</h1><span class="op-spacer"></span>
      <button type="button" id="node-delete" class="op-btn op-btn--danger">Delete Node</button></div>
    <section class="op-ring-deck" aria-label="Transport, scenes and randomness" data-ring-region="deck">${regions.deck}</section>
    <div class="op-ring-body">
      <section class="op-panel op-ring-channels" aria-label="Channels" data-ring-region="channels">${regions.channels}</section>
      <div class="op-ring-editor">
        <section class="op-panel op-ring-channel" aria-label="The channel edited" data-ring-region="channel">${regions.channel}</section>
        <div class="op-ring-lower">
          <section class="op-panel op-ring-cell" aria-label="The cell edited" data-ring-region="cell">${regions.cell}</section>
          <section class="op-panel op-ring-follow" aria-label="Follow actions" data-ring-region="follow">${regions.follow}</section>
        </div>
      </div>
    </div>
  </div>`;
}
