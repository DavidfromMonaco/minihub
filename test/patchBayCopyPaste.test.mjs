import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
const { listNodeTypes } = await import('../src/renderer/js/core/nodeTypes.js');
const {
  nodeGeometry,
  nodeHeight,
  NODE_WIDTH,
  IDENTITY_H
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
    graphViewport: { x: 0, y: 0, zoom: 1 },
    ...(Object.keys(layout).length ? { graphLayout: layout } : {})
  });
  const modules = new ModuleSystem(hub);
  const nodes = new NodeInstanceManager({ events: hub.events, settings: hub.settings, graph: hub.graph, modules });
  hub.modules = modules;
  hub.nodes = nodes;
  if (withMinilab) {
    hub.graph.addNode({ id: 'minilab-3', name: 'MiniLab 3', outputs: [{ id: 'midi-out', type: 'midi' }] });
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

test('external graph connections are NOT copied on paste', () => {
  const hub = setupHub({ withMinilab: true });
  const src = hub.nodes.create('vst'); // vst-001
  hub.graph.connect('minilab-3', 'midi-out', 'vst-001', 'midi-in');
  assert.equal(hub.graph.connections().length, 1);
  const { svg, mod } = mount(hub);
  const layer = nodesLayerOf(svg);
  clickNode(svg, findNode(layer, 'vst-001'));
  fireKey('c', svg, { ctrlKey: true });
  fireKey('v', svg, { ctrlKey: true });
  const pasted = hub.nodes.get('vst-002');
  assert.equal(hub.graph.connections().length, 1, 'no copied connections');
  assert.equal(hub.graph.connectionsTo(pasted.id).length, 0);
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
  const pos = hub.settings.get('graphLayout')['vst-002'];
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
  const pos = hub.settings.get('graphLayout')['vst-002'];
  assert.deepEqual(pos, { x: 120, y: 90 });
  mod.unmount();
});

test('keyboard Paste uses viewport center when pointer is not over the canvas', () => {
  const hub = setupHub({ withMinilab: false, layout: { 'vst-001': { x: 500, y: 500 } } });
  hub.nodes.create('vst'); // vst-001
  const { svg, mod } = mount(hub);
  const layer = nodesLayerOf(svg);
  clickNode(svg, findNode(layer, 'vst-001'));
  fireKey('c', svg, { ctrlKey: true });
  // No pointermove -> lastPointerClient is null -> viewport center (400,300).
  fireKey('v', svg, { ctrlKey: true });
  const pos = hub.settings.get('graphLayout')['vst-002'];
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

test('New Node submenu uses the Node Type Registry', () => {
  const hub = setupHub({ withMinilab: false });
  const { container, svg, mod } = mount(hub);
  fire(svg, 'contextmenu', { target: svg, clientX: 100, clientY: 80 });
  const menu = findClass(container, 'node-context-menu');
  const sub = findClass(menu, 'ctx-sub');
  const labels = [...sub.children].map((c) => c.textContent);
  const registryLabels = listNodeTypes().map((t) => t.label);
  assert.deepEqual(labels, registryLabels, 'submenu driven by registry');
  mod.unmount();
});

test('created node appears at the context world position', () => {
  const hub = setupHub({ withMinilab: false, layout: { 'vst-001': { x: 500, y: 500 } } });
  hub.nodes.create('vst'); // vst-001
  const { container, svg, mod } = mount(hub);
  fire(svg, 'contextmenu', { target: svg, clientX: 100, clientY: 100 });
  const menu = findClass(container, 'node-context-menu');
  const sub = findClass(menu, 'ctx-sub');
  const vstItem = [...sub.children].find((c) => c.textContent === 'VST');
  [...vstItem._listeners['click']].forEach((fn) => fn());
  const created = hub.nodes.get('vst-002');
  assert.ok(created, 'node created from submenu');
  assert.deepEqual(hub.settings.get('graphLayout')['vst-002'], { x: 100, y: 100 });
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
