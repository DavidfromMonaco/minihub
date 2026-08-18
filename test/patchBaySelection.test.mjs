import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHub } from './helpers.mjs';
import { GRID_SIZE } from '../src/renderer/js/core/grid.js';

// ---- DOM shim (only what the routing module touches) ------------------------
function makeEl(tag) {
  const el = {
    tagName: tag.toUpperCase(),
    nodeType: 1,
    children: [],
    attributes: {},
    dataset: {},
    _classSet: new Set(),
    textContent: '',
    parentNode: null,
    style: {},
    disabled: false,
    _listeners: {}
  };
  Object.defineProperty(el, 'classList', {
    get() {
      return {
        add: (c) => el._classSet.add(c),
        remove: (c) => el._classSet.delete(c),
        toggle: (c, force) => {
          if (force === undefined) {
            if (el._classSet.has(c)) el._classSet.delete(c);
            else el._classSet.add(c);
          } else if (force) el._classSet.add(c);
          else el._classSet.delete(c);
        },
        contains: (c) => el._classSet.has(c)
      };
    }
  });
  Object.defineProperty(el, 'innerHTML', {
    get() { return ''; },
    set() { el.children.length = 0; },
    configurable: true
  });
  el.setAttribute = (k, v) => {
    el.attributes[k] = String(v);
    if (k === 'id') el.id = String(v);
    if (k === 'class') el._classSet = new Set(String(v).split(/\s+/).filter(Boolean));
  };
  el.getAttribute = (k) => el.attributes[k];
  el.appendChild = (child) => { child.parentNode = el; el.children.push(child); return child; };
  el.removeChild = (child) => {
    const i = el.children.indexOf(child);
    if (i >= 0) el.children.splice(i, 1);
    child.parentNode = null;
  };
  el.remove = () => { if (el.parentNode) el.parentNode.removeChild(el); };
  el.addEventListener = (t, fn) => { (el._listeners[t] = el._listeners[t] || new Set()).add(fn); };
  el.removeEventListener = (t, fn) => { el._listeners[t]?.delete(fn); };
  el.setPointerCapture = () => {};
  el.releasePointerCapture = () => {};
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 });
  el.matches = (sel) => {
    // Class-only selectors are all this shim needs ('.node', '.port', etc.).
    if (sel.startsWith('.')) {
      return el._classSet.has(sel.slice(1));
    }
    return el.tagName.toLowerCase() === sel.toLowerCase();
  };
  el.closest = (sel) => {
    let cur = el;
    while (cur) {
      if (cur.matches && cur.matches(sel)) return cur;
      cur = cur.parentNode;
    }
    return null;
  };
  el.querySelector = (sel) => {
    if (sel.startsWith('#')) {
      const id = sel.slice(1);
      const stack = [el];
      while (stack.length) {
        const n = stack.pop();
        if (n.id === id) return n;
        stack.push(...n.children);
      }
    }
    return null;
  };
  return el;
}

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

function findClass(root, cls) {
  const stack = [...root.children];
  while (stack.length) {
    const n = stack.pop();
    if (n._classSet.has(cls)) return n;
    stack.push(...n.children);
  }
  return null;
}

function installDom() {
  const docListeners = {};
  const winListeners = {};
  globalThis.document = {
    _listeners: docListeners,
    createElementNS: (ns, tag) => makeEl(tag),
    createElement: (tag) => makeEl(tag),
    elementFromPoint: () => null,
    addEventListener: (t, fn) => { (docListeners[t] = docListeners[t] || new Set()).add(fn); },
    removeEventListener: (t, fn) => { docListeners[t]?.delete(fn); }
  };
  globalThis.window = {
    _listeners: winListeners,
    addEventListener: (t, fn) => { (winListeners[t] = winListeners[t] || new Set()).add(fn); },
    removeEventListener: (t, fn) => { winListeners[t]?.delete(fn); }
  };
}

installDom();
const { createRoutingModule } = await import('../src/renderer/js/modules/routing/routingModule.js');
const { ModuleSystem } = await import('../src/renderer/js/core/moduleSystem.js');
const { NodeInstanceManager } = await import('../src/renderer/js/core/nodeInstances.js');

// ---- event simulation helpers -------------------------------------------------
function fire(el, type, init = {}) {
  const evt = {
    target: init.target || el,
    button: init.button ?? 0,
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
    pointerId: init.pointerId ?? 1,
    ctrlKey: init.ctrlKey ?? false,
    key: init.key,
    preventDefault() {},
    stopPropagation() {}
  };
  const listeners = el._listeners[type];
  if (listeners) [...listeners].forEach((fn) => fn(evt));
  return evt;
}

function fireKey(key, target) {
  const evt = { key, target: target || null, preventDefault() {} };
  const listeners = window._listeners['keydown'];
  if (listeners) [...listeners].forEach((fn) => fn(evt));
  return evt;
}

function fireDocumentPointer(target) {
  const evt = { target };
  const listeners = document._listeners['pointerdown'];
  if (listeners) [...listeners].forEach((fn) => fn(evt));
  return evt;
}

// ---- fixtures -----------------------------------------------------------------
function setupHub() {
  // Seed a persisted 1:1 viewport so drag math is deterministic (no fit).
  const hub = makeHub({ graphViewport: { x: 0, y: 0, zoom: 1 } });
  const modules = new ModuleSystem(hub);
  const nodes = new NodeInstanceManager({ events: hub.events, settings: hub.settings, graph: hub.graph, modules });
  hub.modules = modules;
  hub.nodes = nodes;
  // Native MiniLab routing node (not a user-created instance).
  hub.graph.addNode({ id: 'minilab-3', name: 'MiniLab 3', outputs: [{ id: 'midi-out', type: 'midi' }] });
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
  const pos = hub.settings.get('graphLayout')['vst-001'];
  assert.ok(pos, 'node position persisted');
  assert.equal(pos.x % GRID_SIZE, 0, 'x snapped to grid');
  assert.equal(pos.y % GRID_SIZE, 0, 'y snapped to grid');
  mod.unmount();
});

test('selecting nodes does not change routing/cables', () => {
  const hub = setupHub();
  hub.nodes.create('vst'); // vst-001 (midi-in)
  hub.graph.connect('minilab-3', 'midi-out', 'vst-001', 'midi-in');
  const before = hub.graph.serialize();
  const { svg, mod } = mount(hub);
  const layer = nodesLayerOf(svg);
  const vst = findNode(layer, 'vst-001');
  clickNode(svg, vst);
  assert.deepEqual(hub.graph.serialize(), before, 'routing unchanged by selection');
  assert.equal(hub.graph.connections().length, 1);
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
  assert.ok(!hub.graph.getNode('vst-001'), 'routing node removed');
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
  assert.ok(hub.graph.getNode('minilab-3'), 'native node still present');
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
