import { escapeHtml } from '../core/html.js';
import {
  MINILAB_CONTROL_SOURCES,
  MINILAB_SURFACE_CONTROLS,
  MINILAB_SURFACE_BOX,
  controlSourcesOfNode,
  surfaceControlsOfNode,
  surfaceBoxOfNode,
  getMiniLabControlLayout
} from '../midi/minilabControls.js';
import { LOADED_PROFILE } from '../midi/loadedProfile.js';

/** The keyboard the one-device exports below describe. */
const FIRST_NODE_ID = LOADED_PROFILE.profileId;

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
 * `item` is the class of one control, `shape` what is drawn inside it. Both are
 * `base.css` vocabulary: this is a device drawn inside the shell, not a faceplate
 * in the D-012 sense, and it consumes no `--op-*` token.
 *
 * WHAT USED TO BE HERE, AND WHY IT IS GONE
 * ----------------------------------------
 * Each family also named a `region` -- `ml-knobs`, `ml-pads`, `ml-faders` -- and
 * those regions were CSS boxes positioned in percentages, each with a grid of a
 * fixed column count: four for the knobs, eight for the pads. That WAS the
 * MiniLab 3's front panel, written in a stylesheet, and it meant this view never
 * read `layout` at all. A BeatStep, measured 2026-09-05: seventeen encoders in a
 * four-column grid make five rows, which overflow the region's 52% of height and
 * land on top of the pads, while every button falls into `ml-extra` and is
 * crushed into a strip at the bottom.
 *
 * Position now comes from the profile, like the Patch Bay's SVG has always done.
 * Family governs the shape, layout governs the position -- specification section
 * 4.4, finally true of both drawings rather than one.
 *
 * A family this table does not know still gets drawn, with a plain body at its
 * own coordinate. That is the difference between a keyboard MiniHub was written
 * for and one it merely supports: the second is legible, not photographic. What
 * it is NOT is invisible, and it is no longer exiled to a strip either.
 */
const FAMILY_SHAPES = Object.freeze({
  utility: { item: 'ml-utility-control', shape: 'text' },
  display: { item: 'ml-display-readout', shape: 'readout' },
  main: { item: 'ml-main-turn', shape: 'text' },
  'main-click': { item: 'ml-main-click', shape: 'text' },
  strip: { item: 'ml-strip-control', shape: 'stem' },
  knob: { item: 'ml-surface-knob', shape: 'cap' },
  fader: { item: 'ml-surface-fader', shape: 'stem' },
  pad: { item: 'ml-surface-pad', shape: 'legend' }
});
const UNKNOWN_FAMILY = Object.freeze({ item: 'ml-surface-control', shape: 'text' });

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

// `source.id` and not `source.key`: the key is `k1`, which names a knob on every
// keyboard that has knobs, and the layout table stopped answering to it once a
// second device could be loaded.
const positioned = (source, extra = {}) =>
  Object.freeze({ ...source, ...getMiniLabControlLayout(source.id), ...extra });

const ofFamily = (family) =>
  controlSourcesOfNode(FIRST_NODE_ID).filter((source) => source.family === family);

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
 * Where a control's socket sits: ON the control, at its own coordinate.
 *
 * It used to hang beside it -- `+15` to the right of a knob, `+11,+10` from a
 * pad's corner, plus a vertical stagger for every other fader -- and each of
 * those numbers was the MiniLab 3's spacing. Two things went wrong with that.
 *
 * The first is arithmetic: a socket is 11 units wide, and on a dense device
 * there is no room beside a control for one. The BeatStep's buttons sit 13 units
 * apart; no offset makes an 11-unit triangle fit between two bodies that are
 * each 22 wide. Beside is not a placement, it is a wish.
 *
 * The second is worse: this position was computed here for the cables and
 * recomputed in the drawing, two routes that had to agree and did not. A socket
 * on the control's own coordinate has one route by construction, and it cannot
 * collide with a neighbour that the crowding rule already keeps apart.
 *
 * What moves instead is the label: a name is written UNDER its control, never
 * across it, which is what leaves the socket a clear body to sit in.
 */
export function miniLabPatchPortPosition(portId, nodeId = FIRST_NODE_ID) {
  // Scoped to the node, because `control-k1` is a socket on every keyboard that
  // has a first knob: searching the whole desk for it would return whichever
  // device loaded first, and the Patch Bay would draw one keyboard's cable onto
  // another one's panel.
  const source = controlSourcesOfNode(nodeId).find((item) => item.portId === portId);
  if (!source) return null;
  const layout = getMiniLabControlLayout(source.id);
  return layout ? { x: layout.x, y: layout.y } : null;
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
/**
 * The tightest gap between two neighbouring controls, in the device's own units.
 *
 * The node reads it to decide how wide it has to be drawn: a socket is 11 units
 * across, and one that does not fit in this gap fits nowhere on the panel. It is
 * a property of the profile, so it is computed once here rather than measured
 * again by every consumer.
 */
function tightestGap(controls, box) {
  const placed = controls.filter((control) => control.layout);
  const gaps = [...widthLimits(placed, box).values()].filter(Number.isFinite);
  return gaps.length ? Math.min(...gaps) : null;
}

/**
 * The surface one keyboard hands to its Patch Bay node, or null when the profile
 * places nothing.
 *
 * Per node rather than per module, because a MiniLab node and a BeatStep node
 * are drawn from different boxes at different scales, and `core/nodeGeometry.js`
 * reads whichever one it was handed. One shared surface would have drawn both
 * keyboards as the first one, with the second one's cables landing nowhere.
 */
export function surfaceOfNode(nodeId) {
  const box = surfaceBoxOfNode(nodeId);
  if (box === null) return null;
  return Object.freeze({
    width: box.width,
    height: box.height,
    minGap: tightestGap(surfaceControlsOfNode(nodeId), box),
    ports: Object.freeze(Object.fromEntries(controlSourcesOfNode(nodeId).map((source) =>
      [source.portId, Object.freeze(miniLabPatchPortPosition(source.portId, nodeId))])))
  });
}

/** The first keyboard's, for the consumers that still know of one. */
export const MINILAB_SURFACE = surfaceOfNode(FIRST_NODE_ID);

function stateFor(states, id) {
  const value = states?.[id];
  return typeof value === 'string' && value ? value : 'idle';
}

/**
 * Where a control sits, as a share of the panel's own box.
 *
 * A share and not a pixel, because the panel is scaled to whatever width the
 * page gives it; and carried on `data-*` rather than in a `style` attribute
 * because `style-src 'self'` rejects an inline style silently (invariant 10).
 * `applyMiniLabSurfaceLayout` is what turns these back into a position once the
 * markup is in the document -- the road `clipEditor.js` and the sequencer's
 * `data-*-pct` attributes already take.
 */
function placement(control, box, limit) {
  const x = (control.layout.x / box.width) * 100;
  const y = (control.layout.y / box.height) * 100;
  const width = Number.isFinite(limit) ? ` data-ml-max-pct="${((limit / box.width) * 100).toFixed(3)}"` : '';
  return ` data-ml-x-pct="${x.toFixed(3)}" data-ml-y-pct="${y.toFixed(3)}"${width}`;
}

/**
 * How wide a control may be drawn before it lands on the one beside it.
 *
 * A coordinate says where the centre is and nothing about the size, so a long
 * label -- "Button 1", which is what the Builder names an unnamed button -- spread
 * across its neighbours on a device whose buttons sit 13 units apart. The
 * profile answers this itself: the gap to the nearest neighbour on the same row
 * IS the room available, since both are centred on their own point.
 *
 * Only neighbours on roughly the same row count. A pad four rows below is not in
 * the way, and treating it as one would squeeze a panel that has no crowding.
 * A control with nobody beside it gets no limit at all rather than a default:
 * there is nothing to protect it from.
 */
function widthLimits(controls, box) {
  const sameRow = box.height * 0.08;
  const limits = new Map();
  for (const control of controls) {
    let nearest = Infinity;
    for (const other of controls) {
      if (other === control || !other.layout) continue;
      if (Math.abs(other.layout.y - control.layout.y) > sameRow) continue;
      const gap = Math.abs(other.layout.x - control.layout.x);
      if (gap > 0 && gap < nearest) nearest = gap;
    }
    limits.set(control, nearest);
  }
  return limits;
}

/**
 * One control, as HTML.
 *
 * A silent control is a `<span>`, not a `<button>`, and carries no
 * `data-source-control-id`. That is the whole of "drawn but not playable": there
 * is nothing to select, nothing to arm and nothing to bind, and a button that
 * refuses every click is a worse answer than an element that never offered one.
 *
 * `box` is the device's own coordinate space. It is passed rather than read from
 * the module constant so that the argument `controls` stays meaningful: a test
 * draws another keyboard by handing over its controls, and a panel that sized
 * itself from the loaded profile while drawing someone else's would place every
 * one of them against the wrong scale.
 */
function controlHtml(control, states, selectedId, box, limit) {
  const spec = shapeOf(control.family);
  const inner = SHAPES[spec.shape](control);
  const where = placement(control, box, limit);
  if (control.silent) {
    return `<span class="${spec.item} ml-placed ml-silent"${where}>${inner}</span>`;
  }
  const selected = selectedId === control.id;
  const className = `${spec.item} ml-placed state-${escapeHtml(stateFor(states, control.id))}${selected ? ' selected' : ''}`;
  return `<button type="button" class="${className}"${where}
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
export function miniLabControlSurfaceHtml({
  states = {}, selectedId = null, controls = MINILAB_SURFACE_CONTROLS, box = MINILAB_SURFACE_BOX
} = {}) {
  // Two ways to have no drawing, and they are one answer: a profile that placed
  // nothing (D-030 makes placement all or nothing, so one placed control means
  // they all are), and a box that is missing, which leaves the coordinates with
  // no scale to be read against. Either way the controls are read as a list.
  if (!box || !controls.some((control) => control.layout)) {
    return controlListHtml(controls, states, selectedId);
  }
  const limits = widthLimits(controls, box);
  const bodies = controls
    .map((control) => controlHtml(control, states, selectedId, box, limits.get(control)))
    .join('');
  // The panel's shape is the device's, not a constant. `base.css` used to carry
  // `aspect-ratio: 480 / 180` -- the MiniLab 3's front panel -- so every other
  // keyboard was drawn into a frame the wrong shape and its controls fell where
  // that frame put them.
  return `<div class="minilab-control-surface" data-minilab-surface="learn"`
    + ` data-ml-aspect="${box.width} / ${box.height}">${bodies}</div>`;
}

/**
 * Give the markup above its geometry, once it is in the document.
 *
 * The split exists because of the CSP, not for taste: `style-src 'self'` drops
 * an inline `style` attribute without an error anywhere, so a position written
 * into the HTML string would simply not arrive, and the panel would stack every
 * control at the same corner. What CSP does not touch is the CSSOM -- setting
 * `element.style` from a script -- which is why `clipEditor.js` and
 * `sequencerModule.js` already read their own `data-*-pct` attributes back this
 * way. This is the third of them and the pattern is now worth its name.
 *
 * Idempotent, and safe on markup that carries no panel: every caller re-renders
 * by replacing `innerHTML`, so this runs again on each pass.
 */
/** Below this a label is ink, not a word. */
const READABLE_PX = 6;

export function applyMiniLabSurfaceLayout(root, view = globalThis.window) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  const within = (selector) => [
    ...(root.matches?.(selector) ? [root] : []),
    ...root.querySelectorAll(selector)
  ];
  for (const surface of within('[data-ml-aspect]')) {
    surface.style.aspectRatio = surface.dataset.mlAspect;
  }
  const crowded = [];
  for (const control of within('[data-ml-x-pct]')) {
    control.style.left = `${control.dataset.mlXPct}%`;
    control.style.top = `${control.dataset.mlYPct}%`;
    // Absent where nothing sits close enough to be crowded.
    if (control.dataset.mlMaxPct) crowded.push(control);
  }

  // What does not fit shrinks; what still does not fit at a readable size gives
  // up its text rather than showing a clipped word.
  //
  // `OCT −` cut to `OCT…` loses the half that tells the two octave buttons
  // apart, and a label rendered at 3px is the same loss with more ink. Below the
  // floor the body stays -- a box that is visible, clickable and still carries
  // its `aria-label`, with the toolbar naming whatever is selected. Measured in
  // one pass after the widths are set, since the shrink is proportional to how
  // much was over.
  for (const control of crowded) {
    // Measured BEFORE the width is capped: `text-overflow: ellipsis` makes a
    // clipped label report that it fits, so a panel measured after the cap
    // would find nothing to shrink and quietly show `OCT…` instead.
    const panel = control.closest?.('[data-ml-aspect]');
    const room = panel ? (panel.clientWidth * Number(control.dataset.mlMaxPct)) / 100 : 0;
    const wanted = control.scrollWidth;
    if (room && wanted && wanted > room) {
      const size = parseFloat(view?.getComputedStyle?.(control)?.fontSize) || 8;
      const fitted = (size * room) / wanted;
      if (fitted >= READABLE_PX) control.style.fontSize = `${fitted.toFixed(2)}px`;
      else control.classList?.add('ml-cramped');
    }
    control.style.maxWidth = `${control.dataset.mlMaxPct}%`;
  }
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
  // Centred on the coordinate like every other body. The travel used to start
  // at `y: 24` and the name to be written at `y: 104` -- two absolute rows of the
  // MiniLab 3's panel -- and every other cap was pushed down by a stagger that
  // stood in for a coordinate the profile now supplies.
  fader: (root, control) => {
    root.appendChild(svgEl('rect', {
      class: 'ml-svg-fader', x: control.x - 3.5, y: control.y - 32, width: 7, height: 65, rx: 3
    }));
    root.appendChild(svgEl('rect', {
      class: 'ml-svg-fader-cap', width: 23, height: 8, rx: 3, x: control.x - 11.5, y: control.y - 4
    }));
    return { x: control.x, y: control.y + 44, text: control.label, class: 'ml-svg-label' };
  },
  // The rect used to start AT the coordinate, so the pad drawn here and the pad
  // drawn in the Learn panel were 11 units apart on the same profile.
  pad: (root, control) => {
    root.appendChild(svgEl('rect', {
      class: 'ml-svg-pad', x: control.x - 11, y: control.y - 10, width: 22, height: 20, rx: 3
    }));
    return { x: control.x, y: control.y + 18, text: control.printed ?? control.label, class: 'ml-svg-tiny' };
  },
  strip: (root, control) => {
    root.appendChild(svgEl('rect', {
      class: 'ml-svg-strip', x: control.x - 10, y: control.y - 37, width: 20, height: 74, rx: 3
    }));
    return { x: control.x, y: control.y + 45, text: control.label, class: 'ml-svg-tiny' };
  },
  utility: (root, control) => {
    root.appendChild(svgEl('rect', {
      class: 'ml-svg-utility', x: control.x - 12.5, y: control.y - 7, width: 25, height: 14, rx: 3
    }));
    return { x: control.x, y: control.y + 15, text: control.label, class: 'ml-svg-tiny' };
  }
});

/**
 * How wide each family's body is, in the profile's own units.
 *
 * The bodies above are drawn at fixed sizes -- a 25-unit utility box, a 22-unit
 * fallback -- which are the MiniLab 3's proportions. On a device whose buttons
 * sit 13 units apart they simply overlap, and the drawing turns into a pile.
 * These numbers are what the crowding rule measures against; they are the
 * drawing's own dimensions, so they live beside it.
 */
const SVG_BODY_WIDTH = Object.freeze({
  knob: 20, main: 26, 'main-click': 0, fader: 23, pad: 22, strip: 20, utility: 25
});
const SVG_FALLBACK_WIDTH = 22;

/** A family nobody wrote a body for still gets one, centred on its coordinate. */
const SVG_FALLBACK = (root, control) => {
  root.appendChild(svgEl('rect', {
    class: 'ml-svg-utility', x: control.x - 11, y: control.y - 8, width: 22, height: 16, rx: 3
  }));
  return { x: control.x, y: control.y + 16, text: control.label, class: 'ml-svg-tiny' };
};

/**
 * Shared Patch Bay representation; port callbacks are supplied by the network
 * view. `controls` defaults to the loaded profile's, for the reason given on
 * `miniLabControlSurfaceHtml`.
 */
export function appendMiniLabControlSurfaceSvg(parent, {
  buildPort, connectedPortIds = new Set(), controls = MINILAB_SURFACE_CONTROLS, box = MINILAB_SURFACE_BOX
}) {
  const root = svgEl('g', { class: 'minilab-control-surface-svg', 'data-minilab-surface': 'patch-bay' });
  // The faceplate is the device's box, inset by a hair. It was `472 x 173` --
  // the MiniLab 3 minus its margins -- so a narrower keyboard was framed by a
  // panel wider than itself and a wider one overflowed its own frame.
  const inset = 4;
  root.appendChild(svgEl('rect', {
    class: 'ml-svg-body',
    x: inset, y: inset,
    width: Math.max(1, (box?.width ?? 0) - inset * 2),
    height: Math.max(1, (box?.height ?? 0) - inset * 2),
    rx: 8
  }));

  const indexInFamily = new Map();
  const gaps = widthLimits(controls.filter((control) => control.layout), box ?? { width: 1, height: 1 });
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

    // The same rule the Learn panel applies: a body wider than the gap to its
    // neighbour is drawn smaller rather than over it. Only the body and its
    // label shrink -- the port keeps the position `nodeGeometry` computes for it,
    // or a cable would stop meeting its own socket.
    const width = SVG_BODY_WIDTH[control.family] ?? SVG_FALLBACK_WIDTH;
    const gap = gaps.get(control);
    const scale = width > 0 && Number.isFinite(gap) && gap < width ? gap / width : 1;
    const { x, y } = control.layout;
    const body = scale < 1
      ? svgEl('g', { transform: `translate(${x} ${y}) scale(${scale.toFixed(3)}) translate(${-x} ${-y})` })
      : svgEl('g');
    group.appendChild(body);

    const draw = SVG_BODIES[control.family] ?? SVG_FALLBACK;
    const caption = draw(body, { ...control, x, y }, index);
    // A name that is wider than the room beside it is not drawn. It would be
    // written straight across its neighbour's -- two names in the same place read
    // as neither -- and the control keeps its body, its socket and its label in
    // the port itself. Estimated rather than measured: the SVG is built detached,
    // where getComputedTextLength() has nothing to measure against.
    if (caption && caption.text) {
      const perChar = caption.class === 'ml-svg-tiny' ? 3.4 : 5;
      const wanted = String(caption.text).length * perChar * scale;
      if (!Number.isFinite(gap) || wanted <= gap) {
        const text = svgEl('text', { class: caption.class, x: caption.x, y: caption.y, 'text-anchor': 'middle' });
        text.textContent = caption.text;
        body.appendChild(text);
      }
    }
    if (!control.silent) {
      // On the control, not beside it: see miniLabPatchPortPosition. Outside the
      // shrunk body group, so the socket keeps its size and its hit area.
      group.appendChild(buildPort(control, x, y));
      root.appendChild(group);
    }
  }
  parent.appendChild(root);
  return root;
}
