import { escapeHtml } from '../core/html.js';
import {
  MINILAB_CONTROL_SOURCES,
  MINILAB_SURFACE_BOX,
  getMiniLabControlLayout
} from '../midi/minilabControls.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * The secondary function printed under each pad. Still in code, and named here
 * so it is not mistaken for an oversight: it is hardware text with no field in
 * the profile format yet, and no second device to prove what that field should
 * be. It goes when the Patch Bay node becomes generic, Étape B.
 */
const PAD_FUNCTION_LABELS = ['Arp', 'Pad', 'Prog', 'Loop', 'Stop', 'Play', 'Record', 'Tap'];

const positioned = (source, extra = {}) =>
  Object.freeze({ ...source, ...getMiniLabControlLayout(source.key), ...extra });

const ofFamily = (family) => MINILAB_CONTROL_SOURCES.filter((source) => source.family === family);

/**
 * One physical layout drives both the Patch Bay SVG and the Hub HTML/SVG view --
 * and every coordinate in it now comes from the profile, not from a formula.
 *
 * What the formula used to encode: `155 + (index % 4) * 52` assumed four knobs
 * per row, the pads assumed a single row, and the faders carried a vertical
 * offset keyed on the strings 'f2' and 'f4'. All three were hardware facts
 * written as arithmetic, so a device with three knobs per row could not be drawn
 * at all. Specification section 6.3: the MiniLab becomes the first profile to
 * supply its coordinates instead of a special case in the code.
 */
export const MINILAB_SURFACE_LAYOUT = Object.freeze({
  width: MINILAB_SURFACE_BOX.width,
  height: MINILAB_SURFACE_BOX.height,
  knobs: Object.freeze(ofFamily('knob').map((source) => positioned(source))),
  faders: Object.freeze(ofFamily('fader').map((source) => positioned(source))),
  pads: Object.freeze(ofFamily('pad').map((source, index) =>
    positioned(source, { functionLabel: PAD_FUNCTION_LABELS[index] || source.label })))
});

const sourceByKey = (key) => MINILAB_CONTROL_SOURCES.find((source) => source.key === key);

/**
 * Where a control's port sits, given where the control sits.
 *
 * The profile says where the control is; `family` says what shape is drawn there,
 * and the shape is what decides where its socket hangs. Specification section
 * 4.4, in one line: family governs the shape, layout governs the position.
 *
 * The faders' vertical stagger is decoration, not hardware -- alternate caps sit
 * lower so a row of four does not read as one flat line. It used to be written
 * as `key === 'f2' || key === 'f4'`, which is the same decoration with two
 * hardware names baked into it.
 */
const FADER_STAGGER = 24;
const PORT_ANCHOR_BY_FAMILY = Object.freeze({
  knob: () => ({ x: 15, y: 0 }),
  fader: (index) => ({ x: 13, y: index % 2 === 1 ? FADER_STAGGER : 0 }),
  pad: () => ({ x: 11, y: 10 })
});

export function miniLabPatchPortPosition(portId) {
  const source = MINILAB_CONTROL_SOURCES.find((item) => item.portId === portId);
  if (!source) return null;
  const layout = getMiniLabControlLayout(source.key);
  if (!layout) return null;
  const anchor = PORT_ANCHOR_BY_FAMILY[source.family];
  if (!anchor) return { x: layout.x, y: layout.y };
  const offset = anchor(ofFamily(source.family).findIndex((item) => item.id === source.id));
  return { x: layout.x + offset.x, y: layout.y + offset.y };
}

/**
 * What the Patch Bay needs to draw this device as a surface rather than as a
 * stack of ports: the box the coordinates live in, and where each port hangs
 * inside it. Data only -- `core/network.js` carries it on the node, and
 * `core/nodeGeometry.js` reads it instead of testing the node's identity.
 */
export const MINILAB_SURFACE = Object.freeze({
  width: MINILAB_SURFACE_BOX.width,
  height: MINILAB_SURFACE_BOX.height,
  ports: Object.freeze(Object.fromEntries(MINILAB_CONTROL_SOURCES.map((source) =>
    [source.portId, Object.freeze(miniLabPatchPortPosition(source.portId))])))
});

function stateFor(states, id) {
  const value = states?.[id];
  return typeof value === 'string' && value ? value : 'idle';
}

/** Shared Hub/Learn representation. Routing and Learn ownership stay with callers. */
export function miniLabControlSurfaceHtml({ states = {}, selectedId = null } = {}) {
  const knobs = MINILAB_SURFACE_LAYOUT.knobs.map((control) => {
    const state = stateFor(states, control.id);
    const selected = selectedId === control.id;
    return `<button type="button" class="ml-surface-knob state-${escapeHtml(state)}${selected ? ' selected' : ''}"
      data-minilab-control-id="${control.id}" data-source-control-id="${control.id}"
      aria-label="${control.label}" aria-pressed="${selected ? 'true' : 'false'}">
      <span class="ml-knob-cap"></span><span>${control.label}</span>
    </button>`;
  }).join('');
  const attrs = (control) => `data-minilab-control-id="${control.id}" data-source-control-id="${control.id}" aria-pressed="${selectedId === control.id ? 'true' : 'false'}"`;
  const classes = (control, base) => `${base} state-${escapeHtml(stateFor(states, control.id))}${selectedId === control.id ? ' selected' : ''}`;
  const faders = MINILAB_SURFACE_LAYOUT.faders.map((control) => `<button type="button" class="${classes(control, 'ml-surface-fader')}" ${attrs(control)}><i></i><b>${control.label}</b></button>`).join('');
  const pads = MINILAB_SURFACE_LAYOUT.pads.map((control) => `<button type="button" class="${classes(control, 'ml-surface-pad')}" ${attrs(control)}><small>${control.label}</small><b>${control.functionLabel}</b></button>`).join('');
  const pitch = sourceByKey('pitch-bend');
  const mod = sourceByKey('modulation');
  const main = sourceByKey('main-encoder');
  const mainClick = sourceByKey('main-click');
  const shift = sourceByKey('shift');
  return `<div class="minilab-control-surface" data-minilab-surface="learn">
    <div class="ml-utility"><button type="button" class="${classes(shift, 'ml-utility-control')}" ${attrs(shift)}>SHIFT</button><span>HOLD</span><span>OCT −</span><span>OCT +</span></div>
    <div class="ml-display"><small>PAD 1 · C1</small><strong>36</strong><i aria-hidden="true"></i></div>
    <div class="ml-main-encoder"><button type="button" class="${classes(main, 'ml-main-turn')}" ${attrs(main)}>MAIN</button><button type="button" class="${classes(mainClick, 'ml-main-click')}" ${attrs(mainClick)}>CLICK</button></div>
    <div class="ml-strips"><button type="button" class="${classes(pitch, 'ml-strip-control')}" ${attrs(pitch)}><i></i><b>PITCH</b></button><button type="button" class="${classes(mod, 'ml-strip-control')}" ${attrs(mod)}><i></i><b>MOD</b></button></div>
    <div class="ml-knobs">${knobs}</div><div class="ml-faders">${faders}</div>
    <div class="ml-pads">${pads}</div>
  </div>`;
}

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  Object.entries(attrs).forEach(([key, value]) => el.setAttribute(key, value));
  return el;
}

/** Shared Patch Bay representation; port callbacks are supplied by the network view. */
export function appendMiniLabControlSurfaceSvg(parent, { buildPort, connectedPortIds = new Set() }) {
  const root = svgEl('g', { class: 'minilab-control-surface-svg', 'data-minilab-surface': 'patch-bay' });
  const addPort = (control) => {
    const position = miniLabPatchPortPosition(control.portId);
    if (!position) return;
    const holder = svgEl('g', { class: `ml-svg-control${connectedPortIds.has(control.portId) ? ' connected' : ''}`, 'data-source-control-id': control.id });
    holder.appendChild(buildPort(control, position.x, position.y));
    root.appendChild(holder);
  };
  root.appendChild(svgEl('rect', { class: 'ml-svg-body', x: 4, y: 3, width: 472, height: 173, rx: 8 }));
  const display = svgEl('rect', { class: 'ml-svg-display', x: 80, y: 12, width: 54, height: 90, rx: 3 });
  root.appendChild(display);
  ['SHIFT', 'HOLD', '−', '+'].forEach((label, i) => {
    root.appendChild(svgEl('rect', { class: 'ml-svg-utility', x: 9 + (i % 2) * 30, y: 18 + Math.floor(i / 2) * 25, width: 25, height: 14, rx: 3 }));
    const text = svgEl('text', { class: 'ml-svg-tiny', x: 21.5 + (i % 2) * 30, y: 28 + Math.floor(i / 2) * 25, 'text-anchor': 'middle' });
    text.textContent = label; root.appendChild(text);
  });
  ['PITCH', 'MOD'].forEach((label, i) => {
    root.appendChild(svgEl('rect', { class: 'ml-svg-strip', x: 12 + i * 31, y: 68, width: 20, height: 75, rx: 3 }));
    const text = svgEl('text', { class: 'ml-svg-tiny', x: 22 + i * 31, y: 154, 'text-anchor': 'middle' });
    text.textContent = label; root.appendChild(text);
  });
  root.appendChild(svgEl('circle', { class: 'ml-svg-knob', cx: 107, cy: 75, r: 13 }));
  addPort(sourceByKey('shift'));
  addPort(sourceByKey('pitch-bend'));
  addPort(sourceByKey('modulation'));
  addPort(sourceByKey('main-encoder'));
  addPort(sourceByKey('main-click'));
  MINILAB_SURFACE_LAYOUT.knobs.forEach((control) => {
    const group = svgEl('g', { class: `ml-svg-control${connectedPortIds.has(control.portId) ? ' connected' : ''}`, 'data-source-control-id': control.id });
    group.appendChild(svgEl('circle', { class: 'ml-svg-knob', cx: control.x, cy: control.y, r: 10 }));
    const label = svgEl('text', { class: 'ml-svg-label', x: control.x, y: control.y + 22, 'text-anchor': 'middle' });
    label.textContent = control.label; group.appendChild(label);
    const position = miniLabPatchPortPosition(control.portId);
    group.appendChild(buildPort(control, position.x, position.y));
    root.appendChild(group);
  });
  MINILAB_SURFACE_LAYOUT.faders.forEach((control, faderIndex) => {
    root.appendChild(svgEl('rect', { class: 'ml-svg-fader', x: control.x, y: 24, width: 7, height: 65, rx: 3 }));
    root.appendChild(svgEl('rect', { class: 'ml-svg-fader-cap', x: control.x - 8, y: control.y - 4 + (faderIndex % 2 === 1 ? FADER_STAGGER : 0), width: 23, height: 8, rx: 3 }));
    const label = svgEl('text', { class: 'ml-svg-label', x: control.x + 3, y: 104, 'text-anchor': 'middle' });
    label.textContent = control.label; root.appendChild(label);
    addPort(control);
  });
  MINILAB_SURFACE_LAYOUT.pads.forEach((control) => {
    root.appendChild(svgEl('rect', { class: 'ml-svg-pad', x: control.x, y: control.y, width: 22, height: 20, rx: 3 }));
    const label = svgEl('text', { class: 'ml-svg-tiny', x: control.x + 11, y: control.y + 13, 'text-anchor': 'middle' });
    label.textContent = control.functionLabel; root.appendChild(label);
    addPort(control);
  });
  parent.appendChild(root);
  return root;
}
