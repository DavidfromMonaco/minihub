import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHub } from './helpers.mjs';

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
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 });
  el.matches = (sel) => {
    const parts = sel.split('.').filter(Boolean);
    const tag = parts[0];
    const classes = parts.slice(1);
    if (tag && tag.toLowerCase() !== el.tagName.toLowerCase()) return false;
    return classes.every((c) => el._classSet.has(c));
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
  globalThis.document = {
    createElementNS: (ns, tag) => makeEl(tag),
    createElement: (tag) => makeEl(tag),
    elementFromPoint: () => null,
    addEventListener: (t, fn) => { (docListeners[t] = docListeners[t] || new Set()).add(fn); },
    removeEventListener: (t, fn) => { docListeners[t]?.delete(fn); }
  };
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
}

// ---- module + core imports (after DOM globals are set) ---------------------
installDom();
const { createRoutingModule } = await import('../src/renderer/js/modules/routing/routingModule.js');
const { ModuleSystem } = await import('../src/renderer/js/core/moduleSystem.js');
const {
  buildVisualNodes,
  buildVisualConnections,
  createConnection,
  deleteConnection,
  canConnect,
  portTypeInfo
} = await import('../src/renderer/js/modules/routing/routingCore.js');
const { GraphLayout } = await import('../src/renderer/js/core/graphLayout.js');
const { GraphViewport } = await import('../src/renderer/js/core/graphViewport.js');
const { GRID_SIZE } = await import('../src/renderer/js/core/grid.js');
const { NodeInstanceManager } = await import('../src/renderer/js/core/nodeInstances.js');

// ---- fixtures ---------------------------------------------------------------
function seedGraph(hub) {
  hub.graph.addNode({
    id: 'src',
    name: 'Source',
    outputs: [
      { id: 'midi-out', type: 'midi', label: 'MIDI Out' },
      { id: 'audio-out', type: 'audio', label: 'Audio Out' }
    ]
  });
  hub.graph.addNode({
    id: 'dst',
    name: 'Target',
    inputs: [
      { id: 'midi-in', type: 'midi', label: 'MIDI In' },
      { id: 'ctrl-in', type: 'control', label: 'Ctrl In' }
    ]
  });
}

// ---- registration -----------------------------------------------------------
test('routing module registers through the module system', () => {
  const hub = makeHub();
  const modules = new ModuleSystem(hub);
  modules.register(createRoutingModule(hub));
  const mod = modules.get('routing');
  assert.ok(mod, 'module should be registered');
  assert.equal(mod.name, 'Routing');
  assert.ok(mod.navEntry, 'should have a nav entry');
  assert.equal(mod.navEntry.label, 'Routing');
  assert.equal(typeof mod.mount, 'function');
  assert.equal(typeof mod.unmount, 'function');
});

// ---- graph -> visual mapping -------------------------------------------------
test('graph nodes map to visual nodes with typed ports', () => {
  const hub = makeHub();
  seedGraph(hub);
  const visual = buildVisualNodes(hub.graph);
  assert.equal(visual.length, 2);
  const src = visual.find((n) => n.id === 'src');
  assert.equal(src.name, 'Source');
  assert.equal(src.outputs[0].type, 'midi');
  assert.equal(src.outputs[1].type, 'audio');
  const dst = visual.find((n) => n.id === 'dst');
  assert.equal(dst.inputs[0].type, 'midi');
  assert.equal(dst.inputs[1].type, 'control');
});

test('graph connections map to visual cables', () => {
  const hub = makeHub();
  seedGraph(hub);
  hub.graph.connect('src', 'midi-out', 'dst', 'midi-in');
  const cables = buildVisualConnections(hub.graph);
  assert.equal(cables.length, 1);
  assert.equal(cables[0].from.nodeId, 'src');
  assert.equal(cables[0].from.portId, 'midi-out');
  assert.equal(cables[0].to.nodeId, 'dst');
  assert.equal(cables[0].to.portId, 'midi-in');
});

// ---- connection creation / rejection ----------------------------------------
test('compatible connection creation through UI logic', () => {
  const hub = makeHub();
  seedGraph(hub);
  const result = createConnection(hub.graph, { nodeId: 'src', portId: 'midi-out' }, { nodeId: 'dst', portId: 'midi-in' });
  assert.deepEqual(result, { ok: true });
  assert.equal(hub.graph.connections().length, 1);
});

test('incompatible connection is rejected', () => {
  const hub = makeHub();
  seedGraph(hub);
  const result = createConnection(hub.graph, { nodeId: 'src', portId: 'midi-out' }, { nodeId: 'dst', portId: 'ctrl-in' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'incompatible');
  assert.equal(hub.graph.connections().length, 0);
});

test('duplicate connection is rejected', () => {
  const hub = makeHub();
  seedGraph(hub);
  createConnection(hub.graph, { nodeId: 'src', portId: 'midi-out' }, { nodeId: 'dst', portId: 'midi-in' });
  const dup = createConnection(hub.graph, { nodeId: 'src', portId: 'midi-out' }, { nodeId: 'dst', portId: 'midi-in' });
  assert.equal(dup.ok, false);
  assert.equal(hub.graph.connections().length, 1);
});

test('unknown ports are rejected', () => {
  const hub = makeHub();
  seedGraph(hub);
  const result = createConnection(hub.graph, { nodeId: 'src', portId: 'nope' }, { nodeId: 'dst', portId: 'midi-in' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unknown-port');
});

test('port type compatibility helper', () => {
  assert.equal(canConnect({ type: 'midi' }, { type: 'midi' }), true);
  assert.equal(canConnect({ type: 'midi' }, { type: 'audio' }), false);
  assert.equal(canConnect({ type: 'audio' }, { type: 'audio' }), true);
  assert.equal(canConnect(null, { type: 'midi' }), false);
});

test('port type info provides shape + label (not color alone)', () => {
  assert.equal(portTypeInfo('midi').shape, 'square');
  assert.equal(portTypeInfo('audio').shape, 'circle');
  assert.equal(portTypeInfo('control').shape, 'triangle');
  assert.equal(portTypeInfo('midi').label, 'MIDI');
});

// ---- connection deletion -----------------------------------------------------
test('connection deletion through UI logic', () => {
  const hub = makeHub();
  seedGraph(hub);
  hub.graph.connect('src', 'midi-out', 'dst', 'midi-in');
  assert.equal(hub.graph.connections().length, 1);
  const cable = buildVisualConnections(hub.graph)[0];
  const removed = deleteConnection(hub.graph, cable);
  assert.equal(removed, true);
  assert.equal(hub.graph.connections().length, 0);
});

// ---- node position persistence ----------------------------------------------
test('node position persistence via graphLayout', async () => {
  const hub = makeHub();
  const layout = new GraphLayout(hub.settings);
  // Deterministic default when nothing stored.
  const def = layout.get('minilab-3', 0);
  assert.equal(typeof def.x, 'number');
  assert.equal(typeof def.y, 'number');
  // Persist.
  await layout.set('minilab-3', 120, 180);
  const stored = layout.get('minilab-3', 0);
  assert.deepEqual(stored, { x: 120, y: 180 });
  assert.deepEqual(hub.settings.get('graphLayout'), { 'minilab-3': { x: 120, y: 180 } });
});

test('routing graph is unchanged when moving nodes (view state only)', async () => {
  const hub = makeHub();
  seedGraph(hub);
  hub.graph.connect('src', 'midi-out', 'dst', 'midi-in');
  const before = hub.graph.serialize();
  const layout = new GraphLayout(hub.settings);
  await layout.set('src', 400, 500);
  await layout.set('dst', 900, 300);
  assert.deepEqual(hub.graph.serialize(), before, 'moving nodes must not alter routing');
  assert.equal(hub.graph.connections().length, 1);
});

// ---- graph updates propagate to the editor ----------------------------------
test('graph changes propagate to the mounted editor', () => {
  const hub = makeHub();
  seedGraph(hub);
  const { container, svg } = makeContainer();
  const mod = createRoutingModule(hub);
  mod.mount(container);

  const nodesLayer = findClass(svg, 'nodes');
  const cablesLayer = findClass(svg, 'cables');
  assert.ok(nodesLayer, 'nodes layer should exist');
  assert.ok(cablesLayer, 'cables layer should exist');
  const countCables = (layer) =>
    layer.children.filter((c) => c._classSet.has('cable') && !c._classSet.has('cable-hit')).length;

  assert.equal(nodesLayer.children.length, 2, 'two nodes rendered');
  assert.equal(countCables(cablesLayer), 0, 'no cables yet');

  // Simulate another part of the app creating a connection through the graph.
  hub.graph.connect('src', 'midi-out', 'dst', 'midi-in');
  assert.equal(countCables(cablesLayer), 1, 'editor re-rendered after graph:change');

  // Simulate removal elsewhere.
  hub.graph.disconnect('src', 'midi-out', 'dst', 'midi-in');
  assert.equal(countCables(cablesLayer), 0, 'editor updated after disconnect');

  // Simulate a node being added elsewhere.
  hub.graph.addNode({ id: 'extra', name: 'Extra', outputs: [{ id: 'o', type: 'midi' }] });
  assert.equal(nodesLayer.children.length, 3, 'editor updated after node add');

  mod.unmount();
});

test('routing module unmount cleans up', () => {
  const hub = makeHub();
  seedGraph(hub);
  const { container } = makeContainer();
  const mod = createRoutingModule(hub);
  mod.mount(container);
  mod.unmount();
  // Should not throw; container host class removed.
  assert.ok(true);
});

test('initial open fits nodes when no persisted viewport exists', () => {
  const hub = makeHub();
  hub.graph.addNode({ id: 'minilab-3', name: 'MiniLab 3', outputs: [{ id: 'midi-out', type: 'midi' }] });
  const { container, svg } = makeContainer();
  const mod = createRoutingModule(hub);
  mod.mount(container);
  const vb = svg.getAttribute('viewBox');
  // A fit (not the default 1:1 "0 0 800 600") means nodes were fitted into view.
  assert.ok(vb && vb !== '0 0 800 600', `viewBox should reflect a fit, got: ${vb}`);
  mod.unmount();
});

test('initial open restores a valid persisted viewport', async () => {
  const hub = makeHub();
  hub.graph.addNode({ id: 'minilab-3', name: 'MiniLab 3', outputs: [{ id: 'midi-out', type: 'midi' }] });
  const vp = new GraphViewport(hub.settings);
  await vp.save(123, 456, 1.25);
  const { container, svg } = makeContainer();
  const mod = createRoutingModule(hub);
  mod.mount(container);
  // Persisted pan (123,456) zoom 1.25 on a 800x600 canvas -> viewBox stays as-is
  // (not overwritten by a fit).
  assert.equal(svg.getAttribute('viewBox'), '123 456 640 480');
  mod.unmount();
});

test('visual grid pattern uses the shared GRID_SIZE', () => {
  const hub = makeHub();
  hub.graph.addNode({ id: 'minilab-3', name: 'MiniLab 3', outputs: [{ id: 'midi-out', type: 'midi' }] });
  const { container, svg } = makeContainer();
  const mod = createRoutingModule(hub);
  mod.mount(container);
  const minor = svg.querySelector('#grid-minor');
  assert.ok(minor, 'minor grid pattern should exist');
  assert.equal(minor.getAttribute('width'), String(GRID_SIZE));
  assert.equal(minor.getAttribute('height'), String(GRID_SIZE));
  mod.unmount();
});

test('dynamic nodes render with a type accent class in the Patch Bay', () => {
  const hub = makeHub();
  const modules = new ModuleSystem(hub);
  const nodes = new NodeInstanceManager({ events: hub.events, settings: hub.settings, graph: hub.graph, modules });
  hub.modules = modules;
  hub.nodes = nodes;
  nodes.create('vst');

  const { container, svg } = makeContainer();
  const mod = createRoutingModule(hub);
  mod.mount(container);
  const nodesLayer = findClass(svg, 'nodes');
  const vstNode = nodesLayer.children.find((c) => c._classSet.has('node-type-vst'));
  assert.ok(vstNode, 'VST node should render with its type accent class');
  mod.unmount();
});

test('port elements carry the correct node id for cable drag', () => {
  const hub = makeHub();
  const modules = new ModuleSystem(hub);
  const nodes = new NodeInstanceManager({ events: hub.events, settings: hub.settings, graph: hub.graph, modules });
  hub.modules = modules;
  hub.nodes = nodes;
  // Native MiniLab routing node + dynamic VST instance.
  hub.graph.addNode({ id: 'minilab-3', name: 'MiniLab 3', outputs: [{ id: 'midi-out', type: 'midi' }] });
  nodes.create('vst'); // vst-001 with midi-in

  const { container, svg } = makeContainer();
  const mod = createRoutingModule(hub);
  mod.mount(container);
  const nodesLayer = findClass(svg, 'nodes');
  const minilab = nodesLayer.children.find((c) => c.dataset.nodeId === 'minilab-3');
  const vst = nodesLayer.children.find((c) => c.dataset.nodeId === 'vst-001');
  assert.ok(minilab && vst, 'both nodes should render');

  const minilabOut = minilab.children.find((c) => c.dataset.side === 'output');
  const vstIn = vst.children.find((c) => c.dataset.side === 'input');
  assert.ok(minilabOut, 'MiniLab output port should exist');
  assert.ok(vstIn, 'VST input port should exist');
  // These are what startCableDrag / endCableDrag read to build the connection.
  assert.equal(minilabOut.dataset.nodeId, 'minilab-3');
  assert.equal(minilabOut.dataset.portId, 'midi-out');
  assert.equal(vstIn.dataset.nodeId, 'vst-001');
  assert.equal(vstIn.dataset.portId, 'midi-in');
  mod.unmount();
});

test('cables render a visible path + wide hit path with endpoint metadata', () => {
  const hub = makeHub();
  hub.graph.addNode({ id: 'a', name: 'A', outputs: [{ id: 'o', type: 'midi' }] });
  hub.graph.addNode({ id: 'b', name: 'B', inputs: [{ id: 'i', type: 'midi' }] });
  hub.graph.connect('a', 'o', 'b', 'i');

  const { container, svg } = makeContainer();
  const mod = createRoutingModule(hub);
  mod.mount(container);
  const cablesLayer = findClass(svg, 'cables');

  const visible = cablesLayer.children.find((c) => c._classSet.has('cable') && !c._classSet.has('cable-hit'));
  const hit = cablesLayer.children.find((c) => c._classSet.has('cable-hit'));
  assert.ok(visible, 'visible cable path should exist');
  assert.ok(hit, 'wide hit path should exist');
  assert.equal(visible.dataset.cableId, hit.dataset.cableId);
  // Endpoint metadata drives findCableEl / unplug resolution.
  assert.equal(visible.dataset.fromNodeId, 'a');
  assert.equal(visible.dataset.fromPortId, 'o');
  assert.equal(visible.dataset.toNodeId, 'b');
  assert.equal(visible.dataset.toPortId, 'i');
  mod.unmount();
});
