import { escapeHtml } from '../core/html.js';
import { MINILAB_CONTROL_SOURCES } from '../midi/minilabControls.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// One physical layout drives both the Patch Bay SVG and the Hub HTML/SVG view.
export const MINILAB_SURFACE_LAYOUT = Object.freeze({
  width: 480,
  height: 180,
  knobs: Object.freeze(MINILAB_CONTROL_SOURCES.filter((source) => source.family === 'knob').map((source, index) => Object.freeze({
    ...source,
    x: 155 + (index % 4) * 52,
    y: 43 + Math.floor(index / 4) * 48
  }))),
  faders: Object.freeze(MINILAB_CONTROL_SOURCES.filter((source) => source.family === 'fader').map((source, i) => Object.freeze({ ...source, x: 355 + i * 37, y: 63 }))),
  pads: Object.freeze(['Arp', 'Pad', 'Prog', 'Loop', 'Stop', 'Play', 'Record', 'Tap']
    .map((functionLabel, i) => Object.freeze({ ...MINILAB_CONTROL_SOURCES.find((source) => source.key === `p${i + 1}`), functionLabel, x: 90 + i * 48, y: 126 })))
});

const sourceByKey = (key) => MINILAB_CONTROL_SOURCES.find((source) => source.key === key);

export function miniLabPatchPortPosition(portId) {
  const source = MINILAB_CONTROL_SOURCES.find((item) => item.portId === portId);
  if (!source) return null;
  const knob = MINILAB_SURFACE_LAYOUT.knobs.find((item) => item.id === source.id);
  if (knob) return { x: knob.x + 15, y: knob.y };
  const fader = MINILAB_SURFACE_LAYOUT.faders.find((item) => item.id === source.id);
  if (fader) return { x: fader.x + 13, y: 63 + (source.key === 'f2' || source.key === 'f4' ? 24 : 0) };
  const pad = MINILAB_SURFACE_LAYOUT.pads.find((item) => item.id === source.id);
  if (pad) return { x: pad.x + 11, y: pad.y + 10 };
  return ({ shift: { x: 38, y: 25 }, 'pitch-bend': { x: 22, y: 105 }, modulation: { x: 53, y: 105 },
    'main-encoder': { x: 122, y: 68 }, 'main-click': { x: 122, y: 84 } })[source.key] || null;
}

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
  MINILAB_SURFACE_LAYOUT.faders.forEach((control) => {
    root.appendChild(svgEl('rect', { class: 'ml-svg-fader', x: control.x, y: 24, width: 7, height: 65, rx: 3 }));
    root.appendChild(svgEl('rect', { class: 'ml-svg-fader-cap', x: control.x - 8, y: control.y - 4 + (control.label === 'F2' || control.label === 'F4' ? 24 : 0), width: 23, height: 8, rx: 3 }));
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
