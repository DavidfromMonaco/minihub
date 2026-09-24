import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHub } from './helpers.mjs';
import { GRID_SIZE } from '../src/renderer/js/core/grid.js';
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

// ---- event simulation helpers -------------------------------------------------
function fireDocumentPointer(target) {
  const evt = { target };
  const listeners = document._listeners['pointerdown'];
  if (listeners) [...listeners].forEach((fn) => fn(evt));
  return evt;
}

// ---- fixtures -----------------------------------------------------------------
function setupHub() {
  // Seed a persisted 1:1 viewport so drag math is deterministic (no fit).
  const hub = makeHub({ networkViewport: { x: 0, y: 0, zoom: 1 } });
  const modules = new ModuleSystem(hub);
  const nodes = new NodeInstanceManager({ events: hub.events, settings: hub.settings, network: hub.network, modules });
  hub.modules = modules;
  hub.nodes = nodes;
  // Native MiniLab routing node (not a user-created instance).
  hub.network.addNode({ id: 'minilab-3', name: 'MiniLab 3', outputs: [{ id: 'midi-out', type: 'midi' }] });
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

// Pointer events are registered on the svg; the target is the node panel so
// `closest('.node')` resolves to the node group.
function clickNode(svg, nodeG, opts = {}) {
  fire(svg, 'pointerdown', { button: 0, target: nodePanel(nodeG), clientX: 5, clientY: 5, ...opts });
  fire(svg, 'pointerup', {});
}

// ---- selection -----------------------------------------------------------------
test('left-click selects a node (blue selected state)', () => {
  const hub = setupHub();
  hub.nodes.create('vst'); // vst-001
  const { svg, mod } = mount(hub);
  const layer = nodesLayerOf(svg);
  const vst = findNode(layer, 'vst-001');
  assert.ok(vst, 'vst node rendered');
  assert.ok(!vst._classSet.has('selected'), 'not selected before click');
  clickNode(svg, vst);
  assert.ok(vst._classSet.has('selected'), 'node selected after click');
  mod.unmount();
});

test('only one node is selected at a time', () => {
  const hub = setupHub();
  hub.nodes.create('vst'); // vst-001
  hub.nodes.create('vst'); // vst-002
  const { svg, mod } = mount(hub);
  const layer = nodesLayerOf(svg);
  const a = findNode(layer, 'vst-001');
  const b = findNode(layer, 'vst-002');
  clickNode(svg, a);
  assert.ok(a._classSet.has('selected'));
  assert.ok(!b._classSet.has('selected'));
  clickNode(svg, b);
  assert.ok(!a._classSet.has('selected'), 'previous selection replaced');
  assert.ok(b._classSet.has('selected'), 'new node selected');
  mod.unmount();
});

test('selected node keeps its type accent class', () => {
  const hub = setupHub();
  hub.nodes.create('vst'); // vst-001
  const { svg, mod } = mount(hub);
  const layer = nodesLayerOf(svg);
  const vst = findNode(layer, 'vst-001');
  assert.ok(vst._classSet.has('node-type-vst'), 'type accent present');
  clickNode(svg, vst);
  assert.ok(vst._classSet.has('selected'), 'selected class present');
  assert.ok(vst._classSet.has('node-type-vst'), 'type accent preserved while selected');
  mod.unmount();
});

test('clicking empty canvas clears node selection', () => {
  const hub = setupHub();
  hub.nodes.create('vst');
  const { svg, mod } = mount(hub);
  const layer = nodesLayerOf(svg);
  const vst = findNode(layer, 'vst-001');
  clickNode(svg, vst);
  assert.ok(vst._classSet.has('selected'));
  // Click empty canvas (target = svg itself, not a node/port).
  fire(svg, 'pointerdown', { button: 0, target: svg, clientX: 400, clientY: 300 });
  fire(svg, 'pointerup', {});
  assert.ok(!vst._classSet.has('selected'), 'selection cleared on empty canvas click');
  mod.unmount();
});

test('dragging a node also selects it', () => {
  const hub = setupHub();
  hub.nodes.create('vst');
  const { svg, mod } = mount(hub);
  const layer = nodesLayerOf(svg);
  const vst = findNode(layer, 'vst-001');
  fire(svg, 'pointerdown', { button: 0, clientX: 0, clientY: 0, target: nodePanel(vst) });
  fire(svg, 'pointermove', { clientX: 30, clientY: 10 });
  fire(svg, 'pointerup', {});
  assert.ok(vst._classSet.has('selected'), 'node selected after drag');
  mod.unmount();
});

test('Ctrl + left-drag selects the node and snaps to grid', () => {
  const hub = setupHub();
  hub.nodes.create('vst');
  const { svg, mod } = mount(hub);
  const layer = nodesLayerOf(svg);
  const vst = findNode(layer, 'vst-001');
  fire(svg, 'pointerdown', { button: 0, clientX: 0, clientY: 0, target: nodePanel(vst) });
  fire(svg, 'pointermove', { clientX: 23, clientY: 17, ctrlKey: true });
  fire(svg, 'pointerup', {});
  assert.ok(vst._classSet.has('selected'), 'Ctrl-drag selects node');
  const pos = hub.settings.get('networkLayout')['vst-001'];
  assert.ok(pos, 'node position persisted');
  assert.equal(pos.x % GRID_SIZE, 0, 'x snapped to grid');
  assert.equal(pos.y % GRID_SIZE, 0, 'y snapped to grid');
  mod.unmount();
});

test('selecting nodes does not change routing/cables', () => {
  const hub = setupHub();
  hub.nodes.create('vst'); // vst-001 (midi-in)
  hub.network.connect('minilab-3', 'midi-out', 'vst-001', 'midi-in');
  const before = hub.network.serialize();
  const { svg, mod } = mount(hub);
  const layer = nodesLayerOf(svg);
  const vst = findNode(layer, 'vst-001');
  clickNode(svg, vst);
  assert.deepEqual(hub.network.serialize(), before, 'routing unchanged by selection');
  assert.equal(hub.network.connections().length, 1);
  mod.unmount();
});

// ---- Delete key ----------------------------------------------------------------
test('Delete removes the selected dynamic node', () => {
  const hub = setupHub();
  hub.nodes.create('vst'); // vst-001
  const { svg, mod } = mount(hub);
  const layer = nodesLayerOf(svg);
  const vst = findNode(layer, 'vst-001');
  clickNode(svg, vst);
  assert.ok(vst._classSet.has('selected'));
  fireKey('Delete', svg);
  assert.equal(hub.nodes.get('vst-001'), null, 'instance removed');
  assert.ok(!hub.network.getNode('vst-001'), 'routing node removed');
  mod.unmount();
});

test('Delete does not remove the native MiniLab node', () => {
  const hub = setupHub();
  const { svg, mod } = mount(hub);
  const layer = nodesLayerOf(svg);
  const ml = findNode(layer, 'minilab-3');
  clickNode(svg, ml);
  assert.ok(ml._classSet.has('selected'));
  fireKey('Delete', svg);
  assert.ok(hub.network.getNode('minilab-3'), 'native node still present');
  assert.ok(ml._classSet.has('selected'), 'selection untouched (do nothing)');
  mod.unmount();
});

test('Delete is ignored while editing an input control', () => {
  const hub = setupHub();
  hub.nodes.create('vst'); // vst-001
  const { svg, mod } = mount(hub);
  const layer = nodesLayerOf(svg);
  const vst = findNode(layer, 'vst-001');
  clickNode(svg, vst);
  const input = makeEl('input');
  fireKey('Delete', input);
  assert.ok(hub.nodes.get('vst-001'), 'node not deleted while editing input');
  mod.unmount();
});

test('deleting the selected node clears the selection', () => {
  const hub = setupHub();
  hub.nodes.create('vst'); // vst-001
  const { svg, mod } = mount(hub);
  const layer = nodesLayerOf(svg);
  const vst = findNode(layer, 'vst-001');
  clickNode(svg, vst);
  fireKey('Delete', svg);
  // After deletion the node is gone; no node should remain selected.
  const remaining = layer.children.filter((c) => c._classSet.has('selected'));
  assert.equal(remaining.length, 0, 'no node remains selected after deleting it');
  mod.unmount();
});

// ---- context menu ----------------------------------------------------------------
test('right-click on a node opens the context menu', () => {
  const hub = setupHub();
  hub.nodes.create('vst');
  const { container, svg, mod } = mount(hub);
  const layer = nodesLayerOf(svg);
  const vst = findNode(layer, 'vst-001');
  fire(svg, 'contextmenu', { target: nodePanel(vst), clientX: 100, clientY: 80 });
  const menu = findClass(container, 'node-context-menu');
  assert.ok(menu, 'context menu opened');
  const item = findClass(menu, 'ctx-item');
  assert.ok(item, 'Delete Node action present');
  assert.equal(item.textContent, 'Delete Node');
  assert.equal(item.disabled, false, 'deletable node -> enabled');
  mod.unmount();
});

test('right-click on a node does NOT change the current selection', () => {
  const hub = setupHub();
  hub.nodes.create('vst'); // vst-001
  hub.nodes.create('vst'); // vst-002
  const { container, svg, mod } = mount(hub);
  const layer = nodesLayerOf(svg);
  const a = findNode(layer, 'vst-001');
  const b = findNode(layer, 'vst-002');
  // Select A.
  clickNode(svg, a);
  assert.ok(a._classSet.has('selected'));
  // Right-click B -> menu opens for B, but A stays selected.
  fire(svg, 'contextmenu', { target: nodePanel(b), clientX: 200, clientY: 120 });
  const menu = findClass(container, 'node-context-menu');
  assert.ok(menu, 'menu opened for B');
  assert.ok(a._classSet.has('selected'), 'A remains selected');
  assert.ok(!b._classSet.has('selected'), 'B is not selected');
  mod.unmount();
});

test('context-menu target is independent from the selected node', () => {
  const hub = setupHub();
  hub.nodes.create('vst'); // vst-001
  hub.nodes.create('vst'); // vst-002
  const { container, svg, mod } = mount(hub);
  const layer = nodesLayerOf(svg);
  const a = findNode(layer, 'vst-001');
  const b = findNode(layer, 'vst-002');
  clickNode(svg, a);
  fire(svg, 'contextmenu', { target: nodePanel(b), clientX: 200, clientY: 120 });
  // Delete the context target (B).
  const menu = findClass(container, 'node-context-menu');
  const item = findClass(menu, 'ctx-item');
  [...item._listeners['click']].forEach((fn) => fn());
  assert.equal(hub.nodes.get('vst-002'), null, 'context target deleted');
  assert.ok(hub.nodes.get('vst-001'), 'selected node untouched');
  // A still selected.
  const layerAfter = nodesLayerOf(svg);
  const aAfter = findNode(layerAfter, 'vst-001');
  assert.ok(aAfter && aAfter._classSet.has('selected'), 'selection preserved after deleting unselected target');
  mod.unmount();
});

test('deleting the selected node via context menu clears selection', () => {
  const hub = setupHub();
  hub.nodes.create('vst'); // vst-001
  const { container, svg, mod } = mount(hub);
  const layer = nodesLayerOf(svg);
  const vst = findNode(layer, 'vst-001');
  clickNode(svg, vst);
  fire(svg, 'contextmenu', { target: nodePanel(vst), clientX: 100, clientY: 80 });
  const menu = findClass(container, 'node-context-menu');
  const item = findClass(menu, 'ctx-item');
  [...item._listeners['click']].forEach((fn) => fn());
  assert.equal(hub.nodes.get('vst-001'), null);
  const layerAfter = nodesLayerOf(svg);
  assert.equal(layerAfter.children.filter((c) => c._classSet.has('selected')).length, 0);
  mod.unmount();
});

test('native node exposes no context menu (no Copy/Delete)', () => {
  const hub = setupHub();
  const { container, svg, mod } = mount(hub);
  const layer = nodesLayerOf(svg);
  const ml = findNode(layer, 'minilab-3');
  fire(svg, 'contextmenu', { target: nodePanel(ml), clientX: 100, clientY: 80 });
  assert.ok(!findClass(container, 'node-context-menu'), 'no context menu for native node');
  mod.unmount();
});

// ---- context menu lifecycle -----------------------------------------------------
test('context menu closes on outside click', () => {
  const hub = setupHub();
  hub.nodes.create('vst');
  const { container, svg, mod } = mount(hub);
  const layer = nodesLayerOf(svg);
  const vst = findNode(layer, 'vst-001');
  fire(svg, 'contextmenu', { target: nodePanel(vst), clientX: 100, clientY: 80 });
  assert.ok(findClass(container, 'node-context-menu'), 'menu open');
  // Click outside the menu (target = svg).
  fireDocumentPointer(svg);
  assert.ok(!findClass(container, 'node-context-menu'), 'menu closed on outside click');
  mod.unmount();
});

test('context menu closes on Escape', () => {
  const hub = setupHub();
  hub.nodes.create('vst');
  const { container, svg, mod } = mount(hub);
  const layer = nodesLayerOf(svg);
  const vst = findNode(layer, 'vst-001');
  fire(svg, 'contextmenu', { target: nodePanel(vst), clientX: 100, clientY: 80 });
  assert.ok(findClass(container, 'node-context-menu'), 'menu open');
  fireKey('Escape', svg);
  assert.ok(!findClass(container, 'node-context-menu'), 'menu closed on Escape');
  mod.unmount();
});

test('opening another context menu replaces the previous one', () => {
  const hub = setupHub();
  hub.nodes.create('vst'); // vst-001
  hub.nodes.create('vst'); // vst-002
  const { container, svg, mod } = mount(hub);
  const layer = nodesLayerOf(svg);
  const a = findNode(layer, 'vst-001');
  const b = findNode(layer, 'vst-002');
  fire(svg, 'contextmenu', { target: nodePanel(a), clientX: 100, clientY: 80 });
  assert.ok(findClass(container, 'node-context-menu'));
  fire(svg, 'contextmenu', { target: nodePanel(b), clientX: 300, clientY: 200 });
  const menus = container.children.filter((c) => c._classSet.has('node-context-menu'));
  assert.equal(menus.length, 1, 'only one menu remains');
  mod.unmount();
});

// ---- pan compatibility -----------------------------------------------------------
test('right-drag empty canvas still pans and does not open a node menu', () => {
  const hub = setupHub();
  hub.nodes.create('vst');
  const { container, svg, mod } = mount(hub);
  const vbBefore = svg.getAttribute('viewBox');
  // Right-drag on empty canvas (target = svg). First move crosses the pan
  // threshold (starts the pan), subsequent moves actually pan.
  fire(svg, 'pointerdown', { button: 2, target: svg, clientX: 100, clientY: 100 });
  fire(svg, 'pointermove', { clientX: 160, clientY: 140 });
  fire(svg, 'pointermove', { clientX: 220, clientY: 180 });
  fire(svg, 'pointerup', {});
  const vbAfter = svg.getAttribute('viewBox');
  assert.notEqual(vbAfter, vbBefore, 'viewBox changed -> panned');
  // Releasing over a node must NOT open a context menu (pan suppression).
  const layer = nodesLayerOf(svg);
  const vst = findNode(layer, 'vst-001');
  fire(svg, 'contextmenu', { target: nodePanel(vst), clientX: 160, clientY: 140 });
  assert.ok(!findClass(container, 'node-context-menu'), 'no menu opened after pan');
  mod.unmount();
});

// ---- several nodes (asked 2026-09-24: "shift, ctrl, and drawing a zone") -----
const at = (layer, id) => {
  const [, x, y] = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(findNode(layer, id).getAttribute('transform'));
  return { x: Number(x), y: Number(y) };
};
const selectedIds = (layer) => layer.children.filter((c) => c._classSet.has('selected')).map((c) => c.dataset.nodeId).sort();

test('Shift + click adds a node, Ctrl + click on a selected one takes it out', () => {
  const hub = setupHub();
  hub.nodes.create('vst');
  hub.nodes.create('vst');
  hub.nodes.create('mixer');
  const { svg, mod } = mount(hub);
  const layer = nodesLayerOf(svg);
  clickNode(svg, findNode(layer, 'vst-001'));
  clickNode(svg, findNode(layer, 'vst-002'), { shiftKey: true });
  clickNode(svg, findNode(nodesLayerOf(svg), 'mixer-001'), { ctrlKey: true });
  assert.deepEqual(selectedIds(nodesLayerOf(svg)), ['mixer-001', 'vst-001', 'vst-002']);
  clickNode(svg, findNode(nodesLayerOf(svg), 'vst-002'), { ctrlKey: true });
  assert.deepEqual(selectedIds(nodesLayerOf(svg)), ['mixer-001', 'vst-001']);
  clickNode(svg, findNode(nodesLayerOf(svg), 'vst-001'));
  assert.deepEqual(selectedIds(nodesLayerOf(svg)), ['vst-001'], 'a plain click narrows the selection to that node');
  mod.unmount();
});

test('dragging one of several selected nodes moves them all, by the same amount', () => {
  const hub = setupHub();
  hub.nodes.create('vst');
  hub.nodes.create('vst');
  hub.nodes.create('vst');
  const { svg, mod } = mount(hub);
  const layer = nodesLayerOf(svg);
  clickNode(svg, findNode(layer, 'vst-001'));
  clickNode(svg, findNode(layer, 'vst-002'), { shiftKey: true });
  const before = Object.fromEntries(['vst-001', 'vst-002', 'vst-003'].map((id) => [id, at(layer, id)]));
  fire(svg, 'pointerdown', { button: 0, clientX: 0, clientY: 0, target: nodePanel(findNode(layer, 'vst-002')) });
  fire(svg, 'pointermove', { clientX: 40, clientY: 30 });
  fire(svg, 'pointerup', {});
  const after = hub.settings.get('networkLayout');
  after['vst-003'] ??= at(nodesLayerOf(svg), 'vst-003');
  for (const id of ['vst-001', 'vst-002']) {
    assert.deepEqual([after[id].x - before[id].x, after[id].y - before[id].y], [40, 30], `${id} moved`);
  }
  assert.deepEqual(after['vst-003'], before['vst-003'], 'the node left out stays');
  assert.deepEqual(selectedIds(nodesLayerOf(svg)), ['vst-001', 'vst-002'], 'and the selection survives the drag');
  mod.unmount();
});

test('Delete removes every selected node, and leaves the MiniLab', () => {
  const hub = setupHub();
  hub.nodes.create('vst');
  hub.nodes.create('mixer');
  const { svg, mod } = mount(hub);
  const layer = nodesLayerOf(svg);
  clickNode(svg, findNode(layer, 'vst-001'));
  clickNode(svg, findNode(layer, 'mixer-001'), { shiftKey: true });
  clickNode(svg, findNode(layer, 'minilab-3'), { shiftKey: true });
  fireKey('Delete', svg);
  assert.equal(hub.nodes.get('vst-001'), null);
  assert.equal(hub.nodes.get('mixer-001'), null);
  assert.ok(hub.network.getNode('minilab-3'), 'a system node is never deleted');
  mod.unmount();
});

test('a frame drawn on the canvas selects the nodes it touches; Escape selects none', () => {
  const hub = setupHub();
  hub.nodes.create('vst');
  hub.nodes.create('vst');
  const { svg, mod } = mount(hub);
  const a = at(nodesLayerOf(svg), 'vst-001');
  // From just above-left of VST 1 to its top-left corner area: VST 1 only.
  fire(svg, 'pointerdown', { button: 0, target: svg, clientX: a.x - 20, clientY: a.y - 20 });
  fire(svg, 'pointermove', { clientX: a.x + 10, clientY: a.y + 10 });
  const frame = svg.children.find((c) => c._classSet?.has('selection-frame'));
  assert.ok(frame, 'the frame is drawn');
  assert.deepEqual(selectedIds(nodesLayerOf(svg)), ['vst-001']);
  fire(svg, 'pointerup', {});
  assert.ok(!svg.children.includes(frame), 'and removed on release');

  // Everything, by a frame over the whole canvas.
  fire(svg, 'pointerdown', { button: 0, target: svg, clientX: -5000, clientY: -5000 });
  fire(svg, 'pointermove', { clientX: 5000, clientY: 5000 });
  fire(svg, 'pointerup', {});
  assert.deepEqual(selectedIds(nodesLayerOf(svg)), ['minilab-3', 'vst-001', 'vst-002']);
  fireKey('Escape', svg);
  assert.deepEqual(selectedIds(nodesLayerOf(svg)), []);
  mod.unmount();
});

test('Ctrl+A selects every node', () => {
  const hub = setupHub();
  hub.nodes.create('vst');
  const { svg, mod } = mount(hub);
  fireKey('a', svg, { ctrlKey: true });
  assert.deepEqual(selectedIds(nodesLayerOf(svg)), ['minilab-3', 'vst-001']);
  mod.unmount();
});

test('a press on a cable is the cable’s: no frame, and Ctrl + click still unplugs it', () => {
  // Reported 2026-09-24: the selection frame captured the pointer on a cable
  // too, and the browser then gave the cable's click to the canvas.
  const hub = setupHub();
  hub.nodes.create('vst');
  hub.network.connect('minilab-3', 'midi-out', 'vst-001', 'midi-in');
  const { svg, mod } = mount(hub);
  const cables = findClass(svg, 'cables');
  const hit = cables.children.find((c) => c._classSet.has('cable-hit'));
  fire(svg, 'pointerdown', { button: 0, target: hit, clientX: 300, clientY: 200, ctrlKey: true });
  fire(svg, 'pointermove', { clientX: 500, clientY: 400, ctrlKey: true });
  assert.ok(!svg.children.some((c) => c._classSet?.has('selection-frame')), 'no frame is drawn from a cable');
  fire(svg, 'pointerup', {});
  fire(cables, 'click', { target: hit, ctrlKey: true });
  assert.equal(hub.network.connections().length, 0, 'Ctrl + click unplugged it');
  mod.unmount();
});
