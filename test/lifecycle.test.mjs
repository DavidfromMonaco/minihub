import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHub } from './helpers.mjs';
import { makeEl, installDom, fire, fireKey, findClass, lastCreatedWithClass } from './domShim.mjs';

/**
 * Subscription and teardown contracts.
 *
 * Every listener in the renderer must have one owner and one removal point.
 * These tests pin the cases that previously leaked or double-fired.
 */

installDom();
const { createRoutingModule } = await import('../src/renderer/js/modules/routing/routingModule.js');
const { ModuleSystem } = await import('../src/renderer/js/core/moduleSystem.js');
const { NodeInstanceManager } = await import('../src/renderer/js/core/nodeInstances.js');
const { createHub } = await import('../src/renderer/js/core/hub.js');
const { buildSidebar } = await import('../src/renderer/js/ui/sidebar.js');

function mockApi() {
  const sent = [];
  const listeners = { event: [], state: [] };
  return {
    sent,
    listeners,
    emitEvent(msg) { listeners.event.forEach((cb) => cb(msg)); },
    emitState(s) { listeners.state.forEach((cb) => cb(s)); },
    loadSettings: async () => ({}),
    saveSettings: async () => true,
    diagnosticsLog: () => true,
    engineCommand: async (msg) => { sent.push(msg); return { ok: true }; },
    engineState: async () => ({ state: 'running', error: null }),
    onEngineEvent: (cb) => {
      listeners.event.push(cb);
      return () => { listeners.event.splice(listeners.event.indexOf(cb), 1); };
    },
    onEngineState: (cb) => {
      listeners.state.push(cb);
      return () => { listeners.state.splice(listeners.state.indexOf(cb), 1); };
    }
  };
}

function setupPatchBay() {
  const hub = makeHub({ graphViewport: { x: 0, y: 0, zoom: 1 } });
  const modules = new ModuleSystem(hub);
  hub.modules = modules;
  hub.nodes = new NodeInstanceManager({
    events: hub.events, settings: hub.settings, graph: hub.graph, modules
  });

  const container = makeEl('div');
  const svg = makeEl('svg');
  svg.setAttribute('id', 'routing-svg');
  Object.defineProperty(container, 'innerHTML', {
    get: () => '',
    set: () => { container.children.length = 0; container.appendChild(svg); },
    configurable: true
  });
  const mod = createRoutingModule(hub);
  mod.mount(container);
  return { hub, container, svg, mod };
}

const nodeEls = (svg) => findClass(svg, 'nodes').children;
const nodeElFor = (svg, id) => nodeEls(svg).find((c) => c.dataset.nodeId === id);
const panelOf = (nodeG) => nodeG.children.find((c) => c._classSet.has('node-panel'));

function selectNode(svg, id) {
  fire(svg, 'pointerdown', { button: 0, target: panelOf(nodeElFor(svg, id)), clientX: 5, clientY: 5 });
  fire(svg, 'pointerup', {});
}

// ---- engine client subscriptions --------------------------------------------

test('engine client init is idempotent (a second call cannot double engine events)', async () => {
  const api = mockApi();
  const hub = createHub(api);

  await hub.engine.init();
  await hub.engine.init();
  await hub.engine.init();

  assert.equal(api.listeners.event.length, 1, 'exactly one event subscription');
  assert.equal(api.listeners.state.length, 1, 'exactly one state subscription');

  let seen = 0;
  hub.events.on('engine:plugins', () => { seen += 1; });
  api.emitEvent({ type: 'plugins', plugins: [{ pluginId: 'A', name: 'Vital' }] });
  assert.equal(seen, 1, 'one engine event must produce one bus event');
});

test('engine client init resolves to the current engine state', async () => {
  const hub = createHub(mockApi());
  const state = await hub.engine.init();
  assert.equal(state, 'running');
  assert.equal(hub.engine.state, 'running');
});

test('disposing the engine client removes its main-process subscriptions', async () => {
  const api = mockApi();
  const hub = createHub(api);
  await hub.engine.init();
  hub.engine.dispose();
  assert.equal(api.listeners.event.length, 0);
  assert.equal(api.listeners.state.length, 0);
});

// ---- deletion parity ---------------------------------------------------------

test('Delete key and context menu delete a node the same way', () => {
  const results = ['key', 'menu'].map((route) => {
    const { hub, svg } = setupPatchBay();
    const node = hub.nodes.create('vst');
    hub.graph.addNode({ id: 'src', name: 'Src', outputs: [{ id: 'midi-out', type: 'midi' }] });
    hub.graph.connect('src', 'midi-out', node.id, 'midi-in');
    selectNode(svg, node.id);

    if (route === 'key') {
      fireKey('Delete', null);
    } else {
      fire(svg, 'contextmenu', { target: panelOf(nodeElFor(svg, node.id)), clientX: 10, clientY: 10 });
      const menu = lastCreatedWithClass('node-context-menu');
      const del = menu.children.find((c) => c.textContent === 'Delete Node');
      assert.ok(del, 'the node context menu must offer Delete Node');
      [...del._listeners['click']].forEach((fn) => fn());
    }

    return {
      route,
      instanceGone: hub.nodes.get(node.id) === null,
      graphNodeGone: hub.graph.getNode(node.id) === undefined,
      connectionsGone: hub.graph.connections().length === 0,
      moduleGone: hub.modules.get(node.id) === undefined,
      layoutGone: !(hub.settings.get('graphLayout') || {})[node.id],
      noSelectedElement: nodeEls(svg).every((el) => !el._classSet.has('selected'))
    };
  });

  for (const r of results) {
    assert.ok(r.instanceGone, `${r.route}: instance removed`);
    assert.ok(r.graphNodeGone, `${r.route}: graph node removed`);
    assert.ok(r.connectionsGone, `${r.route}: connections removed`);
    assert.ok(r.moduleGone, `${r.route}: module unregistered`);
    assert.ok(r.layoutGone, `${r.route}: layout entry removed`);
    assert.ok(r.noSelectedElement, `${r.route}: selection cleared`);
  }
});

test('deleting a VST node stops its chain in the engine exactly once', async () => {
  const api = mockApi();
  const hub = createHub(api);
  await hub.engine.init();
  const node = hub.nodes.create('vst');
  hub.nodes.getChain(node.id).append({ pluginId: 'P', name: 'Dexed', role: 'instrument' });

  api.sent.length = 0;
  hub.nodes.delete(node.id);

  const off = api.sent.filter((m) => m.type === 'setChainOutputEnabled' && m.chainId === node.id);
  assert.equal(off.length, 1, 'no duplicated teardown commands');
  assert.equal(off[0].enabled, false);
  assert.equal(api.sent.filter((m) => m.type === 'removeInstance').length, 1);
});

// ---- sidebar ------------------------------------------------------------------

test('navigating does not rebuild the sidebar DOM', () => {
  const hub = makeHub();
  hub.modules = new ModuleSystem(hub);
  const sidebarEl = makeEl('nav');
  const contentEl = makeEl('main');

  const mk = (id, label) => ({
    id, name: label, navEntry: { label }, mount() {}, unmount() {}
  });
  hub.modules.register(mk('home', 'Home'));
  hub.modules.register(mk('routing', 'Routing'));

  buildSidebar(hub, sidebarEl, contentEl);
  const before = [...sidebarEl.children];
  assert.ok(before.length >= 3, 'label + one item per module');

  hub.modules.activate('routing', contentEl);

  assert.deepEqual([...sidebarEl.children], before,
    'activation must move the active class, not recreate every button');
  const active = sidebarEl.children.filter((c) => c._classSet.has('active'));
  assert.equal(active.length, 1, 'exactly one active nav item');
});

test('the sidebar does rebuild when the set of modules changes', () => {
  const hub = makeHub();
  hub.modules = new ModuleSystem(hub);
  hub.nodes = new NodeInstanceManager({
    events: hub.events, settings: hub.settings, graph: hub.graph, modules: hub.modules
  });
  const sidebarEl = makeEl('nav');
  buildSidebar(hub, sidebarEl, makeEl('main'));

  const before = sidebarEl.children.length;
  const node = hub.nodes.create('vst');
  assert.equal(sidebarEl.children.length, before + 1, 'new node appears in the nav');

  hub.nodes.delete(node.id);
  assert.equal(sidebarEl.children.length, before, 'and disappears when deleted');
});
