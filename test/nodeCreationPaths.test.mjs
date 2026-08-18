import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHub } from './helpers.mjs';

/**
 * Contract: every UI route that creates a node produces an equivalent node.
 *
 * The Patch Bay toolbar ("+ New Node") and the canvas context menu
 * ("New Node > VST") must agree on naming, graph registration, layout
 * placement and selection. They used to disagree: the toolbar called
 * `hub.nodes.create()` directly, so its nodes were never placed and never
 * selected.
 */

// ---- DOM shim: only what the routing module touches --------------------------

function makeEl(tag) {
  const el = {
    tagName: tag.toUpperCase(),
    nodeType: 1,
    children: [],
    attributes: {},
    dataset: {},
    _classSet: new Set(),
    _listeners: {},
    textContent: '',
    parentNode: null,
    style: {},
    disabled: false,
    value: ''
  };
  Object.defineProperty(el, 'classList', {
    get: () => ({
      add: (...c) => {
        c.forEach((x) => el._classSet.add(x));
        if (el._classSet.has('node-context-menu')) globalThis.__lastMenu = el;
      },
      remove: (c) => el._classSet.delete(c),
      toggle: (c, force) => {
        if (force === undefined) {
          if (el._classSet.has(c)) el._classSet.delete(c);
          else el._classSet.add(c);
        } else if (force) el._classSet.add(c);
        else el._classSet.delete(c);
      },
      contains: (c) => el._classSet.has(c)
    })
  });
  Object.defineProperty(el, 'innerHTML', {
    get: () => '',
    set: () => { el.children.length = 0; },
    configurable: true
  });
  el.setAttribute = (k, v) => {
    el.attributes[k] = String(v);
    if (k === 'id') el.id = String(v);
    if (k === 'class') el._classSet = new Set(String(v).split(/\s+/).filter(Boolean));
  };
  el.getAttribute = (k) => el.attributes[k];
  el.appendChild = (c) => { c.parentNode = el; el.children.push(c); return c; };
  el.removeChild = (c) => {
    const i = el.children.indexOf(c);
    if (i >= 0) el.children.splice(i, 1);
    c.parentNode = null;
  };
  el.remove = () => { if (el.parentNode) el.parentNode.removeChild(el); };
  el.addEventListener = (t, fn) => { (el._listeners[t] = el._listeners[t] || new Set()).add(fn); };
  el.removeEventListener = (t, fn) => { el._listeners[t]?.delete(fn); };
  el.setPointerCapture = () => {};
  el.releasePointerCapture = () => {};
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 });
  el.matches = (sel) => (sel.startsWith('.') ? el._classSet.has(sel.slice(1)) : el.tagName.toLowerCase() === sel.toLowerCase());
  el.closest = (sel) => {
    let cur = el;
    while (cur) {
      if (cur.matches && cur.matches(sel)) return cur;
      cur = cur.parentNode;
    }
    return null;
  };
  el.querySelector = (sel) => {
    if (!sel.startsWith('#')) return null;
    const id = sel.slice(1);
    const stack = [el];
    while (stack.length) {
      const n = stack.pop();
      if (n.id === id) return n;
      stack.push(...n.children);
    }
    return null;
  };
  return el;
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

/**
 * A container whose `innerHTML` setter rebuilds the real toolbar controls, so
 * the toolbar path is exercised rather than silently skipped.
 */
function makeContainer() {
  const container = makeEl('div');
  const svg = makeEl('svg');
  svg.setAttribute('id', 'routing-svg');
  const newBtn = makeEl('button');
  newBtn.setAttribute('id', 'routing-new-node');
  const newType = makeEl('select');
  newType.setAttribute('id', 'routing-new-type');
  Object.defineProperty(container, 'innerHTML', {
    get: () => '',
    set: () => {
      container.children.length = 0;
      container.appendChild(svg);
      container.appendChild(newBtn);
      container.appendChild(newType);
    },
    configurable: true
  });
  return { container, svg, newBtn, newType };
}

function setupHub() {
  const hub = makeHub({ graphViewport: { x: 0, y: 0, zoom: 1 } });
  const modules = new ModuleSystem(hub);
  hub.modules = modules;
  hub.nodes = new NodeInstanceManager({
    events: hub.events, settings: hub.settings, graph: hub.graph, modules
  });
  return hub;
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

const nodeEl = (svg, id) =>
  findClass(svg, 'nodes').children.find((c) => c.dataset.nodeId === id);

function fireContextMenu(svg, clientX = 400, clientY = 300) {
  const evt = {
    target: svg, clientX, clientY, button: 2,
    preventDefault() {}, stopPropagation() {}
  };
  [...(svg._listeners['contextmenu'] || [])].forEach((fn) => fn(evt));
}

function clickMenuLabel(label) {
  // The menu is appended to document.body in the real DOM; the shim keeps the
  // created element reachable through the click handlers registered on it.
  const menu = globalThis.__lastMenu;
  const stack = [...menu.children];
  while (stack.length) {
    const n = stack.pop();
    if (n._classSet.has('ctx-item') && n.textContent === label) {
      [...n._listeners['click']].forEach((fn) => fn());
      return true;
    }
    stack.push(...n.children);
  }
  return false;
}

globalThis.document.body = makeEl('body');

// ---- tests ------------------------------------------------------------------

test('the Patch Bay toolbar creates a placed, selected node', () => {
  const hub = setupHub();
  const { container, svg, newBtn, newType } = makeContainer();
  createRoutingModule(hub).mount(container);

  newType.value = 'vst';
  [...newBtn._listeners['click']].forEach((fn) => fn());

  const [instance] = hub.nodes.list();
  assert.ok(instance, 'the toolbar must actually create an instance');
  assert.equal(instance.name, 'VST 1');
  assert.ok(hub.graph.getNode(instance.id), 'registered in the routing graph');
  assert.ok(hub.settings.get('graphLayout')[instance.id], 'given a layout position');
  assert.ok(nodeEl(svg, instance.id)._classSet.has('selected'), 'and selected');
});

test('toolbar and context menu produce equivalent nodes', () => {
  const viaToolbar = (() => {
    const hub = setupHub();
    const { container, newBtn, newType } = makeContainer();
    createRoutingModule(hub).mount(container);
    newType.value = 'vst';
    [...newBtn._listeners['click']].forEach((fn) => fn());
    return hub;
  })();

  const viaMenu = (() => {
    const hub = setupHub();
    const { container, svg } = makeContainer();
    createRoutingModule(hub).mount(container);
    fireContextMenu(svg);
    assert.ok(clickMenuLabel('VST'), 'the New Node submenu must offer VST');
    return hub;
  })();

  const a = viaToolbar.nodes.list()[0];
  const b = viaMenu.nodes.list()[0];

  assert.equal(a.name, b.name, 'same display name');
  assert.equal(a.id, b.id, 'same stable id for the first node of a type');
  assert.equal(a.type, b.type);
  assert.deepEqual(a.content, b.content, 'same default content');
  assert.ok(viaToolbar.graph.getNode(a.id) && viaMenu.graph.getNode(b.id), 'both registered in the graph');
  assert.ok(viaToolbar.modules.get(a.id) && viaMenu.modules.get(b.id), 'both registered as modules');
  assert.ok(
    viaToolbar.settings.get('graphLayout')[a.id] && viaMenu.settings.get('graphLayout')[b.id],
    'both placed on the canvas'
  );
});

test('every node type can be created from the toolbar with correct naming', () => {
  const hub = setupHub();
  const { container, newBtn, newType } = makeContainer();
  createRoutingModule(hub).mount(container);

  for (const type of ['vst', 'video', 'image', 'sequencer']) {
    newType.value = type;
    [...newBtn._listeners['click']].forEach((fn) => fn());
  }

  assert.deepEqual(
    hub.nodes.list().map((n) => n.name),
    ['VST 1', 'Video 1', 'Image 1', 'Sequencer 1']
  );
});
