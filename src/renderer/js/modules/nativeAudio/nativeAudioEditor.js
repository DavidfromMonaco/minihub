import { followContentWrites, registerNodeEditor } from '../../core/nodeEditors.js';
import { escapeHtml } from '../../core/html.js';
import { formatGainDb, formatPan } from '../../core/stripValues.js';
import { icon } from '../../ui/icons.js';
import {
  bindDragKnobs, pearlDragKnob, pearlKeycap, pearlLcd, pearlLegend, pearlScribble, pearlSelector, syncDragKnob
} from '../../ui/omniPearl.js';

/**
 * The Mixer's and the Morpher's page: one page for two types, because both are
 * an ordered list of AUDIO IN rows computed by the native audio network. The
 * Mixer adds a pan per row and a master level; the Morpher adds its steps.
 *
 * It wears the faceplate, as One Ring does (the author, 2026-09-27): each AUDIO
 * IN is a console strip -- what it hears on a scribble strip, a pan knob, a
 * fader, its level read out, a MUTE key -- and the Mixer's master is a strip of
 * its own after them.
 *
 * The controls write `instance.content` in place, where `engineSync` reads it.
 */

/**
 * Coalescing window for the continuous controls (levels, pans, master level,
 * Morpher steps). Long enough to collapse a drag into a single settings write
 * and a single native network republish, short enough to stay imperceptible
 * when the user simply clicks a fader.
 */
const NATIVE_VALUE_COALESCE_MS = 120;

const MORPHER_STEP_COUNTS = [4, 8, 16, 32];
const PAN_RANGE = { min: -100, max: 100 };

const pad2 = (n) => String(n).padStart(2, '0');

/** A level fader: a real range input, stood up. `attrs` carries its hooks. */
function fader(value, attrs, ariaLabel) {
  return `<span class="op-fader-well">
      <span class="op-fader-scale" aria-hidden="true"></span>
      <input class="op-fader" type="range" min="0" max="2" step="0.01" value="${value}" aria-label="${escapeHtml(ariaLabel)}" ${attrs}>
    </span>`;
}

function panKnob(input, index) {
  const value = Math.round((input.pan || 0) * 100);
  return pearlDragKnob({
    value, ...PAN_RANGE, bipolar: true, ariaLabel: `Input ${index + 1} pan`, text: formatPan(input.pan),
    attrs: 'data-native-control="pan" title="Drag up or down · double-click: centre"'
  });
}

/** The node an AUDIO IN hears, by its name on screen, or nothing. */
function sourceName({ hub, manager }, connection) {
  if (!connection) return '';
  const id = connection.from.nodeId;
  return manager.get(id)?.name || hub.network.getNode(id)?.name || id;
}

function renderStrip(context, input, index, connection) {
  const mixer = context.type.id === 'mixer';
  const source = sourceName(context, connection);
  const pan = mixer
    ? `<div class="op-channel-pan">${panKnob(input, index)}
        ${pearlLcd({ value: formatPan(input.pan), size: 'sm', attrs: 'data-pan-value' })}</div>`
    : '';
  return `
    <div class="op-channel" data-audio-input="${escapeHtml(input.id)}">
      <span class="op-channel-num">${pad2(index + 1)}</span>
      ${pearlScribble(source || 'no cable', { empty: !source, title: source ? `AUDIO IN ${index + 1} hears ${source}` : `AUDIO IN ${index + 1} is not cabled` })}
      ${pan}
      ${fader(input.level, 'data-native-control="level"', `Input ${index + 1} level`)}
      ${pearlLcd({ value: formatGainDb(input.level), size: 'sm', attrs: 'data-level-value' })}
      ${pearlKeycap({
        label: 'Mute', size: 'sm word', state: input.muted ? 'lit' : '', pressed: input.muted === true,
        title: input.muted ? 'Muted: click to hear it' : 'Mute this input', attrs: 'data-native-control="mute"'
      })}
    </div>`;
}

function renderMaster(content) {
  return `
    <div class="op-channel op-channel--master">
      <span class="op-channel-num">${pearlLegend('Master', { state: 'on' })}</span>
      ${fader(content.masterLevel, 'data-native-control="masterLevel"', 'Master level')}
      ${pearlLcd({ value: formatGainDb(content.masterLevel), size: 'sm', attrs: 'data-master-value' })}
      <span class="op-channel-foot" aria-hidden="true"></span>
    </div>`;
}

/** The Morpher's steps: how many, and one small fader each, lit while it plays. */
function renderMorph(content) {
  const counts = MORPHER_STEP_COUNTS.map((n) => ({ value: n, label: String(n) }));
  const steps = content.steps.slice(0, content.stepCount).map((value, i) => `
    <label class="op-morph-step" data-morph-step="${i}">
      <span class="op-led"></span>
      <span class="op-fader-well op-fader-well--sm">
        <input class="op-fader op-fader--sm" type="range" min="0" max="1" step="0.01" value="${value}" aria-label="Step ${i + 1}" data-native-step="${i}">
      </span>
      ${pearlLegend(String(i + 1))}
    </label>`).join('');
  return `
    <div class="op-panel-head"><span class="op-label accent">Morph</span><span class="op-hint">The steps share four beats · the lit one is playing</span></div>
    <div class="op-morph">
      <div class="op-morph-count">
        ${pearlSelector({ options: counts, value: content.stepCount, optionAttr: 'data-morph-count', ariaLabel: 'Steps', attrs: 'data-native-control="stepCount"' })}
        ${pearlLegend('Steps')}
      </div>
      <div class="op-morph-steps">${steps}</div>
    </div>`;
}

function render(context) {
  const { instance, type, hub } = context;
  const content = instance.content;
  const connections = hub.network.connectionsTo(instance.id);
  const strips = content.inputs
    .map((input, index) => renderStrip(context, input, index, connections.find((c) => c.to.portId === input.id)))
    .join('');
  const morph = type.id === 'morpher'
    ? `<section class="op-panel" aria-label="Morph steps" data-morph-panel>${renderMorph(content)}</section>`
    : '';
  return `<div class="omni-pearl op-module op-console" data-native-editor="${type.id}">
    <div class="op-module-header"><span class="op-module-glyph">${icon(type.icon, 22)}</span>
      <h1 class="op-module-title">${escapeHtml(instance.name)}</h1><span class="op-spacer"></span>
      <button type="button" id="node-delete" class="op-btn op-btn--danger">Delete Node</button></div>
    <section class="op-panel" aria-label="Audio inputs">
      <div class="op-panel-head"><span class="op-label accent">Inputs</span><span class="op-hint">In the order of the AUDIO IN rows · a new one appears when every row is cabled</span></div>
      <div class="op-console-strips">${strips}${type.id === 'mixer' ? renderMaster(content) : ''}</div>
    </section>
    ${morph}
  </div>`;
}

/** The Morpher step the transport is in: four beats cover the steps shown. */
function activeMorphStep(ppqPosition, stepCount) {
  const phase = (((Number(ppqPosition) || 0) % 4) + 4) % 4 / 4;
  return Math.min(stepCount - 1, Math.floor(phase * stepCount));
}

function bind(container, context) {
  const { instance, type, hub, manager } = context;
  const content = () => instance.content;
  const setText = (selector, root, text) => {
    const shown = root?.querySelector(selector);
    if (shown) shown.textContent = text;
  };
  const inputOf = (element) => {
    const row = element?.closest?.('[data-audio-input]');
    const item = row && content().inputs.find((p) => p.id === row.dataset.audioInput);
    return item ? { row, item } : null;
  };

  // A fader fires `input` on every pixel of a drag. Each one used to run a
  // full synchronous settings write AND a complete native audio network
  // recompile - measured at up to 37 recompiles per second in the runtime log,
  // every one of them resetting the PDC delay lines. The model is still updated
  // on the spot so the page stays live; only the persistence and the native
  // republish are coalesced, and the gesture's end flushes them immediately.
  let timer = null;
  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    manager.persist();
    hub.events.emit('nativeAudio:stateChanged', { nodeId: instance.id });
  };
  const schedule = (immediate) => {
    if (immediate) {
      flush();
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, NATIVE_VALUE_COALESCE_MS);
  };

  const repaintMorph = () => {
    const panel = container.querySelector('[data-morph-panel]');
    if (panel) panel.innerHTML = renderMorph(content());
  };

  const setStepCount = (value) => {
    const count = Number(value);
    if (!MORPHER_STEP_COUNTS.includes(count) || content().stepCount === count) return;
    content().stepCount = count;
    repaintMorph();
    schedule(true);
  };

  const setPan = (knob, value, final) => {
    const found = inputOf(knob);
    if (!found) return;
    found.item.pan = value / 100;
    syncDragKnob(knob, { value, ...PAN_RANGE, bipolar: true, text: formatPan(found.item.pan) });
    setText('[data-pan-value]', found.row, formatPan(found.item.pan));
    schedule(final);
  };

  const onInput = (e) => {
    const control = e.target.dataset.nativeControl;
    if (control === 'level') {
      const found = inputOf(e.target);
      if (!found) return;
      found.item.level = Number(e.target.value);
      // The value beside the fader, as the author asked: a Mixer read by ear
      // alone is a Mixer set twice.
      setText('[data-level-value]', found.row, formatGainDb(found.item.level));
    } else if (control === 'masterLevel') {
      content().masterLevel = Number(e.target.value);
      setText('[data-master-value]', container, formatGainDb(content().masterLevel));
    } else if (control === 'stepCount') {
      if (e.type === 'change') setStepCount(e.target.value);
      return;
    } else if (e.target.dataset.nativeStep) {
      content().steps[Number(e.target.dataset.nativeStep)] = Number(e.target.value);
    } else {
      return;
    }
    schedule(e.type === 'change');
  };

  const onClick = (e) => {
    const mute = e.target.closest?.('[data-native-control="mute"]');
    if (mute) {
      const found = inputOf(mute);
      if (!found) return;
      found.item.muted = !found.item.muted;
      mute.classList.toggle('is-lit', found.item.muted);
      mute.setAttribute('aria-pressed', found.item.muted ? 'true' : 'false');
      mute.title = found.item.muted ? 'Muted: click to hear it' : 'Mute this input';
      schedule(true);
      return;
    }
    // A printed position of the step selector.
    const count = e.target.closest?.('[data-morph-count]');
    if (count) setStepCount(count.dataset.morphCount);
  };

  // A double-click centres a strip's pan, as it does a track's.
  const onDoubleClick = (e) => {
    const knob = e.target.closest?.('[data-native-control="pan"]');
    if (knob) setPan(knob, 0, true);
  };

  const listeners = [['input', onInput], ['change', onInput], ['click', onClick], ['dblclick', onDoubleClick]];
  for (const [name, listener] of listeners) container.addEventListener(name, listener);

  const offs = [
    bindDragKnobs(container, { onValue: setPan }),
    followContentWrites(container, hub, instance.id, () => {
      if (manager.get(instance.id)) container.innerHTML = render(context);
    })
  ];
  if (type.id === 'morpher') {
    offs.push(hub.events.on('engine:transport', (transport) => {
      const active = activeMorphStep(transport.ppqPosition, content().stepCount);
      container.querySelectorAll('[data-morph-step]').forEach((el) => {
        const on = Number(el.dataset.morphStep) === active;
        el.classList.toggle('active', on);
        el.querySelector('.op-led')?.classList.toggle('is-on', on);
      });
    }));
  }

  return () => {
    // Closing the page saves a drag still waiting, and republishes nothing
    // when nobody edited.
    if (timer) flush();
    for (const [name, listener] of listeners) container.removeEventListener(name, listener);
    for (const off of offs) off();
  };
}

/** Install both pages. Returns one function unregistering both. */
export function registerNativeAudioEditors() {
  const offs = ['mixer', 'morpher'].map((typeId) => registerNodeEditor(typeId, { render, bind }));
  return () => offs.forEach((off) => off());
}
