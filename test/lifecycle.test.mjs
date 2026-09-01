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

/**
 * A container whose `innerHTML` setter recreates a fixed set of ids, so a
 * module that queries its own markup after rendering finds real elements.
 */
function makePanelContainer(ids) {
  const container = makeEl('div');
  Object.defineProperty(container, 'innerHTML', {
    get: () => '',
    set: () => {
      container.children.length = 0;
      for (const id of ids) {
        const el = makeEl('div');
        el.setAttribute('id', id);
        container.appendChild(el);
      }
    },
    configurable: true
  });
  return container;
}

const AUDIO_OUTPUT_IDS = [
  'ao-status', 'ao-device', 'ao-sample-rate', 'ao-buffer', 'ao-apply', 'ao-refresh',
  'ao-engine-state', 'ao-current-device', 'ao-current-sr', 'ao-current-buf', 'ao-error'
];

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
  assert.equal(off.length, 0, 'obsolete output gate is not used');
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

  // No modules yet -> no groups rendered.
  assert.equal(sidebarEl.children.length, 0);

  const node = hub.nodes.create('vst');
  // The NODES group appears with its section label + the new node.
  const labels = sidebarEl.children
    .filter((c) => c._classSet.has('sidebar-group-label'))
    .map((c) => c.textContent);
  assert.deepEqual(labels, ['NODES'], 'only the dynamic-node group is added');
  const nodeItems = sidebarEl.children.filter(
    (c) => c._classSet.has('nav-item') && c.getAttribute('data-module-id') === node.id
  );
  assert.equal(nodeItems.length, 1, 'new node appears in the nav');

  hub.nodes.delete(node.id);
  assert.equal(sidebarEl.children.length, 0, 'empty NODES group disappears when deleted');
});

// ---- engine chatter -----------------------------------------------------------

const { setupEngineSync } = await import('../src/renderer/js/core/engineSync.js');
const { createAudioOutputModule } = await import('../src/renderer/js/modules/audioOutput/audioOutputModule.js');

test('audio execution graph is published only when AUDIO topology changes', async () => {
  const api = mockApi();
  const hub = createHub(api);
  await hub.engine.init();
  hub.modules.register(createAudioOutputModule(hub));
  const node = hub.nodes.create('vst');
  setupEngineSync(hub);

  const enableCmds = () => api.sent.filter((m) => m.type === 'syncAudioGraph').length;

  const afterInitial = enableCmds();
  hub.graph.connect(node.id, 'audio-out', 'audio-output', 'audio-in');
  const afterConnect = enableCmds();
  assert.ok(afterConnect > afterInitial, 'a real change must be published');

  // Graph changes that do not affect this chain must not re-publish it.
  hub.graph.addNode({ id: 'src', name: 'Src', outputs: [{ id: 'midi-out', type: 'midi' }] });
  hub.graph.addNode({ id: 'spare', name: 'Spare', inputs: [{ id: 'midi-in', type: 'midi' }] });
  hub.graph.connect('src', 'midi-out', 'spare', 'midi-in');
  assert.equal(enableCmds(), afterConnect, 'unrelated graph changes cause no engine chatter');

  hub.graph.disconnect(node.id, 'audio-out', 'audio-output', 'audio-in');
  assert.ok(enableCmds() > afterConnect, 'disconnecting is a real change and is published');
});

test('an engine restart re-publishes the routing topology', async () => {
  const api = mockApi();
  const hub = createHub(api);
  await hub.engine.init();
  hub.modules.register(createAudioOutputModule(hub));
  const node = hub.nodes.create('vst');
  const sync = setupEngineSync(hub);
  hub.graph.connect(node.id, 'audio-out', 'audio-output', 'audio-in');

  api.sent.length = 0;
  sync();
  assert.equal(api.sent.length, 0, 'nothing changed, nothing sent');

  api.emitState({ state: 'error', error: 'engine crashed' });
  api.emitState({ state: 'running', error: null });
  assert.ok(
    api.sent.some((m) => m.type === 'syncAudioGraph' && m.nodes.find((n)=>n.id==='audio-output')?.inputs.some((i)=>i.sourceNodeId===node.id)),
    'the running transition immediately re-sends topology to the empty engine'
  );
  assert.ok(api.sent.some((m) => m.type === 'syncMidiGraph'),
    'the running transition immediately restores the native MIDI execution plan');
  api.sent.length = 0;
  sync();
  assert.equal(api.sent.length, 0, 'the restored topology is cached after successful restart publication');
});

test('the engine client warms up once per engine run, not once per module', async () => {
  const api = mockApi();
  const hub = createHub(api);
  await hub.engine.init();

  const warmup = () => api.sent.filter(
    (m) => m.type === 'hello' || m.type === 'listDevices' || m.type === 'getDeviceState' || m.type === 'scanVst3'
  ).length;
  assert.equal(warmup(), 4, 'init pulls capabilities, devices, device state and the registry once');

  // Opening the Audio Output panel must not re-issue them.
  const mod = createAudioOutputModule(hub);
  hub.modules.register(mod);
  mod.mount(makePanelContainer(AUDIO_OUTPUT_IDS));
  assert.equal(warmup(), 4, 'a module reads the cached state instead of re-requesting');
  mod.unmount();
});

test('engine state and caches are invalidated when the engine goes away', async () => {
  const api = mockApi();
  const hub = createHub(api);
  await hub.engine.init();
  api.emitEvent({ type: 'devices', outputs: [{ name: 'Speakers', isWASAPI: true }] });
  api.emitEvent({ type: 'deviceState', running: true, device: 'Speakers', sampleRate: 48000 });
  api.emitEvent({ type: 'plugins', plugins: [{ pluginId: 'A', name: 'Vital' }] });
  assert.equal(hub.engine.devices.length, 1);
  assert.equal(hub.engine.plugins.length, 1);
  assert.ok(hub.engine.deviceState);

  api.emitState({ state: 'error', error: 'engine crashed' });
  assert.deepEqual(hub.engine.devices, [], 'a dead engine has no devices');
  assert.deepEqual(hub.engine.plugins, [], 'and no usable registry');
  assert.equal(hub.engine.deviceState, null);
  assert.equal(hub.engine.getPlugin('A'), null);

  api.sent.length = 0;
  api.emitState({ state: 'running', error: null });
  const types = api.sent.map((m) => m.type);
  assert.ok(types.includes('hello') && types.includes('listDevices') && types.includes('getDeviceState') && types.includes('scanVst3'),
    'coming back up re-pulls everything the renderer needs');
});

test('a renderer reload over an already-running engine re-requests export capabilities', async () => {
  const api = mockApi();
  const first = createHub(api);
  await first.engine.init();
  first.engine.dispose();
  api.sent.length = 0;

  const reloaded = createHub(api);
  const seen = [];
  reloaded.events.on('engine:sequencerExportCapabilities', (value) => seen.push(value));
  await reloaded.engine.init();
  assert.ok(api.sent.some((message) => message.type === 'hello'),
    'reload cannot rely on the native startup hello that the old renderer consumed');

  api.emitEvent({
    type: 'hello',
    sequencerExportCapabilities: {
      formats: ['wav', 'mp3', 'ogg'],
      mp3Available: true,
      oggQualityOptions: ['Low', 'High']
    }
  });
  assert.equal(reloaded.engine.exportCapabilities.mp3Available, true);
  assert.deepEqual(reloaded.engine.exportCapabilities.oggQualityOptions, ['Low', 'High']);
  assert.equal(seen.length, 1);
});
