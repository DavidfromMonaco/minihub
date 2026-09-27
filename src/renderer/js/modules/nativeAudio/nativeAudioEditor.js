import { followContentWrites, registerNodeEditor } from '../../core/nodeEditors.js';
import { escapeHtml } from '../../core/html.js';
import { nodeFamily } from '../../core/nodeTypes.js';
import { formatGainDb, formatPan } from '../../core/stripValues.js';

/**
 * The Mixer's and the Morpher's page: one page for two types, because both are
 * an ordered list of AUDIO IN rows computed by the native audio network. The
 * Mixer adds a pan per row and a master level; the Morpher adds its steps.
 *
 * The controls write `instance.content` in place, where `engineSync` reads it.
 */

/**
 * Coalescing window for the continuous controls (levels, pans, mutes, master
 * level, Morpher steps). Long enough to collapse a drag into a single settings
 * write and a single native network republish, short enough to stay
 * imperceptible when the user simply clicks a slider.
 */
const NATIVE_VALUE_COALESCE_MS = 120;

const MORPHER_STEP_COUNTS = [4, 8, 16, 32];

function renderInputRow(input, index, type, sourceName) {
  const mixer = type.id === 'mixer';
  const levelValue = mixer ? formatGainDb(input.level) : '';
  const pan = mixer
    ? `<label title="Double-click: centre">Pan
        <input class="mixer-pan" data-native-control="pan" type="range" min="-100" max="100" step="1" value="${Math.round((input.pan || 0) * 100)}">
        <output class="mixer-value mixer-pan-value" data-pan-value>${formatPan(input.pan)}</output>
      </label>`
    : '';
  return `
    <div class="row mt-10" data-audio-input="${input.id}">
      <strong>${index + 1}</strong>
      <span class="muted">${escapeHtml(sourceName)}</span>
      <span class="spacer"></span>
      <label>Level
        <input data-native-control="level" type="range" min="0" max="2" step="0.01" value="${input.level}">
        <output class="mixer-value mixer-level-value" data-level-value>${levelValue}</output>
      </label>
      ${pan}
      <label><input data-native-control="mute" type="checkbox" ${input.muted ? 'checked' : ''}> Mute</label>
    </div>`;
}

function renderMorpherSteps(content) {
  const counts = MORPHER_STEP_COUNTS
    .map((n) => `<option ${content.stepCount === n ? 'selected' : ''}>${n}</option>`)
    .join('');
  const steps = content.steps.slice(0, content.stepCount)
    .map((value, i) => `<label data-morph-step="${i}"> ${i + 1}<input data-native-step="${i}" type="range" min="0" max="1" step="0.01" value="${value}"></label>`)
    .join('');
  return `
    <div class="row mt-16"><label>Steps <select data-native-control="stepCount">${counts}</select></label></div>
    <div class="morph-steps">${steps}</div>`;
}

function renderMaster(content) {
  return `
    <div class="row mt-16">
      <label>Master
        <input data-native-control="masterLevel" type="range" min="0" max="2" step="0.01" value="${content.masterLevel}">
        <output class="mixer-value mixer-level-value" data-master-value>${formatGainDb(content.masterLevel)}</output>
      </label>
    </div>`;
}

function render({ instance, type, hub }) {
  const content = instance.content;
  const connections = hub.network.connectionsTo(instance.id);
  const sourceFor = (portId) => connections.find((c) => c.to.portId === portId)?.from.nodeId || 'Unconnected';
  const rows = content.inputs.map((input, index) => renderInputRow(input, index, type, sourceFor(input.id))).join('');
  return `
    <div class="panel">
      <div class="row">
        <h1 class="page-title">${escapeHtml(instance.name)}</h1>
        <span class="spacer"></span>
        <span class="pill accent-${type.id} family-${nodeFamily(type.id)}">${type.label}</span>
      </div>
      <div class="panel mt-16">
        <h2 class="panel-title">Ordered Audio Inputs</h2>
        ${rows}
        ${type.id === 'morpher' ? renderMorpherSteps(content) : ''}
        ${type.id === 'mixer' ? renderMaster(content) : ''}
      </div>
      <div class="row mt-16">
        <span class="spacer"></span>
        <button id="node-delete" class="btn danger">Delete Node</button>
      </div>
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
    const shown = root.querySelector(selector);
    if (shown) shown.textContent = text;
  };

  // A `range` input fires `input` on every pixel of a drag. Each one used to
  // run a full synchronous settings write AND a complete native audio network
  // recompile - measured at up to 37 recompiles per second in the runtime log,
  // every one of them resetting the PDC delay lines. The model is still updated
  // on the spot so the UI stays live; only the persistence and the native
  // republish are coalesced, and the `change` that ends the gesture flushes
  // them immediately.
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

  const onInput = (e) => {
    const control = e.target.dataset.nativeControl;
    const row = e.target.closest('[data-audio-input]');
    const item = row && content().inputs.find((p) => p.id === row.dataset.audioInput);
    if (item && control === 'level') {
      item.level = Number(e.target.value);
      // The value beside the slider, as the author asked: a Mixer read by ear
      // alone is a Mixer set twice.
      if (type.id === 'mixer') setText('[data-level-value]', row, formatGainDb(item.level));
    }
    if (item && control === 'mute') item.muted = e.target.checked;
    if (item && control === 'pan') {
      item.pan = Number(e.target.value) / 100;
      setText('[data-pan-value]', row, formatPan(item.pan));
    }
    if (control === 'masterLevel') {
      content().masterLevel = Number(e.target.value);
      setText('[data-master-value]', container, formatGainDb(content().masterLevel));
    }
    if (control === 'stepCount') content().stepCount = Number(e.target.value);
    if (e.target.dataset.nativeStep) content().steps[Number(e.target.dataset.nativeStep)] = Number(e.target.value);
    schedule(e.type === 'change');
  };

  // A double-click centres a Mixer strip's pan, as it does a track's.
  const onDoubleClick = (e) => {
    if (e.target?.dataset?.nativeControl !== 'pan') return;
    e.target.value = '0';
    onInput({ target: e.target, type: 'change' });
  };

  const listeners = [['input', onInput], ['change', onInput], ['dblclick', onDoubleClick]];
  for (const [name, listener] of listeners) container.addEventListener(name, listener);

  const offs = [
    followContentWrites(container, hub, instance.id, () => {
      if (manager.get(instance.id)) container.innerHTML = render(context);
    })
  ];
  if (type.id === 'morpher') {
    offs.push(hub.events.on('engine:transport', (transport) => {
      const active = activeMorphStep(transport.ppqPosition, content().stepCount);
      container.querySelectorAll('[data-morph-step]')
        .forEach((el) => el.classList.toggle('active', Number(el.dataset.morphStep) === active));
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
