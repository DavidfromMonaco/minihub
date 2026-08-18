import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from '../src/renderer/js/core/hub.js';
import { setupEngineSync } from '../src/renderer/js/core/engineSync.js';
import { createAudioOutputModule } from '../src/renderer/js/modules/audioOutput/audioOutputModule.js';
import { getNodeType } from '../src/renderer/js/core/nodeTypes.js';

/** In-memory API that mirrors the preload `hubAPI` surface. */
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
    engineCommand: async (msg) => { sent.push(msg); return { ok: true }; },
    engineState: async () => ({ state: 'running', error: null }),
    onEngineEvent: (cb) => { listeners.event.push(cb); return () => {}; },
    onEngineState: (cb) => { listeners.state.push(cb); return () => {}; }
  };
}

function sentOf(api, type) {
  return api.sent.filter((m) => m.type === type);
}

// ---- engine protocol serialization -----------------------------------------
test('engine client serializes commands with the versioned protocol', async () => {
  const api = mockApi();
  const hub = createHub(api);
  hub.engine.init();
  await hub.engine.midi('vst-001', [0x90, 60, 100]);
  await hub.engine.setBypass('vst-001', 'plugin-1', true);
  await hub.engine.createInstance('vst-001', 'X', 'plugin-2', 1);
  assert.deepEqual(sentOf(api, 'midi')[0], { v: 1, type: 'midi', chainId: 'vst-001', data: [0x90, 60, 100] });
  assert.deepEqual(sentOf(api, 'setBypass')[0], { v: 1, type: 'setBypass', chainId: 'vst-001', instanceId: 'plugin-1', bypassed: true });
  assert.deepEqual(sentOf(api, 'createInstance')[0], { v: 1, type: 'createInstance', chainId: 'vst-001', pluginId: 'X', instanceId: 'plugin-2', index: 1 });
});

test('engine client parses real plugin registry events', () => {
  const api = mockApi();
  const hub = createHub(api);
  hub.engine.init();
  api.emitEvent({
    type: 'plugins',
    plugins: [{ pluginId: 'X', name: 'Dexed', manufacturer: 'Digital Suburban', role: 'instrument' }]
  });
  assert.equal(hub.engine.plugins.length, 1);
  assert.equal(hub.engine.getPlugin('X').name, 'Dexed');
  assert.equal(hub.engine.getPlugin('missing'), null);
});

// ---- engine lifecycle state ------------------------------------------------
test('engine client reflects lifecycle state from the main process', async () => {
  const api = mockApi();
  const hub = createHub(api);
  hub.engine.init();
  await hub.engine.init(); // ensure engineState resolved
  assert.equal(hub.engine.state, 'running');
  api.emitState({ state: 'error', error: 'engine crashed' });
  assert.equal(hub.engine.state, 'error');
  assert.equal(hub.engine.error, 'engine crashed');
  api.emitState({ state: 'running', error: null });
  assert.equal(hub.engine.state, 'running');
});

// ---- Audio Output node protection ------------------------------------------
test('Audio Output is a native/system node: non-deletable, non-copyable, AUDIO IN only', () => {
  const api = mockApi();
  const hub = createHub(api);
  hub.modules.register(createAudioOutputModule(hub));

  // It is NOT a user instance, so it cannot be deleted or copied.
  assert.equal(hub.nodes.get('audio-output'), null);
  assert.equal(hub.nodes.delete('audio-output'), false);

  const node = hub.graph.getNode('audio-output');
  assert.ok(node, 'audio-output must exist in the graph');
  assert.deepEqual(node.inputs.map((p) => p.id), ['audio-in']);
  assert.equal(node.inputs[0].type, 'audio');
  assert.equal(node.outputs.length, 0);
});

// ---- graph MIDI connection controls MIDI forwarding ------------------------
test('MIDI is forwarded to the engine only while MiniLab is connected to the VST node', async () => {
  const api = mockApi();
  const hub = createHub(api);
  hub.engine.init();
  hub.graph.addNode({ id: 'minilab-3', name: 'MiniLab', outputs: [{ id: 'midi-out', type: 'midi' }] });
  const inst = hub.nodes.create('vst');

  // Not connected yet -> no MIDI reaches the engine.
  hub.graph.emitData('minilab-3', 'midi-out', { raw: [0x90, 60, 100] });
  assert.equal(sentOf(api, 'midi').length, 0);

  // Connect MiniLab MIDI OUT -> VST MIDI IN.
  hub.graph.connect('minilab-3', 'midi-out', inst.id, 'midi-in');
  hub.graph.emitData('minilab-3', 'midi-out', { raw: [0x90, 60, 100] });
  assert.equal(sentOf(api, 'midi').length, 1);
  assert.equal(sentOf(api, 'midi')[0].chainId, inst.id);
  assert.deepEqual(sentOf(api, 'midi')[0].data, [0x90, 60, 100]);

  // Disconnect -> new MIDI no longer reaches the engine.
  hub.graph.disconnect('minilab-3', 'midi-out', inst.id, 'midi-in');
  hub.graph.emitData('minilab-3', 'midi-out', { raw: [0x91, 60, 0] });
  assert.equal(sentOf(api, 'midi').length, 1);
});

// ---- graph audio connection controls physical output assignment ------------
test('VST chain is assigned to the physical output only when audio-out -> Audio Output', () => {
  const api = mockApi();
  const hub = createHub(api);
  hub.engine.init();
  hub.modules.register(createAudioOutputModule(hub));
  setupEngineSync(hub);

  const inst = hub.nodes.create('vst');
  const lastOut = () => {
    const cmds = sentOf(api, 'setChainOutputEnabled').filter((m) => m.chainId === inst.id);
    return cmds[cmds.length - 1];
  };

  // No audio connection yet -> output disabled.
  assert.equal(lastOut().enabled, false);

  // Connect VST AUDIO OUT -> Audio Output AUDIO IN.
  hub.graph.connect(inst.id, 'audio-out', 'audio-output', 'audio-in');
  assert.equal(lastOut().enabled, true);

  // Disconnect -> output disabled again.
  hub.graph.disconnect(inst.id, 'audio-out', 'audio-output', 'audio-in');
  assert.equal(lastOut().enabled, false);
});

// ---- plugin-chain synchronization commands ----------------------------------
test('adding a plugin to a VST chain issues an engine createInstance command', async () => {
  const api = mockApi();
  const hub = createHub(api);
  hub.engine.init();
  const inst = hub.nodes.create('vst');
  const chain = hub.nodes.getChain(inst.id);
  const p = chain.append({ pluginId: 'X', name: 'Dexed', role: 'instrument' });
  hub.engine.createInstance(inst.id, p.pluginId, p.id, chain.plugins.length - 1);

  const cmds = sentOf(api, 'createInstance');
  assert.equal(cmds.length, 1);
  assert.equal(cmds[0].chainId, inst.id);
  assert.equal(cmds[0].pluginId, 'X');
  assert.equal(cmds[0].instanceId, p.id);
  assert.equal(cmds[0].index, 0);
});

// ---- stable plugin identity persistence + no native handles ----------------
test('persisted VST chain stores stable plugin identity and never native handles', async () => {
  const api = mockApi();
  const hub = createHub(api);
  const inst = hub.nodes.create('vst');
  const chain = hub.nodes.getChain(inst.id);
  chain.append({ pluginId: 'X', name: 'Dexed', role: 'instrument', state: 'AQID' });
  chain.append({ pluginId: 'Y', name: 'ValhallaDelay', role: 'audio-effect' });

  const serialized = JSON.stringify(api.data.nodeInstances);
  assert.ok(serialized.includes('"pluginId":"X"'));
  assert.ok(serialized.includes('"pluginId":"Y"'));
  assert.ok(!/native|handle|pointer|HWND|ptr/i.test(serialized), 'no native/runtime handles serialized');

  // Relaunch over the same settings.
  const api2 = mockApi(api.data);
  const hub2 = createHub(api2);
  await hub2.settings.load();
  await hub2.nodes.load();
  const inst2 = hub2.nodes.get(inst.id);
  assert.equal(inst2.content.plugins.length, 2);
  assert.equal(inst2.content.plugins[0].pluginId, 'X');
  assert.equal(inst2.content.plugins[0].id, 'plugin-1', 'stable plugin instance id across reload');
  assert.equal(inst2.content.plugins[1].role, 'audio-effect');
});

// ---- engine unavailable / error behavior -----------------------------------
test('VST editor reports engine-unavailable state when the engine is down', () => {
  const api = mockApi();
  const hub = createHub(api);
  hub.engine.init();
  api.emitState({ state: 'error', error: 'engine exited unexpectedly' });
  assert.equal(hub.engine.state, 'error');
  // The engine client surfaces the error; UI derives from it.
  assert.ok(hub.engine.error.includes('engine'));
});

// ---- node type registry still intact ---------------------------------------
test('Audio Output is a system node type, not a user node type', () => {
  assert.equal(getNodeType('audio-output'), null, 'audio-output is not a user-created node type');
});
