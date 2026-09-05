import { escapeHtml } from '../core/html.js';
import {
  MINILAB_CONTROL_SOURCES,
  MINILAB_SURFACE_CONTROLS,
  MINILAB_SURFACE_BOX,
  getMiniLabControlLayout
} from '../midi/minilabControls.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * How a control is drawn, decided by its FAMILY and never by its id.
 *
 * This table replaces five `sourceByKey('shift' | 'pitch-bend' | 'modulation' |
 * 'main-encoder' | 'main-click')` lookups and ten literal words. Those were not
 * a style problem: a profile that declares none of those ids returned undefined,
 * and the next line read `control.id` off it -- so drawing another keyboard threw
 * a TypeError and took the MiniLab page and the VST Learn panel down with it.
 * Measured against `test/conformance/vega-49.json` on 2026-09-05.
 *
 * `region` is the CSS box a family lands in and `item` the class of one control
 * inside it. Both are `base.css` vocabulary: this is a device drawn inside the
 * shell, not a faceplate in the D-012 sense, and it consumes no `--op-*` token.
 *
 * A family this table does not know still gets drawn, in `ml-extra`. That is the
 * difference between a keyboard MiniHub was written for and one it merely
 * supports: the second is legible, not photographic. What it is NOT is invisible.
 */
const FAMILY_SHAPES = Object.freeze({
  utility: { region: 'ml-utility', item: 'ml-utility-control', shape: 'text' },
  display: { region: 'ml-display', item: 'ml-display-readout', shape: 'readout' },
  main: { region: 'ml-main-encoder', item: 'ml-main-turn', shape: 'text' },
  'main-click': { region: 'ml-main-encoder', item: 'ml-main-click', shape: 'text' },
  strip: { region: 'ml-strips', item: 'ml-strip-control', shape: 'stem' },
  knob: { region: 'ml-knobs', item: 'ml-surface-knob', shape: 'cap' },
  fader: { region: 'ml-faders', item: 'ml-surface-fader', shape: 'stem' },
  pad: { region: 'ml-pads', item: 'ml-surface-pad', shape: 'legend' }
});
const UNKNOWN_FAMILY = Object.freeze({ region: 'ml-extra', item: 'ml-surface-control', shape: 'text' });

/** The order the boxes are written in. They are absolutely positioned, so this
 *  is not the layout -- it is what keeps the markup stable between renders. */
const REGION_ORDER = Object.freeze([
  'ml-utility', 'ml-display', 'ml-main-encoder', 'ml-strips',
  'ml-knobs', 'ml-faders', 'ml-pads', 'ml-extra'
]);

const shapeOf = (family) => FAMILY_SHAPES[family] ?? UNKNOWN_FAMILY;

/**
 * `printed` is what the manufacturer wrote on the panel, and it is always drawn.
 *
 * The author's rule, 2026-09-05: subdued if it has to be, never dropped. It is
 * what a user matches against the object under his fingers -- the pad he is
 * looking for says `Arp` on the hardware, not `P1` -- so a renderer that hides it
 * to save room has removed the only thing that made the drawing recognisable.
 */
const legend = (control) => escapeHtml(control.printed ?? control.label);

const SHAPES = Object.freeze({
  cap: (control) => `<span class="ml-knob-cap"></span><span>${escapeHtml(control.label)}</span>`,
  stem: (control) => `<i></i><b>${escapeHtml(control.label)}</b>`,
  // Two lines only when the panel actually says something the label does not.
  // Falling back to the label printed both lines with the same word, which is
  // how a device with nothing written on its pads looked like a rendering bug.
  legend: (control) => (control.printed
    ? `<small>${escapeHtml(control.label)}</small><b>${escapeHtml(control.printed)}</b>`
    : `<b>${escapeHtml(control.label)}</b>`),
  readout: (control) =>
    `<small>${escapeHtml(control.label)}</small><strong>${legend(control)}</strong><i aria-hidden="true"></i>`,
  text: (control) => escapeHtml(control.label)
});

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
 *
 * The three named groups are kept for the tests that pin THIS device's geometry
 * (`test/minilabProfile.test.mjs`). No renderer reads them: both draw from
 * `MINILAB_SURFACE_CONTROLS`, in profile order, whatever families it holds.
 */
export const MINILAB_SURFACE_LAYOUT = Object.freeze({
  width: MINILAB_SURFACE_BOX?.width ?? null,
  height: MINILAB_SURFACE_BOX?.height ?? null,
  knobs: Object.freeze(ofFamily('knob').map((source) => positioned(source))),
  faders: Object.freeze(ofFamily('fader').map((source) => positioned(source))),
  pads: Object.freeze(ofFamily('pad').map((source) => positioned(source)))
});

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
 *
 * **Null when the profile places nothing**, and that null is the whole of D-023
 * on the Patch Bay side: a node with no surface stacks its ports in the dock
 * like every other node. The alternative was a node claiming a panel it could
 * not fill, which renders 166 px tall with no control ports at all -- the
 * controls decode, and there is nothing to cable them to.
 */
export const MINILAB_SURFACE = MINILAB_SURFACE_BOX === null ? null : Object.freeze({
  width: MINILAB_SURFACE_BOX.width,
  height: MINILAB_SURFACE_BOX.height,
  ports: Object.freeze(Object.fromEntries(MINILAB_CONTROL_SOURCES.map((source) =>
    [source.portId, Object.freeze(miniLabPatchPortPosition(source.portId))])))
});

function stateFor(states, id) {
  const value = states?.[id];
  return typeof value === 'string' && value ? value : 'idle';
}

/**
 * One control, as HTML.
 *
 * A silent control is a `<span>`, not a `<button>`, and carries no
 * `data-source-control-id`. That is the whole of "drawn but not playable": there
 * is nothing to select, nothing to arm and nothing to bind, and a button that
 * refuses every click is a worse answer than an element that never offered one.
 */
function controlHtml(control, states, selectedId) {
  const spec = shapeOf(control.family);
  const inner = SHAPES[spec.shape](control);
  if (control.silent) {
    return `<span class="${spec.item} ml-silent">${inner}</span>`;
  }
  const selected = selectedId === control.id;
  const className = `${spec.item} state-${escapeHtml(stateFor(states, control.id))}${selected ? ' selected' : ''}`;
  return `<button type="button" class="${className}"
    data-minilab-control-id="${escapeHtml(control.id)}" data-source-control-id="${escapeHtml(control.id)}"
    aria-label="${escapeHtml(control.label)}" aria-pressed="${selected ? 'true' : 'false'}">${inner}</button>`;
}

/**
 * The same device, with no idea where anything sits.
 *
 * D-023: the Builder's steps capture what a control SENDS, never where it is, so
 * a profile written without a photograph of the keyboard has no coordinates. A
 * default grid was refused there for a reason worth repeating -- it invents an
 * ordinality that CC numbers do not carry, and the user reads a drawing that is
 * confidently wrong. A list claims nothing it does not know.
 *
 * It answers the same contract as the panel: same `data-source-control-id`, same
 * state classes, same silent rule, same `printed`. Every caller -- the MiniLab
 * page, the VST Learn panel -- keeps working without learning a second mode,
 * which is what makes this a fallback and not a second interface to maintain.
 */
function controlListHtml(controls, states, selectedId) {
  const byFamily = new Map();
  for (const control of controls) {
    if (!byFamily.has(control.family)) byFamily.set(control.family, []);
    byFamily.get(control.family).push(control);
  }
  const groups = [...byFamily.entries()].map(([family, members]) => {
    const rows = members.map((control) => {
      const label = `<span>${escapeHtml(control.label)}</span>`
        + (control.printed ? `<em>${escapeHtml(control.printed)}</em>` : '');
      if (control.silent) return `<span class="ml-list-control ml-silent">${label}</span>`;
      const selected = selectedId === control.id;
      return `<button type="button"
        class="ml-list-control state-${escapeHtml(stateFor(states, control.id))}${selected ? ' selected' : ''}"
        data-minilab-control-id="${escapeHtml(control.id)}" data-source-control-id="${escapeHtml(control.id)}"
        aria-pressed="${selected ? 'true' : 'false'}">${label}</button>`;
    }).join('');
    return `<div class="ml-list-group"><h4>${escapeHtml(family)}</h4><div class="ml-list-row">${rows}</div></div>`;
  }).join('');
  return `<div class="minilab-control-list" data-minilab-surface="learn">${groups}</div>`;
}

/**
 * Shared Hub/Learn representation. Routing and Learn ownership stay with callers.
 *
 * `controls` defaults to the loaded profile's and exists so a test can pass
 * another device's. That is not a convenience: a profile-derived constant is
 * fixed at module load and nothing can swap it, so without this argument the
 * claim "this draws any keyboard" could only be asserted, never run. The same
 * reasoning put the controller's name behind a node in `core/controllerNode.js`.
 */
export function miniLabControlSurfaceHtml({ states = {}, selectedId = null, controls = MINILAB_SURFACE_CONTROLS } = {}) {
  if (!controls.some((control) => control.layout)) {
    return controlListHtml(controls, states, selectedId);
  }
  const byRegion = new Map(REGION_ORDER.map((region) => [region, []]));
  for (const control of controls) {
    const spec = shapeOf(control.family);
    byRegion.get(spec.region).push(controlHtml(control, states, selectedId));
  }
  // An empty region is not written at all: several of them draw a border or a
  // background, so an unused one would leave an empty box floating on a device
  // that has no such control.
  const regions = REGION_ORDER
    .filter((region) => byRegion.get(region).length > 0)
    .map((region) => `<div class="${region}">${byRegion.get(region).join('')}</div>`)
    .join('');
  return `<div class="minilab-control-surface" data-minilab-surface="learn">${regions}</div>`;
}

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  Object.entries(attrs).forEach(([key, value]) => el.setAttribute(key, value));
  return el;
}

/**
 * How a control's body is drawn in the Patch Bay, by family.
 *
 * Each entry keeps the exact formula the hard-coded version used, so the MiniLab
 * node is unchanged pixel for pixel; what moved is where the numbers come from.
 * Families differ in what their coordinate MEANS -- a knob's is its centre, a
 * pad's is its top-left corner, a fader's is the left edge of its slot -- and
 * that is not tidied here: those conventions are already frozen in
 * `miniLabPatchPortPosition` and in every port the Patch Bay has ever drawn.
 *
 * There is deliberately no `display`. Drawing a screen needs a WIDTH, the format
 * has no field for one, and inventing 54x90 for every device would put a black
 * rectangle over the controls of a keyboard shaped differently. The screen is
 * drawn where the user actually reads the panel -- the faceplate above -- and the
 * node keeps to what it is for: showing where the sockets are.
 */
const SVG_BODIES = Object.freeze({
  knob: (root, control) => {
    root.appendChild(svgEl('circle', { class: 'ml-svg-knob', cx: control.x, cy: control.y, r: 10 }));
    return { x: control.x, y: control.y + 22, text: control.label, class: 'ml-svg-label' };
  },
  main: (root, control) => {
    root.appendChild(svgEl('circle', { class: 'ml-svg-knob', cx: control.x, cy: control.y, r: 13 }));
    return null;
  },
  // The push of the encoder above: the same physical object, so no second body.
  'main-click': () => null,
  fader: (root, control, index) => {
    root.appendChild(svgEl('rect', { class: 'ml-svg-fader', x: control.x, y: 24, width: 7, height: 65, rx: 3 }));
    root.appendChild(svgEl('rect', {
      class: 'ml-svg-fader-cap', width: 23, height: 8, rx: 3,
      x: control.x - 8, y: control.y - 4 + (index % 2 === 1 ? FADER_STAGGER : 0)
    }));
    return { x: control.x + 3, y: 104, text: control.label, class: 'ml-svg-label' };
  },
  pad: (root, control) => {
    root.appendChild(svgEl('rect', { class: 'ml-svg-pad', x: control.x, y: control.y, width: 22, height: 20, rx: 3 }));
    return { x: control.x + 11, y: control.y + 13, text: control.printed ?? control.label, class: 'ml-svg-tiny' };
  },
  strip: (root, control) => {
    root.appendChild(svgEl('rect', {
      class: 'ml-svg-strip', x: control.x - 10, y: control.y - 37, width: 20, height: 75, rx: 3
    }));
    return { x: control.x, y: control.y + 49, text: control.label, class: 'ml-svg-tiny' };
  },
  utility: (root, control) => {
    root.appendChild(svgEl('rect', {
      class: 'ml-svg-utility', x: control.x - 12, y: control.y - 7, width: 25, height: 14, rx: 3
    }));
    return { x: control.x, y: control.y + 3, text: control.label, class: 'ml-svg-tiny' };
  }
});

/** A family nobody wrote a body for still gets one, centred on its coordinate. */
const SVG_FALLBACK = (root, control) => {
  root.appendChild(svgEl('rect', {
    class: 'ml-svg-utility', x: control.x - 11, y: control.y - 8, width: 22, height: 16, rx: 3
  }));
  return { x: control.x, y: control.y + 3, text: control.label, class: 'ml-svg-tiny' };
};

/**
 * Shared Patch Bay representation; port callbacks are supplied by the network
 * view. `controls` defaults to the loaded profile's, for the reason given on
 * `miniLabControlSurfaceHtml`.
 */
export function appendMiniLabControlSurfaceSvg(parent, {
  buildPort, connectedPortIds = new Set(), controls = MINILAB_SURFACE_CONTROLS
}) {
  const root = svgEl('g', { class: 'minilab-control-surface-svg', 'data-minilab-surface': 'patch-bay' });
  root.appendChild(svgEl('rect', { class: 'ml-svg-body', x: 4, y: 3, width: 472, height: 173, rx: 8 }));

  const indexInFamily = new Map();
  for (const control of controls) {
    // D-023: a profile with no coordinates is not drawn as a panel at all. The
    // node falls back to a stack of ports, which is step 9 of this workstream.
    if (!control.layout) continue;
    const index = indexInFamily.get(control.family) ?? 0;
    indexInFamily.set(control.family, index + 1);

    // A silent control has a body and no socket, so it is drawn straight onto
    // the panel rather than into a group that carries a port and a hit area.
    const group = control.silent
      ? root
      : svgEl('g', {
        class: `ml-svg-control${connectedPortIds.has(control.portId) ? ' connected' : ''}`,
        'data-source-control-id': control.id
      });

    const draw = SVG_BODIES[control.family] ?? SVG_FALLBACK;
    const caption = draw(group, { ...control, x: control.layout.x, y: control.layout.y }, index);
    if (caption) {
      const text = svgEl('text', { class: caption.class, x: caption.x, y: caption.y, 'text-anchor': 'middle' });
      text.textContent = caption.text;
      group.appendChild(text);
    }
    if (!control.silent) {
      const anchor = PORT_ANCHOR_BY_FAMILY[control.family];
      const offset = anchor ? anchor(index) : { x: 0, y: 0 };
      group.appendChild(buildPort(control, control.layout.x + offset.x, control.layout.y + offset.y));
      root.appendChild(group);
    }
  }
  parent.appendChild(root);
  return root;
}
