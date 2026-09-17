import { escapeHtml } from '../../core/html.js';
import { VALUE_TYPE } from '../../core/commandRegistry.js';
import {
  CHANNEL_COUNT, LENGTHS, MAX_STEPS, MUTABLE, REPEATS, RESOLUTIONS, SCENES_PER_BANK, SCENE_BANKS, SCENE_POSITION,
  SCENE_TIMING, STEP_MODE, VALUE_MODE, cellsOf, sceneIndex, scenePlace
} from '../../core/oneRingSequence.js';
import { pearlKeycap, pearlLcd, pearlLed, pearlLegend, pearlScribble } from '../../ui/omniPearl.js';
import { icon } from '../../ui/icons.js';
import { CONDITION_CHOICES, conditionLabel, describeCell, formatValue } from '../../core/oneRingEdits.js';
import {
  act, channelName, commandSelect, describeAction, glyphs, knobControl, optionTag, pad2, selectBox, selectorControl,
  targetSelect
} from './oneRingParts.js';
import { renderCapture, renderMaterial, renderVoices, renderWriter } from './oneRingNotes.js';

export { KNOBS, channelName, commandLabel, describeAction, targetLabel } from './oneRingParts.js';

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
 *
 * THE TABS
 * --------
 * Part two gave the node as much again to show -- what it captures, what it
 * plays notes from, its four voices, what it writes -- and the page had no room
 * left, so below the deck the page has four tabs, as a hardware sequencer has
 * mode keys: SEQUENCE is the page as it was, MEMORY, VOICES and WRITER are
 * part two's (oneRingNotes.js). The deck stays above them all. The body is a
 * region of its own that changes only with the tab; each tab's panels are
 * regions inside it.
 */

// ---------- deck ----------

/** The letter whose eight scenes the deck shows: the one asked for, or the scene's own. */
export function shownBank(view) {
  return view.bank ?? scenePlace(view.content.scenes[view.scene]?.id)?.bank ?? SCENE_BANKS[0];
}

/**
 * A letter row and a number row, as a hardware sequencer's banks and
 * patterns. A number with no scene is dark; pressed, it becomes one.
 */
function renderScenes(view) {
  const { content, scene } = view;
  const current = content.scenes[scene];
  const bank = shownBank(view);
  const playingBank = scenePlace(current.id)?.bank;
  const letters = SCENE_BANKS.map((letter) => pearlKeycap({
    label: letter, size: 'sq', state: letter === bank ? 'white' : '', led: letter === playingBank, pressed: letter === bank,
    title: `The scenes of ${letter}`, attrs: `${act('bank', letter)} data-ring-bank="${letter}"`
  })).join('');
  const store = pearlKeycap({ label: 'Store', size: 'sq word', state: view.storeArmed ? 'lit' : '', title: 'Store this scene into another place', pressed: view.storeArmed, attrs: act('store') });
  const numbers = Array.from({ length: SCENES_PER_BANK }, (_, n) => {
    const place = `${bank}${n + 1}`;
    const index = sceneIndex(content, place);
    const here = index === scene;
    const state = here ? 'lit' : view.storeArmed ? 'armed' : index >= 0 ? '' : 'dim';
    const title = view.storeArmed && !here ? `Store ${current.id} into ${place}`
      : index >= 0 ? content.scenes[index].name : `${place} is empty: press to make it`;
    const hook = index >= 0 ? ` data-ring-scene="${index}"` : '';
    return pearlKeycap({ label: String(n + 1), size: 'num', state, title, pressed: here, attrs: `${act('place', place)}${hook}` });
  }).join('');
  const legend = view.storeArmed ? `Store ${current.id} into a place` : '';
  return `<div class="op-ring-group">
      <span class="op-label">Scenes</span>
      <div class="op-ring-scenes">
        <div class="op-ring-keys">${letters}<span class="op-ring-store">${store}</span></div>
        <div class="op-ring-keys op-ring-numbers" aria-label="${escapeHtml(`The scenes of ${bank}`)}">${numbers}</div>
        <span class="op-legend accent" data-ring-live="scene-legend">${escapeHtml(legend) || '&nbsp;'}</span>
      </div>
    </div>`;
}

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
  const scenes = renderScenes(view);
  const nextBar = content.sceneTiming === SCENE_TIMING.nextBar;
  const keep = content.scenePosition === SCENE_POSITION.keep;
  const deckLever = (name, left, right, on) => `${pearlLegend(left, { state: on ? '' : 'on', attrs: act(name, 0) })}
    <label class="op-switch op-switch--sm"><input class="op-native" type="checkbox" aria-label="${escapeHtml(`${left} or ${right}`)}"${on ? ' checked' : ''} ${act(`${name}-toggle`)}><span class="op-switch-track"><span class="op-switch-thumb"></span></span></label>
    ${pearlLegend(right, { state: on ? 'on' : '', attrs: act(name, 1) })}`;
  const recall = `<div class="op-ring-group">
      <span class="op-label">Scene recall</span>
      <div class="op-ring-recall">
        ${pearlLegend('Timing')}${deckLever('timing', 'Now', 'Next bar', nextBar)}
        ${pearlLegend('Channels')}${deckLever('position', 'Restart', 'Keep', keep)}
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
      ${knobControl('offset', view)}
      ${knobControl('swing', view)}
      ${knobControl('humanize', view)}
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
      ${knobControl('probability', view)}
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

// ---------- the tabs ----------

export const TABS = Object.freeze([
  { id: 'sequence', label: 'Sequence', hint: 'The sixteen channels, their cells and follow actions' },
  { id: 'memory', label: 'Memory', hint: 'What MIDI IN captures, and the notes the voices play from' },
  { id: 'voices', label: 'Voices', hint: 'The four voices and what each does to the notes, in this scene' },
  { id: 'writer', label: 'Writer', hint: 'Generations written into the Sequencer, and feedback' }
]);
const TAB_IDS = TABS.map((tab) => tab.id);
/** Each tab's panels, in the order they are drawn. */
export const TAB_REGIONS = Object.freeze({
  sequence: ['channels', 'channel', 'cell', 'follow'],
  memory: ['capture', 'material'],
  voices: ['voices'],
  writer: ['writer']
});
const RENDER = {
  channels: renderChannels,
  channel: renderChannel,
  cell: renderCell,
  follow: renderFollow,
  capture: renderCapture,
  material: renderMaterial,
  voices: renderVoices,
  writer: renderWriter
};

export const tabOf = (view) => (TAB_IDS.includes(view.tab) ? view.tab : 'sequence');

function renderTabs(view) {
  const tab = tabOf(view);
  // The hint is a tooltip only: a tab is named by its label.
  return TABS.map((item) => pearlKeycap({
    label: item.label, size: 'tab', state: item.id === tab ? 'white' : '',
    led: item.id === 'sequence' ? null : false, ledAttrs: `data-ring-live-tab="${item.id}"`,
    attrs: `${act('tab', item.id)} role="tab" aria-selected="${item.id === tab}" title="${escapeHtml(item.hint)}"`
  })).join('');
}

/** A tab's body, its panels filled from `regions`: empty ones make the skeleton a redraw compares. */
export function bodyMarkup(tab, regions = {}) {
  const panel = (name, label, extra = '') => `<section class="op-panel op-ring-${name}${extra}" aria-label="${label}" data-ring-region="${name}">${regions[name] ?? ''}</section>`;
  switch (tab) {
    case 'memory':
      return `<div class="op-ring-body op-ring-body--memory">${panel('capture', 'Capture')}${panel('material', 'Material')}</div>`;
    case 'voices':
      return `<div class="op-ring-body op-ring-body--single">${panel('voices', 'Voices')}</div>`;
    case 'writer':
      return `<div class="op-ring-body op-ring-body--single">${panel('writer', 'Writer')}</div>`;
    default:
      return `<div class="op-ring-body">
      ${panel('channels', 'Channels')}
      <div class="op-ring-editor">
        ${panel('channel', 'The channel edited')}
        <div class="op-ring-lower">${panel('cell', 'The cell edited')}${panel('follow', 'Follow actions')}</div>
      </div>
    </div>`;
  }
}

// ---------- the page ----------

/** Each region's inner markup, by name: the deck, the tabs, the body's skeleton, then the tab's panels. */
export function renderRegions(view) {
  const tab = tabOf(view);
  const regions = { deck: renderDeck(view), tabs: renderTabs(view), body: bodyMarkup(tab) };
  for (const name of TAB_REGIONS[tab]) regions[name] = RENDER[name](view);
  return regions;
}

export function renderPage(view, regions = renderRegions(view)) {
  return `<div class="omni-pearl op-module op-ring" data-one-ring>
    <div class="op-module-header"><span class="op-module-glyph">${icon(view.icon, 22)}</span>
      <h1 class="op-module-title">${escapeHtml(view.name)}</h1><span class="op-spacer"></span>
      <button type="button" id="node-delete" class="op-btn op-btn--danger">Delete Node</button></div>
    <section class="op-ring-deck" aria-label="Transport, scenes and randomness" data-ring-region="deck">${regions.deck}</section>
    <nav class="op-ring-tabs" role="tablist" aria-label="Pages" data-ring-region="tabs">${regions.tabs}</nav>
    <div class="op-ring-bodyframe" data-ring-region="body">${bodyMarkup(tabOf(view), regions)}</div>
  </div>`;
}
