import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MINILAB_SURFACE } from '../src/renderer/js/ui/miniLabControlSurface.js';
import { makeHub } from './helpers.mjs';
import { makeEl, installDom, fire, fireKey, findClass } from './domShim.mjs';

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
function clickMenuItem(menu, label) {
  const item = [...menu.children].find((c) => c._classSet.has('ctx-item') && c.textContent === label);
  assert.ok(item, `menu item "${label}" present`);
  [...item._listeners['click']].forEach((fn) => fn());
  return item;
}

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

function badgeText(badgeG) {
  const t = badgeG.children.find((c) => c._classSet.has('node-badge-text'));
  return t ? t.textContent : null;
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

test('context-menu Copy copies the context target without changing selection', () => {
  const hub = setupHub({ withMinilab: false });
  hub.nodes.create('vst'); // vst-001
  hub.nodes.create('vst'); // vst-002
  const { container, svg, mod } = mount(hub);
  const layer = nodesLayerOf(svg);
  const a = findNode(layer, 'vst-001');
  const b = findNode(layer, 'vst-002');
  clickNode(svg, a); // select A
  // Right-click B -> context menu for B.
  fire(svg, 'contextmenu', { target: nodePanel(b), clientX: 200, clientY: 120 });
  const menu = findClass(container, 'node-context-menu');
  clickMenuItem(menu, 'Copy');
  assert.ok(a._classSet.has('selected'), 'A remains selected after Copy');
  assert.ok(!b._classSet.has('selected'), 'B not auto-selected');
  // Paste -> duplicates B (vst-002) -> vst-003, which becomes selected.
  fireKey('v', svg, { ctrlKey: true });
 const pasted = hub.nodes.get('vst-003');
  assert.ok(pasted, 'pasted node created from context target');
  const layerAfter = nodesLayerOf(svg);
  const pastedEl = findNode(layerAfter, 'vst-003');
  assert.ok(pastedEl && pastedEl._classSet.has('selected'), 'pasted node becomes selected');
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
  const menu = findClass(container, 'node-context-menu');
  clickMenuItem(menu, 'Paste');
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
  const { container, svg, mod } = mount(hub);
  fire(svg, 'contextmenu', { target: svg, clientX: 100, clientY: 80 });
  const menu = findClass(container, 'node-context-menu');
  assert.ok(menu, 'canvas menu opened');
  const sub = findClass(menu, 'ctx-sub');
  assert.ok(sub, 'New Node submenu present');
  const paste = [...menu.children].find((c) => c._classSet.has('ctx-item') && c.textContent === 'Paste');
  assert.ok(paste, 'Paste item present');
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
  assert.ok(!findClass(container, 'node-context-menu'), 'no menu after pan');
  mod.unmount();
});

test('Paste is disabled when the clipboard is empty', () => {
  const hub = setupHub({ withMinilab: false });
  const { container, svg, mod } = mount(hub);
  fire(svg, 'contextmenu', { target: svg, clientX: 100, clientY: 80 });
  const menu = findClass(container, 'node-context-menu');
  const paste = [...menu.children].find((c) => c._classSet.has('ctx-item') && c.textContent === 'Paste');
  assert.equal(paste.disabled, true, 'Paste disabled with empty clipboard');
  mod.unmount();
});

test('OmniBox submenu uses populated registry families', () => {
  const hub = setupHub({ withMinilab: false });
  const { container, svg, mod } = mount(hub);
  fire(svg, 'contextmenu', { target: svg, clientX: 100, clientY: 80 });
  const menu = findClass(container, 'node-context-menu');
  const sub = findClass(menu, 'ctx-sub');
  const categories = [...sub.children].map((wrap) => ({
    label: wrap.children[0].textContent.trim().split(/\s+/)[0],
    types: [...wrap.children[1].children].map((item) => item.textContent)
  }));
  assert.deepEqual(categories, listOmniBoxCategories().map((category) => ({
    label: category.label, types: category.types.map((type) => type.label)
  })), 'hierarchy driven by populated registry families');
  mod.unmount();
});

test('nested OmniBox keeps exactly one active submenu path per level', () => {
  const hub = setupHub({ withMinilab: false });
  const { container, svg, mod } = mount(hub);
  fire(svg, 'contextmenu', { target: svg, clientX: 100, clientY: 80 });
  const menu = findClass(container, 'node-context-menu');
  const rootWrap = menu.children.find((child) => child._classSet.has('ctx-submenu'));
  const categories = rootWrap.children.find((child) => child._classSet.has('ctx-sub'));
  const [midi, audio, plugin] = categories.children;

  assert.equal(rootWrap._classSet.has('ctx-expanded'), false, 'root starts collapsed');
  assert.ok([midi, audio, plugin].every((item) => !item._classSet.has('ctx-expanded')),
    'no category child starts exposed');

  fire(rootWrap, 'pointerenter');
  assert.equal(rootWrap._classSet.has('ctx-expanded'), true, 'hover opens only OmniBox categories');
  fire(midi, 'pointerenter');
  assert.equal(midi._classSet.has('ctx-expanded'), true, 'MIDI child opens');

  fire(audio, 'pointerenter');
  assert.equal(midi._classSet.has('ctx-expanded'), false, 'moving to Audio closes MIDI child');
  assert.equal(audio._classSet.has('ctx-expanded'), true, 'Audio child opens');
  assert.equal(plugin._classSet.has('ctx-expanded'), false, 'unrelated Plugin child remains closed');
  mod.unmount();
});

test('created node appears at the context world position', () => {
  const hub = setupHub({ withMinilab: false, layout: { 'vst-001': { x: 500, y: 500 } } });
  hub.nodes.create('vst'); // vst-001
  const { container, svg, mod } = mount(hub);
  fire(svg, 'contextmenu', { target: svg, clientX: 100, clientY: 100 });
  const menu = findClass(container, 'node-context-menu');
  const sub = findClass(menu, 'ctx-sub');
  const pluginCategory = [...sub.children].find((c) => c.children[0].textContent.includes('Plugin'));
  const vstItem = [...pluginCategory.children[1].children].find((c) => c.textContent === 'VST');
  [...vstItem._listeners['click']].forEach((fn) => fn());
  const created = hub.nodes.get('vst-002');
  assert.ok(created, 'node created from submenu');
  assert.deepEqual(hub.settings.get('networkLayout')['vst-002'], { x: 100, y: 100 });
  mod.unmount();
});

// ---- visual / node model -------------------------------------------------------
test('family identity comes from the central registry class', () => {
  const hub = setupHub({ withMinilab: false });
  hub.nodes.create('vst');
  const { svg, mod } = mount(hub);
  const layer = nodesLayerOf(svg);
  const vst = findNode(layer, 'vst-001');
  assert.ok(vst._classSet.has('node-type-vst'), 'family class present');
  const familyBadge = findClass(vst, 'family');
  assert.ok(familyBadge, 'family badge present');
  assert.equal(badgeText(familyBadge), 'VST');
  mod.unmount();
});

test('VST family keeps the exact centralized orange identity', () => {
  const cssPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/renderer/styles/base.css');
  const css = fs.readFileSync(cssPath, 'utf8');
  assert.match(css, /--accent-vst:\s*#e08a3c/i, 'centralized orange VST accent');
});

test('EMPTY uses a neutral type identity', () => {
  const hub = setupHub({ withMinilab: false });
  hub.nodes.create('vst');
  const { svg, mod } = mount(hub);
  const layer = nodesLayerOf(svg);
  const vst = findNode(layer, 'vst-001');
  const typeBadge = findClass(vst, 'type');
  assert.ok(typeBadge, 'type badge present');
  assert.ok(typeBadge._classSet.has('empty'), 'empty type class');
  assert.equal(badgeText(typeBadge), 'EMPTY');
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
  assert.ok(vst._classSet.has('node-type-vst'), 'family preserved while selected');
  assert.ok(findClass(vst, 'family'), 'family badge preserved');
  assert.ok(findClass(vst, 'type'), 'type badge preserved');
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
