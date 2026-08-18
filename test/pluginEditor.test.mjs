import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from '../src/renderer/js/core/hub.js';
import { setupEngineSync } from '../src/renderer/js/core/engineSync.js';
import { setupChainSync } from '../src/renderer/js/core/chainSync.js';
import { setupMidiRouting } from '../src/renderer/js/core/midiRouting.js';
import { createAudioOutputModule } from '../src/renderer/js/modules/audioOutput/audioOutputModule.js';
import { escapeHtml } from '../src/renderer/js/core/html.js';

/** In-memory API mirroring the preload `hubAPI` surface. */
function mockApi(initialSettings = {}) {
  const data = { ...initialSettings };
  const sent = [];
  const listeners = { event: [], state: [] };
  return {
    data,
    sent,
    emitEvent(msg) { listeners.event.forEach((cb) => cb(msg)); },
    emitState(s) { listeners.state.forEach((cb) => cb(s)); },
    loadSettings: async () => ({ ...data }),
    saveSettings: async (s) => { Object.assign(data, s); return true; },
    diagnosticsLog: () => true,
    engineCommand: async (msg) => { sent.push(msg); return { ok: true }; },
    engineState: async () => ({ state: 'running', error: null }),
    onEngineEvent: (cb) => { listeners.event.push(cb); return () => {}; },
    onEngineState: (cb) => { listeners.state.push(cb); return () => {}; }
  };
}

const sentOf = (api, type) => api.sent.filter((m) => m.type === type);

/**
 * Minimal container shim: only what the VST node editor actually touches.
 * `click()` replays a delegated click through every registered handler, so a
 * leaked handler shows up as a duplicated engine command.
 */
function makeContainer() {
  const handlers = [];
  return {
    innerHTML: '',
    querySelector: () => null,
    addEventListener(type, fn) { if (type === 'click') handlers.push(fn); },
    removeEventListener(type, fn) {
      if (type !== 'click') return;
      const i = handlers.indexOf(fn);
      if (i !== -1) handlers.splice(i, 1);
    },
    handlerCount: () => handlers.length,
    click(pluginId, action) {
      const target = {
        dataset: { action },
        closest: (sel) => (sel === '.plugin-card' ? { dataset: { pluginId } } : null)
      };
      for (const fn of [...handlers]) fn({ target });
    }
  };
}

// ---- the Open Plugin command contract --------------------------------------

test('openEditor addresses the runtime instance id, never the plugin registry id', async () => {
  const api = mockApi();
  const hub = createHub(api);
  hub.engine.init();
  const PLUGIN_ID = 'C:/Program Files/Common Files/VST3/Vital.vst3';
  api.emitEvent({
    type: 'plugins',
    plugins: [{ pluginId: PLUGIN_ID, name: 'Vital', manufacturer: 'Vital Audio', role: 'instrument' }]
  });

  const node = hub.nodes.create('vst');
  const chain = hub.nodes.getChain(node.id);
  const plugin = chain.append({ pluginId: PLUGIN_ID, name: 'Vital', role: 'instrument' });

  await hub.engine.createInstance(node.id, plugin.pluginId, plugin.id, 0);
  await hub.engine.openEditor(node.id, plugin.id);

  const open = sentOf(api, 'openEditor')[0];
  assert.deepEqual(open, { v: 1, type: 'openEditor', chainId: node.id, instanceId: plugin.id });
  // The runtime instance id must match the one the instance was created with,
  // and must never be the on-disk plugin identity.
  assert.equal(open.instanceId, sentOf(api, 'createInstance')[0].instanceId);
  assert.notEqual(open.instanceId, plugin.pluginId);
  assert.equal(open.chainId, node.id);
});

test('editorStatus from the engine reaches the renderer with real window geometry', () => {
  const api = mockApi();
  const hub = createHub(api);
  hub.engine.init();

  const seen = [];
  hub.events.on('engine:editorStatus', (msg) => seen.push(msg));

  api.emitEvent({ type: 'editorStatus', chainId: 'vst-001', instanceId: 'plugin-1', open: true, width: 1400, height: 820 });
  api.emitEvent({ type: 'editorStatus', chainId: 'vst-001', instanceId: 'plugin-1', open: false, message: 'plugin provides no editor' });

  assert.equal(seen.length, 2);
  assert.equal(seen[0].open, true);
  assert.equal(seen[0].width, 1400);
  assert.equal(seen[0].height, 820);
  assert.equal(seen[1].open, false);
  assert.equal(seen[1].message, 'plugin provides no editor');
});

// ---- module lifecycle: no leaked delegated handlers -------------------------

test('a VST node editor removes its click handler on unmount (no duplicated commands)', async () => {
  const api = mockApi();
  const hub = createHub(api);
  hub.engine.init();
  api.emitEvent({
    type: 'plugins',
    plugins: [{ pluginId: 'P', name: 'Dexed', manufacturer: 'Digital Suburban', role: 'instrument' }]
  });

  const nodeA = hub.nodes.create('vst');
  const chainA = hub.nodes.getChain(nodeA.id);
  const pluginA = chainA.append({ pluginId: 'P', name: 'Dexed', role: 'instrument' });

  const container = makeContainer();
  const moduleA = hub.modules.get(nodeA.id);

  moduleA.mount(container);
  assert.equal(container.handlerCount(), 1);

  container.click(pluginA.id, 'open');
  assert.equal(sentOf(api, 'openEditor').length, 1);

  // Navigating away and back must not stack handlers on the shared container.
  moduleA.unmount();
  assert.equal(container.handlerCount(), 0);
  moduleA.mount(container);
  assert.equal(container.handlerCount(), 1);

  container.click(pluginA.id, 'open');
  assert.equal(sentOf(api, 'openEditor').length, 2, 'one click must produce exactly one openEditor');
  moduleA.unmount();
});

test('an unmounted VST node never reacts to clicks meant for another node', async () => {
  const api = mockApi();
  const hub = createHub(api);
  hub.engine.init();
  api.emitEvent({ type: 'plugins', plugins: [{ pluginId: 'P', name: 'Dexed', role: 'instrument' }] });

  const nodeA = hub.nodes.create('vst');
  const nodeB = hub.nodes.create('vst');
  // Both chains use the same internal id sequence, so both hold a "plugin-1".
  const pluginA = hub.nodes.getChain(nodeA.id).append({ pluginId: 'P', name: 'Dexed', role: 'instrument' });
  const pluginB = hub.nodes.getChain(nodeB.id).append({ pluginId: 'P', name: 'Dexed', role: 'instrument' });
  assert.equal(pluginA.id, pluginB.id, 'precondition: colliding per-chain instance ids');

  const container = makeContainer();
  hub.modules.get(nodeA.id).mount(container);
  hub.modules.get(nodeA.id).unmount();
  hub.modules.get(nodeB.id).mount(container);

  container.click(pluginB.id, 'open');
  const opens = sentOf(api, 'openEditor');
  assert.equal(opens.length, 1);
  assert.equal(opens[0].chainId, nodeB.id);
});

// ---- chain rebuild after an engine restart ---------------------------------

test('persisted chains are rebuilt in the engine once it has a plugin registry', () => {
  const api = mockApi();
  const hub = createHub(api);
  hub.engine.init();
  setupChainSync(hub, () => {});

  const node = hub.nodes.create('vst');
  const chain = hub.nodes.getChain(node.id);
  const first = chain.append({ pluginId: 'A', name: 'Vital', role: 'instrument' });
  const second = chain.append({ pluginId: 'B', name: 'Valhalla', role: 'audio-effect' });
  chain.setBypass(second.id, true);

  // Nothing may be created before the engine knows the plugins.
  assert.equal(sentOf(api, 'createInstance').length, 0);

  api.emitEvent({ type: 'plugins', plugins: [{ pluginId: 'A', name: 'Vital' }, { pluginId: 'B', name: 'Valhalla' }] });

  const created = sentOf(api, 'createInstance');
  assert.equal(created.length, 2);
  assert.deepEqual(created.map((c) => c.instanceId), [first.id, second.id]);
  assert.deepEqual(created.map((c) => c.index), [0, 1], 'processing order must be preserved');
  assert.equal(created[0].chainId, node.id);
  assert.deepEqual(sentOf(api, 'setBypass').map((b) => b.instanceId), [second.id]);
});

test('a rebuild happens again after the engine goes down and comes back', () => {
  const api = mockApi();
  const hub = createHub(api);
  hub.engine.init();
  setupChainSync(hub, () => {});

  const node = hub.nodes.create('vst');
  hub.nodes.getChain(node.id).append({ pluginId: 'A', name: 'Vital', role: 'instrument' });

  const registry = { type: 'plugins', plugins: [{ pluginId: 'A', name: 'Vital' }] };
  api.emitEvent(registry);
  assert.equal(sentOf(api, 'createInstance').length, 1);

  // A second registry event alone must NOT duplicate the chain.
  api.emitEvent(registry);
  assert.equal(sentOf(api, 'createInstance').length, 1);

  // ...but an engine restart must rebuild it.
  api.emitState({ state: 'error', error: 'engine crashed' });
  api.emitState({ state: 'running', error: null });
  api.emitEvent(registry);
  assert.equal(sentOf(api, 'createInstance').length, 2);
});

// ---- deleting a VST node must stop it in the engine -------------------------

test('deleting a VST node tears its chain down in the engine', () => {
  const api = mockApi();
  const hub = createHub(api);
  hub.engine.init();
  hub.modules.register(createAudioOutputModule(hub));
  setupEngineSync(hub);

  const node = hub.nodes.create('vst');
  const chain = hub.nodes.getChain(node.id);
  const plugin = chain.append({ pluginId: 'A', name: 'Vital', role: 'instrument' });
  hub.graph.connect(node.id, 'audio-out', 'audio-output', 'audio-in');

  assert.ok(sentOf(api, 'setChainOutputEnabled').some((m) => m.chainId === node.id && m.enabled === true));

  api.sent.length = 0;
  hub.nodes.delete(node.id);

  const off = sentOf(api, 'setChainOutputEnabled').filter((m) => m.chainId === node.id);
  assert.ok(off.length > 0 && off[off.length - 1].enabled === false, 'output must be disabled on delete');
  assert.deepEqual(
    sentOf(api, 'removeInstance').map((m) => [m.chainId, m.instanceId]),
    [[node.id, plugin.id]],
    'plugin instances must be destroyed in the engine'
  );
  assert.equal(hub.graph.getNode(node.id), undefined);
});

// ---- MIDI routing is independent of which module is mounted ----------------

test('MIDI keeps reaching a connected VST chain regardless of the visible page', () => {
  const api = mockApi();
  const hub = createHub(api);
  hub.engine.init();
  setupMidiRouting(hub);

  hub.graph.addNode({ id: 'minilab-3', name: 'MiniLab', outputs: [{ id: 'midi-out', type: 'midi' }] });
  const node = hub.nodes.create('vst');
  hub.graph.connect('minilab-3', 'midi-out', node.id, 'midi-in');

  hub.events.emit('midi:message', { type: 'noteon', channel: 1, note: 60, velocity: 100, raw: [0x90, 60, 100] });
  assert.equal(sentOf(api, 'midi').length, 1);

  // Mounting/unmounting any module must not affect routing.
  const container = makeContainer();
  hub.modules.get(node.id).mount(container);
  hub.modules.get(node.id).unmount();

  hub.events.emit('midi:message', { type: 'noteoff', channel: 1, note: 60, velocity: 0, raw: [0x80, 60, 0] });
  assert.equal(sentOf(api, 'midi').length, 2);
  assert.deepEqual(sentOf(api, 'midi')[1].data, [0x80, 60, 0]);
});

// ---- untrusted plugin metadata is never markup -----------------------------

test('plugin names and vendors from disk are escaped, never rendered as markup', () => {
  assert.equal(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(escapeHtml('A & B "quoted"'), 'A &amp; B &quot;quoted&quot;');
  assert.equal(escapeHtml(null), '');
});
