import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, makeEl, findClass } from './domShim.mjs';
import { MINILAB_CONTROL_SOURCES } from '../src/renderer/js/midi/minilabControls.js';
import { nodeGeometry, surfaceNodeHeight } from '../src/renderer/js/core/nodeGeometry.js';
import {
  MINILAB_SURFACE_LAYOUT,
  miniLabControlSurfaceHtml,
  appendMiniLabControlSurfaceSvg,
  applyMiniLabSurfaceLayout
} from '../src/renderer/js/ui/miniLabControlSurface.js';

test('one MiniLab layout is shared by Learn HTML and Patch Bay SVG', () => {
  assert.deepEqual(MINILAB_SURFACE_LAYOUT.knobs.map((item) => item.id),
    MINILAB_CONTROL_SOURCES.filter((item) => item.family === 'knob').map((item) => item.id));
  const html = miniLabControlSurfaceHtml();
  assert.equal((html.match(/class="ml-surface-knob/g) || []).length, 8);
  assert.match(html, /data-minilab-surface="learn"/);
  // The words come from the profile's labels now, in the profile's own case:
  // shouting is `text-transform` in base.css, so nobody describing a keyboard has
  // to remember to type PITCH rather than Pitch.
  assert.match(html, />Pitch</);
  assert.match(html, />Mod</);
  assert.equal((html.match(/class="ml-surface-fader /g) || []).length, 4);
  assert.equal((html.match(/class="ml-surface-pad /g) || []).length, 8);

  installDom();
  const parent = makeEl('g');
  const ports = [];
  appendMiniLabControlSurfaceSvg(parent, {
    connectedPortIds: new Set(['control-k1']),
    buildPort(control) {
      ports.push(control.portId);
      const el = makeEl('g');
      el.dataset.portId = control.portId;
      return el;
    }
  });
  assert.deepEqual([...ports].sort(), MINILAB_CONTROL_SOURCES.map((item) => item.portId).sort());
  const surface = findClass(parent, 'minilab-control-surface-svg');
  assert.equal(surface.attributes['data-minilab-surface'], 'patch-bay');
  assert.equal(ports.filter((id) => id === 'control-k1').length, 1);
});

test('caller-provided Learn states do not create another control model', () => {
  const html = miniLabControlSurfaceHtml({
    selectedId: 'minilab-3:k1',
    states: { 'minilab-3:k1': 'learn-armed', 'minilab-3:k2': 'mapped' }
  });
  assert.match(html, /state-learn-armed selected/);
  assert.match(html, /state-mapped/);
  for (const source of MINILAB_CONTROL_SOURCES) assert.match(html, new RegExp(source.id));
  assert.match(html, /minilab-3:f1/);
  assert.match(html, /minilab-3:p1/);
});

/**
 * The panel is drawn from the profile, not from a list of control ids.
 *
 * What this replaces: five `sourceByKey('shift' | 'pitch-bend' | 'modulation' |
 * 'main-encoder' | 'main-click')` lookups, whose result went straight into
 * `control.id`. A keyboard declaring none of those five threw a TypeError and
 * took two pages down -- the MiniLab page and the VST Learn panel, which draw the
 * same function. `controls` is an argument precisely so that can be RUN here
 * rather than asserted about the shipped device.
 */
/* Vega's own box: a caller that hands over another keyboard's controls hands
   over its coordinate space too, or every position is read against the wrong
   scale -- which is the bug this whole pass is about, in miniature. */
const foreignBox = Object.freeze({ width: 620, height: 240 });
const foreign = [
  { id: 'vega-49:dial-one', portId: 'control-dial-one', key: 'dial-one', label: 'Dial 1', printed: null, family: 'knob', silent: false, layout: { x: 60, y: 40 } },
  { id: 'vega-49:breath', portId: 'control-breath', key: 'breath', label: 'Breath', printed: 'BC', family: 'breath', silent: false, layout: { x: 200, y: 90 } },
  { id: 'vega-49:sustain', portId: 'control-sustain', key: 'sustain', label: 'Sustain', printed: null, family: 'pedal', silent: false, layout: { x: 300, y: 120 } }
];

test('a keyboard that declares none of the MiniLab control ids still draws', () => {
  const html = miniLabControlSurfaceHtml({ controls: foreign, box: foreignBox });
  assert.match(html, /data-source-control-id="vega-49:dial-one"/);
  assert.match(html, /class="ml-surface-knob/, 'a knob is a knob on any device');
  // Two families this drawing has no body for. Legible beats photographic, and
  // both beat invisible -- and each is drawn where it SITS. They used to be swept
  // into `ml-extra`, a strip along the bottom, whatever the profile said.
  assert.match(html, /class="ml-surface-control ml-placed/);
  assert.match(html, /data-source-control-id="vega-49:breath"/);
  assert.match(html, /data-source-control-id="vega-49:sustain"/);
  assert.match(html, /data-ml-aspect="620 \/ 240"/, "the frame is the device's own shape");

  installDom();
  const parent = makeEl('g');
  const ports = [];
  appendMiniLabControlSurfaceSvg(parent, {
    controls: foreign,
    buildPort(control) { ports.push(control.portId); return makeEl('g'); }
  });
  assert.deepEqual(ports.sort(), ['control-breath', 'control-dial-one', 'control-sustain'],
    'every control of a foreign profile gets a socket, whatever its family');
});

test('a control that sends nothing is drawn, and cannot be armed', () => {
  const html = miniLabControlSurfaceHtml();
  // The author's rule: faint if it must be, present always. It is what the user
  // matches the drawing against the words on his own hardware.
  assert.match(html, />Hold</, 'HOLD is on the panel, so it is on the drawing');
  assert.match(html, />Oct −</);
  assert.match(html, />Oct \+</);
  assert.match(html, /<strong>36<\/strong>/, 'the screen still reads what it read before');

  const silent = html.match(/<span class="ml-utility-control ml-placed ml-silent"/g) || [];
  assert.equal(silent.length, 3, 'the three silent buttons are spans, not buttons');
  assert.doesNotMatch(html, /data-source-control-id="minilab-3:hold"/,
    'nothing that cannot send may offer itself as a Learn target');

  installDom();
  const parent = makeEl('g');
  const ports = [];
  appendMiniLabControlSurfaceSvg(parent, {
    buildPort(control) { ports.push(control.portId); return makeEl('g'); }
  });
  assert.equal(ports.length, 25, 'the panel gained four elements and no port');
});

test('what the hardware prints is what the pad shows', () => {
  const html = miniLabControlSurfaceHtml();
  // `Arp` is written under pad 1 on the device; `P1` is what MiniHub calls it.
  // A user hunting for the arpeggiator button reads the first, not the second.
  assert.match(html, /<small>P1<\/small><b>Arp<\/b>/);
  assert.match(html, /<small>P8<\/small><b>Tap<\/b>/);
});

/**
 * D-023, in the surface that has to survive it: a profile written without a
 * photograph of the keyboard has no coordinates at all.
 *
 * A default grid was refused when that decision was taken, because it invents an
 * ordinality CC numbers do not carry. So the answer is a list -- and the point of
 * this test is that it is the SAME contract: every caller keeps its click
 * handling, its states and its selection without knowing which mode it got.
 */
const unplaced = [
  { id: 'nano:slider-one', portId: 'control-slider-one', key: 'slider-one', label: 'Slider 1', printed: 'VOL', family: 'fader', silent: false, layout: null },
  { id: 'nano:knob-one', portId: 'control-knob-one', key: 'knob-one', label: 'Knob 1', printed: null, family: 'knob', silent: false, layout: null },
  { id: null, portId: null, key: 'transport', label: 'Transport', printed: 'PLAY', family: 'utility', silent: true, layout: null }
];

test('a profile that says where nothing sits is read as a list, not drawn as a panel', () => {
  const html = miniLabControlSurfaceHtml({ controls: unplaced, states: { 'nano:knob-one': 'mapped' } });
  assert.match(html, /class="minilab-control-list"/);
  assert.doesNotMatch(html, /class="minilab-control-surface"/,
    'no coordinates means no panel: a drawing here would be invented, not observed');

  // Same contract as the panel, which is what lets every caller stay unchanged.
  assert.match(html, /data-minilab-surface="learn"/);
  assert.match(html, /data-source-control-id="nano:knob-one"/);
  assert.match(html, /state-mapped/);
  assert.match(html, /<h4>fader<\/h4>/, 'family is the one thing such a profile says about organisation');
  assert.match(html, /<em>VOL<\/em>/, 'what the hardware prints survives the loss of the drawing');
  assert.match(html, /<span class="ml-list-control ml-silent">/);
  assert.doesNotMatch(html, /data-source-control-id="null"/);
});

test('a profile that places every control still gets its panel', () => {
  assert.match(miniLabControlSurfaceHtml(), /class="minilab-control-surface"/);
});

/**
 * The Patch Bay half of the same decision.
 *
 * `MINILAB_SURFACE` is null when the profile places nothing, so the routing node
 * carries no surface and `nodeGeometry` falls back to the dock. The failure this
 * replaces was silent and complete: a node that declares a surface it cannot
 * fill keeps its panel height and draws only the ports found in
 * `surface.ports` -- none of them -- so every control decoded correctly and had
 * nowhere to be cabled.
 */
test('a controller with no coordinates stacks its ports instead of showing an empty panel', () => {
  const outputs = MINILAB_CONTROL_SOURCES.map((source) => ({ id: source.portId, type: 'control' }));
  const listed = nodeGeometry({ surface: null, inputs: [], outputs }, { x: 0, y: 0 });
  assert.equal(listed.outputs.length, outputs.length, 'every control keeps a socket');
  assert.ok(listed.height > surfaceNodeHeight({ width: 480, height: 180 }),
    'the node grows to hold them, rather than hiding them');

  const empty = nodeGeometry({ surface: { width: 480, height: 180, ports: {} }, inputs: [], outputs }, { x: 0, y: 0 });
  assert.equal(empty.outputs.length, 0,
    'this is what a surface with nothing placed in it does, and why MINILAB_SURFACE is null instead');
});

/*
 * The BeatStep, measured on 2026-09-05: seventeen encoders, sixteen pads and
 * eight buttons on a box of 419 x 174.
 *
 * It is the shape that broke the old drawing, and it broke it silently. The
 * panel was laid out by CSS regions -- `.ml-knobs` four columns wide, `.ml-pads`
 * eight -- which is the MiniLab 3's front panel written as a stylesheet: the
 * seventeenth encoder made a fifth row, the fifth row overflowed the region's
 * 52% of height, and four encoders came to rest on top of the pads. Nothing
 * threw, nothing logged, and the user was shown a keyboard that does not exist.
 */
const beatStepBox = Object.freeze({ width: 419, height: 174 });
const beatStep = [
  ...Array.from({ length: 16 }, (_, i) => ({
    id: `arturia-beatstep:k${i + 1}`, portId: `control-k${i + 1}`, key: `k${i + 1}`,
    label: `Knob ${i + 1}`, printed: null, family: 'knob', silent: false,
    layout: { x: 91 + (i % 8) * 42, y: i < 8 ? 22 : 58 }
  })),
  { id: 'arturia-beatstep:k17', portId: 'control-k17', key: 'k17', label: 'Knob 17',
    printed: null, family: 'knob', silent: false, layout: { x: 42, y: 38 } },
  ...Array.from({ length: 16 }, (_, i) => ({
    id: `arturia-beatstep:p${i + 1}`, portId: `control-p${i + 1}`, key: `p${i + 1}`,
    label: `Pad ${i + 1}`, printed: null, family: 'pad', silent: false,
    layout: { x: 93 + (i % 8) * 41, y: i < 8 ? 96 : 138 }
  })),
  ...Array.from({ length: 8 }, (_, i) => ({
    id: `arturia-beatstep:b${i + 1}`, portId: `control-b${i + 1}`, key: `b${i + 1}`,
    label: `Button ${i + 1}`, printed: null, family: 'button', silent: false,
    layout: { x: i % 2 ? 41 : 28, y: 88 + Math.floor(i / 2) * 20 }
  }))
];

test('the panel takes its geometry from the profile, so nothing lands on anything', () => {
  const html = miniLabControlSurfaceHtml({ controls: beatStep, box: beatStepBox });

  // The frame is the device's shape. `aspect-ratio: 480 / 180` used to be in
  // base.css, which framed every keyboard as a MiniLab 3.
  assert.match(html, /data-ml-aspect="419 \/ 174"/);

  const places = [...html.matchAll(/data-ml-x-pct="([\d.]+)" data-ml-y-pct="([\d.]+)"/g)]
    .map(([, x, y]) => `${x},${y}`);
  assert.equal(places.length, beatStep.length, 'every control carries its own coordinate');
  assert.equal(new Set(places).size, beatStep.length,
    'no two controls are drawn at the same point: overlap is what a region grid produced');

  // Read one back to the profile it came from, in both axes. The seventeenth
  // encoder is the one the four-column grid had nowhere to put.
  const k17 = html.match(/data-ml-x-pct="([\d.]+)" data-ml-y-pct="([\d.]+)"[^>]*?"arturia-beatstep:k17"/);
  assert.ok(k17, 'the seventeenth encoder is drawn');
  assert.equal(k17[1], ((42 / 419) * 100).toFixed(3), 'x is a share of the box, not a grid cell');
  assert.equal(k17[2], ((38 / 174) * 100).toFixed(3), 'y likewise');
});

test('the coordinates reach the element, since the CSP drops an inline style', () => {
  const made = (attrs) => ({
    dataset: attrs, style: {},
    matches: () => false
  });
  const surface = made({ mlAspect: '419 / 174' });
  const knob = made({ mlXPct: '10.024', mlYPct: '21.839' });
  applyMiniLabSurfaceLayout({
    matches: () => false,
    querySelectorAll: (selector) => (selector === '[data-ml-aspect]' ? [surface] : [knob])
  });
  assert.equal(surface.style.aspectRatio, '419 / 174');
  assert.equal(knob.style.left, '10.024%');
  assert.equal(knob.style.top, '21.839%');
});

test('the Patch Bay drawing shrinks a crowded body instead of stacking it', () => {
  installDom();
  const parent = makeEl('g');
  appendMiniLabControlSurfaceSvg(parent, {
    controls: beatStep, box: beatStepBox,
    buildPort: () => makeEl('g')
  });

  const transforms = [];
  const walk = (el) => {
    if (el.attributes?.transform) transforms.push(el.attributes.transform);
    (el.children ?? []).forEach(walk);
  };
  walk(parent);

  // The eight buttons sit 13 units apart and their body is drawn 22 wide: the
  // node used to pile them on top of each other, which is what the panel is
  // there to avoid. Nothing else on this device is crowded, so nothing else is
  // touched -- a rule that fires everywhere is a rule that redraws a keyboard
  // nobody asked it to redraw.
  const shrunk = transforms.filter((t) => /scale\(0\.\d+\)/.test(t));
  assert.equal(shrunk.length, 8, 'one per crowded button, and only those');
  for (const transform of shrunk) {
    const [, factor] = transform.match(/scale\(([\d.]+)\)/);
    assert.ok(Number(factor) < 1 && Number(factor) > 0.4, `a readable reduction, got ${factor}`);
  }

  // The frame is the device's box, not 472 x 173 -- the MiniLab 3 minus margins.
  const body = [];
  const findBody = (el) => {
    if (el.attributes?.class === 'ml-svg-body') body.push(el.attributes);
    (el.children ?? []).forEach(findBody);
  };
  findBody(parent);
  assert.equal(body.length, 1);
  assert.equal(Number(body[0].width), beatStepBox.width - 8);
  assert.equal(Number(body[0].height), beatStepBox.height - 8);
});
