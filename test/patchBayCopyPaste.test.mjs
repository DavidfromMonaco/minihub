import './installNodeEditors.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MINILAB_SURFACE } from '../src/renderer/js/ui/miniLabControlSurface.js';
import { makeHub } from './helpers.mjs';
import { makeEl, installDom, fire, fireKey, findClass, openMenu, menuEntries, menuEntry, entryLabel, pickEntry } from './domShim.mjs';

// ---- DOM shim (only what the routing module touches) ------------------------
function makeContainer() {
  const container = makeEl('div');
  const svg = makeEl('svg');
  svg.setAttribute('id', 'routing-svg');
  Object.defineProperty(container, 'innerHTML', {
    get() { return ''; },
    set() { container.children.length = 0; container.appendChild(svg); },
    configurable: true
  });
  return { container, svg };
}

installDom();
const { createRoutingModule } = await import('../src/renderer/js/modules/routing/routingModule.js');
const { ModuleSystem } = await import('../src/renderer/js/core/moduleSystem.js');
const { NodeInstanceManager } = await import('../src/renderer/js/core/nodeInstances.js');
const { listOmniBoxCategories } = await import('../src/renderer/js/core/nodeTypes.js');
const {
  nodeGeometry,
  nodeHeight,
  dockHeight,
  NODE_WIDTH,
  IDENTITY_H,
  surfaceNodeHeight,
  surfacePortRowY
} = await import('../src/renderer/js/core/nodeGeometry.js');
const { fitViewport } = await import('../src/renderer/js/core/viewportMath.js');

// ---- event simulation helpers -------------------------------------------------

// ---- fixtures -----------------------------------------------------------------
function setupHub({ withMinilab = true, layout = {} } = {}) {
  const hub = makeHub({
    networkViewport: { x: 0, y: 0, zoom: 1 },
    ...(Object.keys(layout).length ? { networkLayout: layout } : {})
  });
  const modules = new ModuleSystem(hub);
  const nodes = new NodeInstanceManager({ events: hub.events, settings: hub.settings, network: hub.network, modules });
  hub.modules = modules;
  hub.nodes = nodes;
  if (withMinilab) {
    hub.network.addNode({ id: 'minilab-3', name: 'MiniLab 3', outputs: [{ id: 'midi-out', type: 'midi' }] });
  }
  return hub;
}

function mount(hub) {
  const { container, svg } = makeContainer();
  const mod = createRoutingModule(hub);
  mod.mount(container);
  return { container, svg, mod };
}

function findNode(nodesLayer, id) {
  return nodesLayer.children.find((c) => c.dataset.nodeId === id);
}

function nodePanel(nodeG) {
  return nodeG.children.find((c) => c._classSet.has('node-panel'));
}

function nodesLayerOf(svg) {
  return findClass(svg, 'nodes');
}

function clickNode(svg, nodeG) {
  fire(svg, 'pointerdown', { button: 0, target: nodePanel(nodeG), clientX: 5, clientY: 5 });
  fire(svg, 'pointerup', {});
}

/** The lines of a card's readout, as printed. */
function readoutText(nodeG) {
  const readout = findClass(nodeG, 'node-readout');
  return readout ? readout.children.filter((c) => c._classSet.has('node-readout-text')).map((c) => c.textContent) : null;
}

// ---- copy / paste -------------------------------------------------------------
test('Ctrl+C copies selected dynamic node; Ctrl+V creates a new unique instance', () => {
  const hub = setupHub({ withMinilab: false });
  hub.nodes.create('vst'); // vst-001
  const { svg, mod } = mount(hub);
  const layer = nodesLayerOf(svg);
  const src = findNode(layer, 'vst-001');
  clickNode(svg, src);
  fireKey('c', svg, { ctrlKey: true });
  fireKey('v', svg, { ctrlKey: true });
  const pasted = hub.nodes.get('vst-002');
  assert.ok(pasted, 'pasted instance created');
  assert.equal(pasted.name, 'VST 2');
  assert.equal(pasted.type, 'vst');
  mod.unmount();
});

test('native MiniLab cannot be copied', () => {
  const hub = setupHub({ withMinilab: true });
  const { svg, mod } = mount(hub);
  const layer = nodesLayerOf(svg);
  const ml = findNode(layer, 'minilab-3');
  clickNode(svg, ml);
  fireKey('c', svg, { ctrlKey: true });
  fireKey('v', svg, { ctrlKey: true });
  assert.equal(hub.nodes.list().length, 0, 'no node copied from native MiniLab');
  mod.unmount();
});

test('context-menu Copy copies the node right-clicked, which becomes the selection', () => {
  const hub = setupHub({ withMinilab: false });
  hub.nodes.create('vst'); // vst-001
  hub.nodes.create('vst'); // vst-002
  const { svg, mod } = mount(hub);
  const layer = nodesLayerOf(svg);
  clickNode(svg, findNode(layer, 'vst-001')); // select A
  // Right-click B: B is what the menu acts on, so B is what is highlighted.
  fire(svg, 'contextmenu', { target: nodePanel(findNode(nodesLayerOf(svg), 'vst-002')), clientX: 200, clientY: 120 });
  pickEntry('Copy');
  const selected = () => nodesLayerOf(svg).children.filter((c) => c._classSet.has('selected')).map((c) => c.dataset.nodeId);
  assert.deepEqual(selected(), ['vst-002']);
  // Paste -> duplicates B (vst-002) -> vst-003, which becomes selected.
  fireKey('v', svg, { ctrlKey: true });
  assert.ok(hub.nodes.get('vst-003'), 'pasted node created from context target');
  assert.deepEqual(selected(), ['vst-003'], 'pasted node becomes selected');
  mod.unmount();
});

test('pasted content is independent and VST plugin IDs are regenerated', () => {
  const hub = setupHub({ withMinilab: false });
  const src = hub.nodes.create('vst'); // vst-001
  const chain = hub.nodes.getChain(src.id);
  const p1 = chain.append({ name: 'A', role: 'instrument' });
  chain.append({ name: 'B', role: 'utility' });
  chain.setBypass(p1.id, true);

  const { svg, mod } = mount(hub);
  const layer = nodesLayerOf(svg);
  clickNode(svg, findNode(layer, 'vst-001'));
  fireKey('c', svg, { ctrlKey: true });
  fireKey('v', svg, { ctrlKey: true });

  const pasted = hub.nodes.get('vst-002');
  const srcPlugins = src.content.plugins;
  const dupPlugins = pasted.content.plugins;
  assert.equal(dupPlugins.length, 2);
  assert.equal(dupPlugins[0].name, 'A');
  assert.equal(dupPlugins[1].name, 'B');
  assert.equal(dupPlugins[0].role, 'instrument');
  assert.equal(dupPlugins[0].bypassed, true);
  assert.notEqual(dupPlugins[0].id, srcPlugins[0].id);
  assert.notEqual(dupPlugins[1].id, srcPlugins[1].id);
  mod.unmount();
});

test('external network connections are NOT copied on paste', () => {
  const hub = setupHub({ withMinilab: true });
  const src = hub.nodes.create('vst'); // vst-001
  hub.network.connect('minilab-3', 'midi-out', 'vst-001', 'midi-in');
  assert.equal(hub.network.connections().length, 1);
  const { svg, mod } = mount(hub);
  const layer = nodesLayerOf(svg);
  clickNode(svg, findNode(layer, 'vst-001'));
  fireKey('c', svg, { ctrlKey: true });
  fireKey('v', svg, { ctrlKey: true });
  const pasted = hub.nodes.get('vst-002');
  assert.equal(hub.network.connections().length, 1, 'no copied connections');
  assert.equal(hub.network.connectionsTo(pasted.id).length, 0);
  mod.unmount();
});

test('context Paste uses the context world position', () => {
  const hub = setupHub({ withMinilab: false, layout: { 'vst-001': { x: 500, y: 500 } } });
  hub.nodes.create('vst'); // vst-001
  const { container, svg, mod } = mount(hub);
  const layer = nodesLayerOf(svg);
  clickNode(svg, findNode(layer, 'vst-001'));
  fireKey('c', svg, { ctrlKey: true });
  // Right-click empty canvas at (100,100) -> world (100,100).
  fire(svg, 'contextmenu', { target: svg, clientX: 100, clientY: 100 });
  pickEntry('Paste');
  const pos = hub.settings.get('networkLayout')['vst-002'];
  assert.deepEqual(pos, { x: 100, y: 100 });
  mod.unmount();
});

test('keyboard Paste uses pointer world position when over the canvas', () => {
  const hub = setupHub({ withMinilab: false, layout: { 'vst-001': { x: 500, y: 500 } } });
  hub.nodes.create('vst'); // vst-001
  const { svg, mod } = mount(hub);
  const layer = nodesLayerOf(svg);
  clickNode(svg, findNode(layer, 'vst-001'));
  fireKey('c', svg, { ctrlKey: true });
  fire(svg, 'pointermove', { clientX: 120, clientY: 90 });
  fireKey('v', svg, { ctrlKey: true });
  const pos = hub.settings.get('networkLayout')['vst-002'];
  assert.deepEqual(pos, { x: 120, y: 90 });
  mod.unmount();
});

test('keyboard Paste uses viewport center when pointer is not over the canvas', () => {
  // The source sits far from the viewport centre on purpose. This test is about
  // WHICH position paste chooses, not about the anti-stacking nudge: with the
  // source at (500,500) the pasted copy overlapped it and resolveNodePos()
  // legitimately displaced the result, so the assertion silently depended on
  // how tall a VST node happens to be.
  const hub = setupHub({ withMinilab: false, layout: { 'vst-001': { x: 2000, y: 2000 } } });
  hub.nodes.create('vst'); // vst-001
  const { svg, mod } = mount(hub);
  const layer = nodesLayerOf(svg);
  clickNode(svg, findNode(layer, 'vst-001'));
  fireKey('c', svg, { ctrlKey: true });
  // No pointermove -> lastPointerClient is null -> viewport center (400,300).
  fireKey('v', svg, { ctrlKey: true });
  const pos = hub.settings.get('networkLayout')['vst-002'];
  assert.deepEqual(pos, { x: 400, y: 300 });
  mod.unmount();
});

test('copy/paste shortcuts are ignored in editable controls', () => {
  const hub = setupHub({ withMinilab: false });
  hub.nodes.create('vst'); // vst-001
  const { svg, mod } = mount(hub);
  const layer = nodesLayerOf(svg);
  clickNode(svg, findNode(layer, 'vst-001'));
  const input = makeEl('input');
  fireKey('c', input, { ctrlKey: true });
  fireKey('v', input, { ctrlKey: true });
  assert.equal(hub.nodes.list().length, 1, 'no node created while editing input');
  mod.unmount();
});

// ---- empty-canvas context menu ------------------------------------------------
test('right-click empty canvas opens the canvas context menu', () => {
  const hub = setupHub({ withMinilab: false });
  const { svg, mod } = mount(hub);
  fire(svg, 'contextmenu', { target: svg, clientX: 100, clientY: 80 });
  const menu = openMenu();
  assert.ok(menu, 'canvas menu opened');
  assert.ok(findClass(menu, 'ctx-search'), 'the node list can be searched');
  assert.deepEqual(menuEntries().map(entryLabel).slice(-4), ['Paste', 'Select All', 'Align', 'Show All Nodes']);
  mod.unmount();
});

test('right-drag empty canvas pans and does not open a menu afterward', () => {
  const hub = setupHub({ withMinilab: false });
  const { container, svg, mod } = mount(hub);
  const vbBefore = svg.getAttribute('viewBox');
  fire(svg, 'pointerdown', { button: 2, target: svg, clientX: 100, clientY: 100 });
  fire(svg, 'pointermove', { clientX: 160, clientY: 140 });
  fire(svg, 'pointermove', { clientX: 220, clientY: 180 });
  fire(svg, 'pointerup', {});
  assert.notEqual(svg.getAttribute('viewBox'), vbBefore, 'viewBox changed -> panned');
  fire(svg, 'contextmenu', { target: svg, clientX: 220, clientY: 180 });
  assert.equal(openMenu(), null, 'no menu after pan');
  mod.unmount();
});

/**
 * The pan that took a moment, which is every pan.
 *
 * The suppression used to be armed when the pan STARTED, behind an 800 ms
 * timer. A test that dragged and released in the same tick could not see it:
 * hold the button down for a second, as anyone reading their patch does, and
 * the flag had expired before the release -- so the menu opened at the end of
 * the movement. The clock is out of the gesture now; only the release arms it.
 */
test('a pan held for a second still ends without a context menu', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const hub = setupHub({ withMinilab: false });
    const { container, svg, mod } = mount(hub);
    const vbBefore = svg.getAttribute('viewBox');
    fire(svg, 'pointerdown', { button: 2, target: svg, clientX: 100, clientY: 100 });
    fire(svg, 'pointermove', { clientX: 160, clientY: 140 });
    t.mock.timers.tick(5000); // a slow, deliberate drag across the canvas
    fire(svg, 'pointermove', { clientX: 300, clientY: 260 });
    fire(svg, 'pointerup', {});
    assert.notEqual(svg.getAttribute('viewBox'), vbBefore, 'it panned');
    fire(svg, 'contextmenu', { target: svg, clientX: 300, clientY: 260 });
    assert.equal(openMenu(), null, 'and no menu followed it');

    // The click is still a click: pressed and released without crossing the
    // threshold, the menu is the whole point of the right button.
    fire(svg, 'pointerdown', { button: 2, target: svg, clientX: 300, clientY: 260 });
    fire(svg, 'pointermove', { clientX: 302, clientY: 261 });
    fire(svg, 'pointerup', {});
    fire(svg, 'contextmenu', { target: svg, clientX: 302, clientY: 261 });
    assert.ok(openMenu(), 'a right-click still opens the menu');

    mod.unmount();
  } finally {
    t.mock.timers.reset();
  }
});

test('Paste is disabled when the clipboard is empty', () => {
  const hub = setupHub({ withMinilab: false });
  const { container, svg, mod } = mount(hub);
  fire(svg, 'contextmenu', { target: svg, clientX: 100, clientY: 80 });
  assert.equal(menuEntry('Paste').disabled, true, 'Paste disabled with empty clipboard');
  mod.unmount();
});

test('the canvas menu lists every node type under its family, flat', () => {
  const hub = setupHub({ withMinilab: false });
  const { svg, mod } = mount(hub);
  fire(svg, 'contextmenu', { target: svg, clientX: 100, clientY: 80 });
  const menu = openMenu();
  // Headings and entries in the order drawn, up to the first separator.
  const drawn = [];
  for (const child of menu.children) {
    if (child._classSet.has('ctx-separator')) break;
    if (child._classSet.has('ctx-group')) drawn.push({ label: child.textContent, types: [] });
    else if (child._classSet.has('ctx-item')) drawn.at(-1).types.push(entryLabel(child));
  }
  // Media last: Video and Image are no OmniBox, and this menu became their way
  // in when the toolbar's list of every type went (D-055).
  assert.deepEqual(drawn, [...listOmniBoxCategories().map((category) => ({
    label: category.label, types: category.types.map((type) => type.label)
  })), { label: 'Media', types: ['Video', 'Image'] }], 'the families are headings, driven by the registry, and no entry hides behind a hover');
  assert.equal(findClass(menu, 'ctx-sub'), null, 'no submenu left');
  mod.unmount();
});

test('typing in the canvas menu narrows the node list, and Enter creates the first match', () => {
  const hub = setupHub({ withMinilab: false });
  const { svg, mod } = mount(hub);
  fire(svg, 'contextmenu', { target: svg, clientX: 700, clientY: 520 });
  const menu = openMenu();
  const field = findClass(menu, 'ctx-search');
  assert.ok(field, 'a search field heads the menu');
  field.value = 'mix';
  fire(field, 'input');
  const visible = menuEntries(menu).filter((entry) => entry.hidden !== true).map(entryLabel);
  assert.deepEqual(visible, ['Mixer']);
  const headings = menu.children.filter((child) => child._classSet.has('ctx-group') && child.hidden !== true)
    .map((child) => child.textContent);
  assert.deepEqual(headings, ['Audio'], 'only the family that still has an entry keeps its heading');
  field.value = 'audio';
  fire(field, 'input');
  assert.ok(menuEntries(menu).filter((entry) => entry.hidden !== true).map(entryLabel).includes('Audio Player'),
    'a family name finds its types');
  field.value = 'mix';
  fire(field, 'input');
  fire(field, 'keydown', { key: 'Enter' });
  assert.ok(hub.nodes.get('mixer-001'), 'Enter created the Mixer');
  assert.deepEqual(hub.settings.get('networkLayout')['mixer-001'], { x: 700, y: 520 }, 'where the menu was opened');
  assert.equal(openMenu(), null);
  mod.unmount();
});

test('typing a plugin name offers it, and taking it places a VST node with that plugin loaded', () => {
  const hub = setupHub({ withMinilab: false });
  const catalogue = [
    { pluginId: 'C:/VST3/ValhallaSupermassive.vst3', name: 'ValhallaSupermassive', manufacturer: 'Valhalla DSP, LLC', category: 'Fx|Reverb', role: 'effect' },
    { pluginId: 'C:/VST3/ValhallaDelay.vst3', name: 'ValhallaDelay', manufacturer: 'Valhalla DSP, LLC', category: 'Fx|Delay', role: 'effect' },
    { pluginId: 'C:/VST3/Dexed.vst3', name: 'Dexed', manufacturer: 'Digital Suburban', category: 'Instrument|Synth', role: 'instrument' }
  ];
  const loaded = [];
  hub.engine = {
    plugins: catalogue,
    getPlugin: (id) => catalogue.find((plugin) => plugin.pluginId === id) || null,
    createInstance: (chainId, pluginId, instanceId) => loaded.push({ chainId, pluginId, instanceId })
  };
  hub.nodes.hub.engine = hub.engine;
  const { svg, mod } = mount(hub);
  fire(svg, 'contextmenu', { target: svg, clientX: 700, clientY: 520 });
  const menu = openMenu();
  const visible = () => menuEntries(menu).filter((entry) => entry.hidden !== true).map(entryLabel);
  const headings = () => menu.children.filter((c) => c._classSet.has('ctx-group') && c.hidden !== true).map((c) => c.textContent);

  // Untyped, the plugins wait: the menu is the node types, as before.
  assert.equal(visible().includes('Dexed'), false);
  assert.equal(headings().includes('Installed plugins'), false);

  const field = findClass(menu, 'ctx-search');
  field.value = 'val';
  fire(field, 'input');
  assert.deepEqual(visible(), ['ValhallaDelay', 'ValhallaSupermassive'], 'in the order of their names');
  assert.deepEqual(headings(), ['Installed plugins']);
  // The maker is shown beside the name, and found too.
  field.value = 'suburban';
  fire(field, 'input');
  assert.deepEqual(visible(), ['Dexed']);

  field.value = 'val';
  fire(field, 'input');
  pickEntry('ValhallaSupermassive');
  const node = hub.nodes.list().find((instance) => instance.type === 'vst');
  assert.ok(node, 'a VST node was placed');
  assert.deepEqual(hub.settings.get('networkLayout')[node.id], { x: 700, y: 520 }, 'where the menu was opened');
  assert.deepEqual(node.content.plugins.map((plugin) => plugin.pluginId), ['C:/VST3/ValhallaSupermassive.vst3'],
    'with the plugin already in its chain');
  assert.deepEqual(loaded.map((entry) => [entry.chainId, entry.pluginId]), [[node.id, 'C:/VST3/ValhallaSupermassive.vst3']],
    'and the engine asked to load it');
  assert.ok(findNode(nodesLayerOf(svg), node.id)._classSet.has('selected'), 'and it is selected');
  mod.unmount();
});

test('a double-click on the empty canvas opens the node list there', () => {
  const hub = setupHub({ withMinilab: false });
  const { svg, mod } = mount(hub);
  fire(svg, 'pointerdown', { button: 0, target: svg, clientX: 650, clientY: 480 });
  fire(svg, 'pointerup', {});
  assert.equal(openMenu(), null, 'one click is a click');
  fire(svg, 'pointerdown', { button: 0, target: svg, clientX: 651, clientY: 480 });
  fire(svg, 'pointerup', {});
  assert.ok(findClass(openMenu(), 'ctx-search'), 'two, in place, open the node list');
  pickEntry('Arpeggiator');
  assert.deepEqual(hub.settings.get('networkLayout')['arpeggiator-001'], { x: 651, y: 480 });
  mod.unmount();
});

test('created node appears at the context world position', () => {
  const hub = setupHub({ withMinilab: false, layout: { 'vst-001': { x: 500, y: 500 } } });
  hub.nodes.create('vst'); // vst-001
  const { svg, mod } = mount(hub);
  fire(svg, 'contextmenu', { target: svg, clientX: 100, clientY: 100 });
  pickEntry('VST');
  const created = hub.nodes.get('vst-002');
  assert.ok(created, 'node created from the menu');
  assert.deepEqual(hub.settings.get('networkLayout')['vst-002'], { x: 100, y: 100 });
  mod.unmount();
});

test('a right-click on a cable offers to unplug it', () => {
  const hub = setupHub({ withMinilab: true });
  hub.nodes.create('vst'); // vst-001
  hub.network.connect('minilab-3', 'midi-out', 'vst-001', 'midi-in');
  const { svg, mod } = mount(hub);
  const hit = findClass(svg, 'cable-hit');
  assert.ok(hit?.dataset.cableId, 'the cable has a hit path');
  fire(svg, 'pointerdown', { button: 2, target: hit, clientX: 50, clientY: 50 });
  fire(svg, 'pointerup', {});
  fire(svg, 'contextmenu', { target: svg, clientX: 50, clientY: 50 });
  const heading = openMenu().children.find((child) => child._classSet.has('ctx-group'));
  assert.equal(heading.textContent, 'MiniLab 3 → VST 1', 'the menu names what the cable joins');
  pickEntry('Disconnect');
  assert.equal(hub.network.connections().length, 0);
  mod.unmount();
});

test('Ctrl+C copies every selected node, Ctrl+V pastes them in the same arrangement', () => {
  const hub = setupHub({ withMinilab: false, layout: { 'vst-001': { x: 100, y: 100 }, 'mixer-001': { x: 400, y: 160 } } });
  hub.nodes.create('vst');
  hub.nodes.create('mixer');
  const { svg, mod } = mount(hub);
  fireKey('a', svg, { ctrlKey: true });
  fireKey('c', svg, { ctrlKey: true });
  fire(svg, 'pointermove', { clientX: 500, clientY: 400 });
  fireKey('v', svg, { ctrlKey: true });
  const layout = hub.settings.get('networkLayout');
  assert.deepEqual(layout['vst-002'], { x: 500, y: 400 });
  assert.deepEqual(layout['mixer-002'], { x: 800, y: 460 }, 'the second keeps its place against the first');
  assert.deepEqual([...nodesLayerOf(svg).children].filter((c) => c._classSet.has('selected')).map((c) => c.dataset.nodeId).sort(),
    ['mixer-002', 'vst-002'], 'what was pasted is selected');
  mod.unmount();
});

test('Ctrl+D duplicates the selection beside it and leaves the clipboard alone', () => {
  const hub = setupHub({ withMinilab: false, layout: { 'vst-001': { x: 2000, y: 2000 }, 'mixer-001': { x: 100, y: 100 } } });
  hub.nodes.create('vst');
  hub.nodes.create('mixer');
  const { svg, mod } = mount(hub);
  clickNode(svg, findNode(nodesLayerOf(svg), 'mixer-001'));
  fireKey('c', svg, { ctrlKey: true });
  clickNode(svg, findNode(nodesLayerOf(svg), 'vst-001'));
  fireKey('d', svg, { ctrlKey: true });
  assert.ok(hub.nodes.get('vst-002'), 'a copy of the VST');
  const original = hub.settings.get('networkLayout')['vst-001'];
  const copy = hub.settings.get('networkLayout')['vst-002'];
  assert.ok(copy.x > original.x && copy.y > original.y, 'beside the original, not on it');
  fire(svg, 'pointermove', { clientX: 600, clientY: 600 });
  fireKey('v', svg, { ctrlKey: true });
  assert.ok(hub.nodes.get('mixer-002'), 'the clipboard still holds the Mixer');
  mod.unmount();
});

// ---- visual / node model -------------------------------------------------------
test('family identity comes from the central registry, drawn as the card corner', () => {
  const hub = setupHub({ withMinilab: false });
  hub.nodes.create('vst');
  hub.nodes.create('arpeggiator');
  const { svg, mod } = mount(hub);
  const layer = nodesLayerOf(svg);
  const vst = findNode(layer, 'vst-001');
  assert.ok(vst._classSet.has('node-type-vst'), 'type class present');
  assert.ok(vst._classSet.has('family-plugin'), 'a VST is of the Plugin family');
  assert.ok(findNode(layer, 'arpeggiator-001')._classSet.has('family-midi'), 'an Arpeggiator of the MIDI one');
  assert.ok(findClass(vst, 'node-corner'), 'the family is drawn as the top-left corner');
  mod.unmount();
});

test('VST family keeps the exact centralized orange identity', () => {
  const cssPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/renderer/styles/base.css');
  const css = fs.readFileSync(cssPath, 'utf8');
  assert.match(css, /--accent-vst:\s*#e08a3c/i, 'centralized orange VST accent');
});

test('an empty VST says so on its readout, dimmed', () => {
  const hub = setupHub({ withMinilab: false });
  hub.nodes.create('vst');
  const { svg, mod } = mount(hub);
  const vst = findNode(nodesLayerOf(svg), 'vst-001');
  assert.deepEqual(readoutText(vst), ['No plugin']);
  assert.ok(findClass(vst, 'node-readout-text')._classSet.has('tone-dim'), 'an absence is dimmed');
  mod.unmount();
});

test('selected state is independent from family/type state', () => {
  const hub = setupHub({ withMinilab: false });
  hub.nodes.create('vst');
  const { svg, mod } = mount(hub);
  const layer = nodesLayerOf(svg);
  const vst = findNode(layer, 'vst-001');
  clickNode(svg, vst);
  assert.ok(vst._classSet.has('selected'), 'selected');
  assert.ok(vst._classSet.has('node-type-vst'), 'type preserved while selected');
  assert.ok(vst._classSet.has('family-plugin'), 'family preserved while selected');
  assert.ok(findClass(vst, 'node-corner'), 'family corner preserved');
  assert.ok(findClass(vst, 'node-readout'), 'readout preserved');
  mod.unmount();
});

test('redesigned node geometry produces correct cable endpoints', () => {
  const node = {
    inputs: [{ id: 'midi-in', type: 'midi' }, { id: 'audio-in', type: 'audio' }],
    outputs: [{ id: 'audio-out', type: 'audio' }]
  };
 const geo = nodeGeometry(node, { x: 100, y: 200 });
  assert.equal(geo.width, NODE_WIDTH);
  assert.equal(geo.height, nodeHeight(node));
  // Inputs on the left edge, outputs on the right edge.
  assert.equal(geo.inputs[0].x, 100);
  assert.equal(geo.outputs[0].x, 100 + NODE_WIDTH);
  // Ports live inside the I/O dock (below the identity area).
  assert.ok(geo.inputs[0].y >= 200 + IDENTITY_H, 'input in dock');
  assert.ok(geo.outputs[0].y >= 200 + IDENTITY_H, 'output in dock');
});

test('MiniLab MIDI OUT uses one canonical socket center for drag and cables', () => {
  const node = {
    id: 'minilab-3',
    surface: MINILAB_SURFACE,
    inputs: [{ id: 'midi-in', type: 'midi' }],
    outputs: [{ id: 'midi-out', type: 'midi' }]
  };
  const moved = nodeGeometry(node, { x: 137, y: 91 });
  const socket = moved.outputs.find((item) => item.port.id === 'midi-out');
  assert.deepEqual({ x: socket.x, y: socket.y }, { x: 137 + NODE_WIDTH, y: 91 + 146 });
  assert.deepEqual(
    { x: moved.inputs[0].x, y: moved.inputs[0].y },
    { x: 137, y: 91 + 146 },
    'declared hardware MIDI input remains visible and cable-addressable'
  );
  // Viewport zoom/pan never enters canonical world geometry; SVG viewBox
  // transforms this same point for both temporary and committed paths.
  assert.deepEqual(nodeGeometry(node, { x: 137, y: 91 }).outputs[0], socket);
});

/**
 * The Patch Bay used to decide by name: `node.id === MINILAB_NODE_ID` chose
 * between a faceplate and a stack of ports, which meant a second controller would
 * have got 25 ports at 30 px each — a node roughly 760 px tall. It now decides by
 * what the node declares, and this test is the one that would notice the name
 * creeping back in.
 */
test('geometry follows the declared surface, not the node name', () => {
  const named = {
    id: 'minilab-3',
    inputs: [{ id: 'midi-in', type: 'midi' }],
    outputs: [{ id: 'midi-out', type: 'midi' }]
  };
  const dock = nodeGeometry(named, { x: 0, y: 0 });
  assert.equal(dock.height, IDENTITY_H + dockHeight(named), 'the famous id alone buys nothing');
  assert.ok(dock.outputs[0].y < surfacePortRowY(MINILAB_SURFACE),
    'a node with no surface stacks its ports in the dock');

  const stranger = {
    id: 'launchkey-49',
    surface: MINILAB_SURFACE,
    inputs: [{ id: 'midi-in', type: 'midi' }],
    outputs: [{ id: 'midi-out', type: 'midi' }]
  };
  const surface = nodeGeometry(stranger, { x: 0, y: 0 });
  assert.equal(surface.height, surfaceNodeHeight(MINILAB_SURFACE), 'any node that declares a surface gets one');
  assert.deepEqual(
    { x: surface.outputs.at(-1).x, y: surface.outputs.at(-1).y },
    { x: NODE_WIDTH, y: surfacePortRowY(MINILAB_SURFACE) },
    'and its remaining ports keep their single row below the faceplate'
  );
  assert.equal(surface.outputs.length, 1, 'control ports it does not declare are not invented');
});

test('fit/reset includes the complete redesigned node bounds', () => {
  const node = { inputs: [{ id: 'a', type: 'midi' }], outputs: [{ id: 'o', type: 'audio' }] };
  const geo = nodeGeometry(node, { x: 0, y: 0 });
  assert.ok(geo.height > IDENTITY_H, 'height includes the I/O dock');
  const vp = fitViewport([{ x: 0, y: 0, width: geo.width, height: geo.height }], { width: 800, height: 600 });
  const worldW = 800 / vp.zoom;
  const worldH = 600 / vp.zoom;
  assert.ok(worldW >= geo.width, 'fit width covers full node');
  assert.ok(worldH >= geo.height, 'fit height covers full node (incl. dock)');
});
