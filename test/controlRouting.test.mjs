import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from '../src/renderer/js/core/hub.js';
import { setupMidiRouting } from '../src/renderer/js/core/midiRouting.js';
import { setupControlRouting } from '../src/renderer/js/core/controlRouting.js';
import {
  MINILAB_CONTROL_SOURCES,
  decodeMiniLabControl
} from '../src/renderer/js/midi/minilabControls.js';
import {
  CONTROL_BINDING_VERSION,
  isStableVstParameterId,
  normalizeControlBinding
} from '../src/renderer/js/core/controlBindings.js';
import commandValidation from '../src/main/vstParameterCommand.js';
import learnCommandValidation from '../src/main/vstParameterLearnCommand.js';

const { isValidSetVstParameterCommand } = commandValidation;
const { isValidSetVstParameterLearnCommand } = learnCommandValidation;

function mockApi(initialSettings = {}) {
  const data = { ...initialSettings };
  const sent = [];
  const listeners = { event: [], state: [] };
  return {
    data,
    sent,
    emitEvent(msg) { listeners.event.forEach((cb) => cb(msg)); },
    emitState(msg) { listeners.state.forEach((cb) => cb(msg)); },
    loadSettings: async () => ({ ...data }),
    saveSettings: async (settings) => { Object.assign(data, settings); return true; },
    diagnosticsLog: () => true,
    engineCommand: async (msg) => { sent.push(msg); return { ok: true }; },
    engineState: async () => ({ state: 'running', error: null }),
    onEngineEvent: (cb) => { listeners.event.push(cb); return () => {}; },
    onEngineState: (cb) => { listeners.state.push(cb); return () => {}; }
  };
}

const sentOf = (api, type) => api.sent.filter((msg) => msg.type === type);
const source = (key) => MINILAB_CONTROL_SOURCES.find((item) => item.key === key);

function addMiniLabNode(hub) {
  hub.graph.addNode({
    id: 'minilab-3',
    name: 'MiniLab 3',
    inputs: [],
    outputs: [
      { id: 'midi-out', type: 'midi', label: 'MIDI Out' },
      ...MINILAB_CONTROL_SOURCES.map((item) => ({
        id: item.portId, type: 'control', label: item.label
      }))
    ]
  });
}

async function makeRig() {
  const api = mockApi();
  const hub = createHub(api);
  await hub.settings.load();
  addMiniLabNode(hub);
  await hub.engine.init();
  const node = hub.nodes.create('vst');
  const plugin = hub.nodes.getChain(node.id).append({
    pluginId: 'C:/VST3/Vital.vst3', name: 'Vital', role: 'instrument'
  });
  api.emitEvent({
    type: 'instanceStatus', chainId: node.id, instanceId: plugin.id,
    pluginId: plugin.pluginId, generation: 7, status: 'ready'
  });
  api.emitEvent({
    type: 'editorStatus', chainId: node.id, instanceId: plugin.id,
    pluginId: plugin.pluginId, generation: 7, open: true, width: 800, height: 600
  });
  api.sent.length = 0;
  return { api, hub, node, plugin };
}

function connect(hub, nodeId, key) {
  const item = source(key);
  hub.graph.connect('minilab-3', item.portId, nodeId, 'ctrl-in');
  return item;
}

function capture(api, hub, node, plugin, key = 'k1', overrides = {}) {
  const item = source(key);
  const armed = hub.control.armLearn(node.id, item.id);
  assert.equal(armed.ok, true);
  const pending = hub.control.pendingLearn;
  api.emitEvent({
    type: 'vstParameterLearnState', learnId: pending.learnId,
    chainId: node.id, instanceId: plugin.id, pluginId: plugin.pluginId,
    generation: 7, armed: true, reason: 'armed'
  });
  api.emitEvent({
    type: 'vstParameterTouched',
    chainId: node.id,
    instanceId: plugin.id,
    pluginId: plugin.pluginId,
    generation: 7,
    parameterId: '123456789',
    name: 'Filter Cutoff',
    normalizedValue: 0.5,
    gestureAware: true,
    capturedByLearn: true,
    learnId: pending.learnId,
    ...overrides
  });
}

function ackCurrent(api, hub, armed, reason = armed ? 'armed' : 'cancelled', overrides = {}) {
  const pending = hub.control.pendingLearn;
  api.emitEvent({
    type: 'vstParameterLearnState', learnId: pending.learnId,
    chainId: pending.nodeId, instanceId: pending.pluginInstanceId,
    pluginId: pending.pluginId, generation: pending.generation,
    armed, reason, ...overrides
  });
  return pending;
}

test('MiniLab K1-K8 have stable physical identities and documented default CCs', () => {
  const knobs = MINILAB_CONTROL_SOURCES.filter((item) => item.family === 'knob');
  assert.deepEqual(knobs.map((item) => item.id), [
    'minilab-3:k1', 'minilab-3:k2', 'minilab-3:k3', 'minilab-3:k4',
    'minilab-3:k5', 'minilab-3:k6', 'minilab-3:k7', 'minilab-3:k8'
  ]);
  assert.deepEqual(knobs.map((item) => item.cc), [74, 71, 76, 77, 93, 18, 19, 16]);
  const a = decodeMiniLabControl({ type: 'cc', sourceName: 'Minilab3 MIDI', sourceId: 'port-a', channel: 1, controller: 74, value: 1 });
  const b = decodeMiniLabControl({ type: 'cc', sourceName: 'MiniLab 3 ALV', sourceId: 'port-b', channel: 16, controller: 74, value: 2 });
  assert.equal(a.sourceControlId, b.sourceControlId, 'port id and channel are not binding identity');
});

test('CONTROL remains type-safe and does not create an implicit MIDI cable', async () => {
  const { api, hub, node } = await makeRig();
  connect(hub, node.id, 'k1');
  assert.throws(() => hub.graph.connect('minilab-3', 'midi-out', node.id, 'ctrl-in'), /Incompatible/);
  setupMidiRouting(hub);
  setupControlRouting(hub);
  const msg = { type: 'cc', sourceName: 'Minilab3 MIDI', channel: 1, controller: 74, value: 64, raw: [0xb0, 74, 64] };
  hub.events.emit('midi:message', msg);
  hub.events.emit('midi:cc', msg);
  assert.equal(sentOf(api, 'midi').length, 0);
});

test('one VST CTRL IN accepts multiple distinct CONTROL cables', async () => {
  const { hub, node } = await makeRig();
  connect(hub, node.id, 'k1');
  connect(hub, node.id, 'k2');
  assert.equal(hub.graph.connectionsTo(node.id, 'ctrl-in').length, 2);
  assert.deepEqual(hub.control.connectedSources(node.id).map((item) => item.key), ['k1', 'k2']);
});

test('native LEARN capture persists exact node/plugin/ParamID identity', async () => {
  const { api, hub, node, plugin } = await makeRig();
  connect(hub, node.id, 'k1');
  capture(api, hub, node, plugin);
  assert.deepEqual(hub.nodes.getControlBindings(node.id)[0], {
    version: CONTROL_BINDING_VERSION,
    sourceControlId: 'minilab-3:k1',
    pluginInstanceId: plugin.id,
    pluginId: plugin.pluginId,
    parameterId: '123456789',
    pluginName: 'Vital',
    parameterName: 'Filter Cutoff'
  });
});

test('last-touched without native capturedByLearn never mutates a binding', async () => {
  const { api, hub, node, plugin } = await makeRig();
  connect(hub, node.id, 'k1');
  hub.control.armLearn(node.id, source('k1').id);
  const pending = hub.control.pendingLearn;
  api.emitEvent({
    type: 'vstParameterLearnState', learnId: pending.learnId,
    chainId: node.id, instanceId: plugin.id, pluginId: plugin.pluginId,
    generation: 7, armed: true
  });
  api.emitEvent({
    type: 'vstParameterTouched', chainId: node.id, instanceId: plugin.id,
    pluginId: plugin.pluginId, generation: 7, parameterId: '42', name: 'Gain',
    normalizedValue: 0.2, gestureAware: true, capturedByLearn: false
  });
  assert.deepEqual(hub.nodes.getControlBindings(node.id), []);
  assert.ok(hub.control.pendingLearn);
});

test('plugin reorder preserves the binding instance id and ParamID', async () => {
  const { api, hub, node, plugin } = await makeRig();
  connect(hub, node.id, 'k1');
  const other = hub.nodes.getChain(node.id).append({ pluginId: 'B', name: 'FX', role: 'audio-effect' });
  capture(api, hub, node, plugin);
  hub.nodes.getChain(node.id).reorder(plugin.id, 1);
  const binding = hub.nodes.getControlBindings(node.id)[0];
  assert.equal(binding.pluginInstanceId, plugin.id);
  assert.equal(binding.parameterId, '123456789');
  assert.deepEqual(node.content.plugins.map((item) => item.id), [other.id, plugin.id]);
  api.sent.length = 0;
  assert.deepEqual(hub.control.route(node.id, {
    type: 'control', sourceControlId: 'minilab-3:k1', normalizedValue: 0.3
  }), { ok: true });
  assert.equal(sentOf(api, 'setVstParameter')[0].instanceId, plugin.id);
});

test('binding survives application reload with graph topology', async () => {
  const { api, hub, node, plugin } = await makeRig();
  connect(hub, node.id, 'k1');
  capture(api, hub, node, plugin);
  await new Promise((resolve) => setImmediate(resolve));

  const restarted = createHub(mockApi(api.data));
  await restarted.settings.load();
  addMiniLabNode(restarted);
  await restarted.nodes.load();
  restarted.graph.restore(restarted.settings.get('graphConnections'));
  const restored = restarted.nodes.getControlBindings(node.id)[0];
  assert.equal(restored.pluginInstanceId, plugin.id);
  assert.equal(restored.parameterId, '123456789');
  assert.equal(restarted.control.isConnected(node.id, 'minilab-3:k1'), true);
});

test('a deleted plugin leaves a diagnosable binding but receives no update', async () => {
  const { api, hub, node, plugin } = await makeRig();
  connect(hub, node.id, 'k1');
  capture(api, hub, node, plugin);
  hub.nodes.getChain(node.id).remove(plugin.id);
  api.sent.length = 0;
  const result = hub.control.route(node.id, { type: 'control', sourceControlId: 'minilab-3:k1', normalizedValue: 0.4 });
  assert.equal(result.reason, 'missing-target');
  assert.equal(sentOf(api, 'setVstParameter').length, 0);
  assert.equal(hub.nodes.getControlBindings(node.id).length, 1);
});

test('a different plugin reusing an instance id cannot inherit the binding', async () => {
  const { api, hub, node, plugin } = await makeRig();
  connect(hub, node.id, 'k1');
  capture(api, hub, node, plugin);
  node.content.plugins[0] = { ...plugin, pluginId: 'C:/VST3/Replacement.vst3', name: 'Replacement' };
  api.sent.length = 0;
  const result = hub.control.route(node.id, { type: 'control', sourceControlId: 'minilab-3:k1', normalizedValue: 0.4 });
  assert.equal(result.reason, 'missing-target');
  assert.equal(sentOf(api, 'setVstParameter').length, 0);
});

test('stale-generation LEARN events are ignored', async () => {
  const { api, hub, node, plugin } = await makeRig();
  connect(hub, node.id, 'k1');
  capture(api, hub, node, plugin, 'k1', { generation: 6 });
  assert.deepEqual(hub.nodes.getControlBindings(node.id), []);
  assert.ok(hub.control.pendingLearn);
});

test('CONTROL values reach native normalized at exact 0, midpoint and 1', async () => {
  const { api, hub, node, plugin } = await makeRig();
  connect(hub, node.id, 'k1');
  capture(api, hub, node, plugin);
  api.sent.length = 0;
  for (const value of [0, 64, 127]) {
    const decoded = decodeMiniLabControl({ type: 'cc', sourceName: 'Minilab3 MIDI', controller: 74, value });
    hub.control.route(node.id, decoded);
  }
  const writes = sentOf(api, 'setVstParameter');
  assert.deepEqual(writes.map((msg) => msg.normalizedValue), [0, 64 / 127, 1]);
  assert.ok(writes.every((msg) => msg.parameterId === '123456789' && msg.generation === 7));
});

test('learned CONTROL routing does not require the editor to remain visible', async () => {
  const { api, hub, node, plugin } = await makeRig();
  connect(hub, node.id, 'k1');
  capture(api, hub, node, plugin);
  api.sent.length = 0;
  const result = hub.control.route(node.id, { type: 'control', sourceControlId: 'minilab-3:k1', normalizedValue: 0.75 });
  assert.deepEqual(result, { ok: true });
  assert.equal(sentOf(api, 'openEditor').length, 0);
  assert.equal(sentOf(api, 'setVstParameter').length, 1);
});

test('Clear removes persistence and immediately stops updates', async () => {
  const { api, hub, node, plugin } = await makeRig();
  connect(hub, node.id, 'k1');
  capture(api, hub, node, plugin);
  assert.equal(hub.control.clear(node.id, 'minilab-3:k1'), true);
  api.sent.length = 0;
  const result = hub.control.route(node.id, { type: 'control', sourceControlId: 'minilab-3:k1', normalizedValue: 0.5 });
  assert.equal(result.reason, 'unbound');
  assert.deepEqual(hub.nodes.getControlBindings(node.id), []);
  assert.equal(sentOf(api, 'setVstParameter').length, 0);
});

test('malformed and fallback parameter identities are rejected', () => {
  assert.equal(isStableVstParameterId('0'), true);
  assert.equal(isStableVstParameterId('4294967295'), true);
  for (const id of ['param-12', 'Gain', '-1', '01', '4294967296', 12, null]) {
    assert.equal(isStableVstParameterId(id), false, String(id));
  }
  assert.equal(normalizeControlBinding({
    version: 1, sourceControlId: 'minilab-3:k1', pluginInstanceId: 'plugin-1',
    pluginId: 'X', parameterId: 'param-12'
  }), null);
});

test('CONTROL IPC validation rejects malformed ids, types, ranges and payloads', () => {
  const valid = {
    v: 1, type: 'setVstParameter', chainId: 'vst-001', instanceId: 'plugin-1',
    pluginId: 'C:/VST3/Vital.vst3', generation: 7,
    parameterId: '4294967295', normalizedValue: 0.5
  };
  assert.equal(isValidSetVstParameterCommand(valid), true);
  for (const mutation of [
    { chainId: 1 }, { chainId: '../x' }, { instanceId: 'plugin-0' },
    { pluginId: '' }, { pluginId: 'x'.repeat(2049) }, { generation: 0 },
    { generation: 1.5 }, { parameterId: 'param-1' }, { parameterId: '4294967296' },
    { normalizedValue: -0.1 }, { normalizedValue: 1.1 }, { normalizedValue: '0.5' },
    { normalizedValue: Number.NaN }, { v: 2 }
  ]) {
    assert.equal(isValidSetVstParameterCommand({ ...valid, ...mutation }), false, JSON.stringify(mutation));
  }
});

test('musical notes and K1 MIDI remain native while K1 is additionally CONTROL', async () => {
  const { api, hub, node, plugin } = await makeRig();
  connect(hub, node.id, 'k1');
  hub.graph.connect('minilab-3', 'midi-out', node.id, 'midi-in');
  capture(api, hub, node, plugin);
  setupMidiRouting(hub);
  setupControlRouting(hub);
  api.sent.length = 0;
  hub.events.emit('midi:message', { type: 'noteon', sourceName: 'Minilab3 MIDI', channel: 1, note: 60, velocity: 100, raw: [0x90, 60, 100] });
  const cc = { type: 'cc', sourceName: 'Minilab3 MIDI', channel: 1, controller: 74, value: 127, raw: [0xb0, 74, 127] };
  hub.events.emit('midi:message', cc);
  hub.events.emit('midi:cc', cc);
  assert.equal(sentOf(api, 'midi').length, 2);
  assert.deepEqual(sentOf(api, 'midi')[0].data, [0x90, 60, 100]);
  assert.deepEqual(sentOf(api, 'midi')[1].data, [0xb0, 74, 127]);
  assert.equal(sentOf(api, 'setVstParameter').length, 1);
});

test('documented faders, main encoder, pads, strips and Shift decode with physical semantics', () => {
  const base = { sourceName: 'Minilab3 MIDI', channel: 1 };
  assert.deepEqual(
    ['f1', 'f2', 'f3', 'f4'].map((key) => decodeMiniLabControl({ ...base, type: 'cc',
      controller: source(key).cc, value: 64 }).sourceControlId),
    ['minilab-3:f1', 'minilab-3:f2', 'minilab-3:f3', 'minilab-3:f4']
  );
  assert.equal(decodeMiniLabControl({ ...base, type: 'cc', controller: 114, value: 10 }).semantics, 'continuous-absolute');
  assert.equal(decodeMiniLabControl({ ...base, type: 'cc', controller: 115, value: 127 }).semantics, 'momentary-or-toggle');
  assert.equal(decodeMiniLabControl({ ...base, type: 'cc', controller: 9, value: 127 }).sourceControlId, 'minilab-3:shift');
  const pitch = decodeMiniLabControl({ ...base, type: 'pitchbend', bend: 0 });
  assert.equal(pitch.sourceControlId, 'minilab-3:pitch-bend');
  assert.equal(pitch.normalizedValue, 0);
  assert.equal(pitch.bipolarValue, -1);
  assert.equal(decodeMiniLabControl({ ...base, type: 'cc', controller: 1, value: 127 }).sourceControlId, 'minilab-3:modulation');
  const padOn = decodeMiniLabControl({ ...base, channel: 10, type: 'noteon', note: 36, velocity: 96 });
  const padPressure = decodeMiniLabControl({ ...base, channel: 10, type: 'polyaftertouch', note: 44, value: 32 });
  const padOff = decodeMiniLabControl({ ...base, channel: 10, type: 'noteoff', note: 36, velocity: 64 });
  assert.deepEqual([padOn.sourceControlId, padPressure.sourceControlId, padOff.normalizedValue],
    ['minilab-3:p1', 'minilab-3:p1', 0]);
  assert.equal(decodeMiniLabControl({ ...base, channel: 1, type: 'noteon', note: 36, velocity: 96 }), null,
    'overlapping keyboard notes are not misclassified as pads');
});

test('Pitch Bend and factory Mod CC1 remain musical MIDI while adding CONTROL', async () => {
  const { api, hub, node, plugin } = await makeRig();
  hub.graph.connect('minilab-3', 'midi-out', node.id, 'midi-in');
  connect(hub, node.id, 'pitch-bend');
  connect(hub, node.id, 'modulation');
  capture(api, hub, node, plugin, 'pitch-bend');
  capture(api, hub, node, plugin, 'modulation', { parameterId: '987654321', name: 'Mod Depth' });
  setupMidiRouting(hub);
  setupControlRouting(hub);
  api.sent.length = 0;
  hub.events.emit('midi:message', { type: 'pitchbend', sourceName: 'Minilab3 MIDI', channel: 1,
    bend: 12288, raw: [0xe0, 0, 96] });
  hub.events.emit('midi:message', { type: 'cc', sourceName: 'Minilab3 MIDI', channel: 1,
    controller: 1, value: 100, raw: [0xb0, 1, 100] });
  const midi = sentOf(api, 'midi');
  assert.equal(midi.length, 2);
  assert.deepEqual(midi.map((msg) => msg.data), [[0xe0, 0, 96], [0xb0, 1, 100]]);
  assert.equal(sentOf(api, 'setVstParameter').length, 2);
});

test('valid capture and Cancel restore Hub focus while stale touches do not', async () => {
  const { api, hub, node, plugin } = await makeRig();
  connect(hub, node.id, 'k1');
  let focusCount = 0;
  const previousWindow = globalThis.window;
  globalThis.window = { hubAPI: { focusMainWindow: async () => { focusCount += 1; return true; } } };
  try {
    hub.control.armLearn(node.id, source('k1').id);
    ackCurrent(api, hub, true);
    api.emitEvent({ type: 'vstParameterTouched', learnId: 'stale', chainId: node.id,
      instanceId: plugin.id, pluginId: plugin.pluginId, generation: 7,
      parameterId: '42', name: 'Wrong', normalizedValue: 0.2, capturedByLearn: true });
    assert.equal(focusCount, 0);
    const pending = hub.control.pendingLearn;
    api.emitEvent({ type: 'vstParameterTouched', learnId: pending.learnId, chainId: node.id,
      instanceId: plugin.id, pluginId: plugin.pluginId, generation: 7,
      parameterId: '42', name: 'Cutoff', normalizedValue: 0.2, capturedByLearn: true });
    assert.equal(focusCount, 1);
    hub.control.armLearn(node.id, source('k1').id);
    hub.control.cancelLearn();
    assert.equal(focusCount, 2);
  } finally {
    globalThis.window = previousWindow;
  }
});

test('disconnecting the CONTROL cable stops updates without deleting binding', async () => {
  const { api, hub, node, plugin } = await makeRig();
  const k1 = connect(hub, node.id, 'k1');
  capture(api, hub, node, plugin);
  hub.graph.disconnect('minilab-3', k1.portId, node.id, 'ctrl-in');
  api.sent.length = 0;
  assert.equal(hub.control.bindingStatus(node.id, k1.id).state, 'disconnected');
  assert.equal(hub.control.route(node.id, { type: 'control', sourceControlId: k1.id, normalizedValue: 0.2 }).reason, 'disconnected');
  assert.equal(sentOf(api, 'setVstParameter').length, 0);
});

test('disconnect/delete cancel pending Learn without retaining a stale node target', async () => {
  const { api, hub, node, plugin } = await makeRig();
  const k1 = connect(hub, node.id, 'k1');
  hub.control.armLearn(node.id, k1.id);
  let pending = hub.control.pendingLearn;
  hub.graph.disconnect('minilab-3', k1.portId, node.id, 'ctrl-in');
  assert.equal(pending.state, 'cancelling');
  api.emitEvent({
    type: 'vstParameterLearnState', learnId: pending.learnId, chainId: node.id,
    instanceId: plugin.id, pluginId: plugin.pluginId, generation: 7, armed: false,
    reason: 'cancelled'
  });
  assert.equal(hub.control.pendingLearn, null);

  connect(hub, node.id, 'k1');
  hub.control.armLearn(node.id, k1.id);
  pending = hub.control.pendingLearn;
  hub.nodes.delete(node.id);
  api.emitEvent({
    type: 'vstParameterLearnState', learnId: pending.learnId, chainId: node.id,
    instanceId: plugin.id, pluginId: plugin.pluginId, generation: 7, armed: false,
    reason: 'target-removed'
  });
  assert.equal(hub.control.pendingLearn, null);
});

test('engine restart blocks writes until the exact instance is ready again', async () => {
  const { api, hub, node, plugin } = await makeRig();
  connect(hub, node.id, 'k1');
  capture(api, hub, node, plugin);
  api.emitState({ state: 'error', error: 'crashed' });
  assert.equal(hub.control.route(node.id, { type: 'control', sourceControlId: 'minilab-3:k1', normalizedValue: 0.2 }).reason, 'not-ready');
  api.emitState({ state: 'running', error: null });
  api.emitEvent({ type: 'instanceStatus', chainId: node.id, instanceId: plugin.id, pluginId: plugin.pluginId, generation: 11, status: 'ready' });
  api.sent.length = 0;
  assert.deepEqual(hub.control.route(node.id, { type: 'control', sourceControlId: 'minilab-3:k1', normalizedValue: 0.2 }), { ok: true });
  assert.equal(sentOf(api, 'setVstParameter')[0].generation, 11);
});

test('duplicating a VST node copies plugins with fresh ids but no bindings', async () => {
  const { api, hub, node, plugin } = await makeRig();
  connect(hub, node.id, 'k1');
  capture(api, hub, node, plugin);
  const duplicate = hub.nodes.duplicate(node.id);
  assert.equal(duplicate.content.plugins.length, 1);
  assert.notEqual(duplicate.content.plugins[0].id, plugin.id);
  assert.deepEqual(duplicate.content.controlBindings, []);
  assert.equal(hub.graph.connectionsTo(duplicate.id, 'ctrl-in').length, 0);
});

test('VST editor exposes the shared MiniLab surface and guided Learn toolbar', async () => {
  const { api, hub, node } = await makeRig();
  connect(hub, node.id, 'k1');
  const handlers = [];
  const container = {
    innerHTML: '',
    querySelector: () => null,
    addEventListener(type, handler) { if (type === 'click') handlers.push(handler); },
    removeEventListener(type, handler) {
      if (type !== 'click') return;
      const i = handlers.indexOf(handler);
      if (i !== -1) handlers.splice(i, 1);
    }
  };
  hub.modules.get(node.id).mount(container);
  assert.match(container.innerHTML, /Control Bindings/);
  assert.match(container.innerHTML, /K1/);
  assert.match(container.innerHTML, /K8/);
  assert.match(container.innerHTML, /data-minilab-surface="learn"/);
  assert.match(container.innerHTML, /opens and foregrounds the target OmniBox/);
  const target = {
    dataset: { controlAction: 'learn', sourceControlId: 'minilab-3:k1' },
    closest: () => null
  };
  handlers[0]({ target });
  assert.equal(hub.control.pendingLearn.nodeId, node.id);
  assert.equal(hub.control.pendingLearn.sourceControlId, 'minilab-3:k1');
  assert.equal(hub.control.pendingLearn.pluginInstanceId, 'plugin-1');
  hub.control.cancelLearn();
  ackCurrent(api, hub, false);
  hub.modules.get(node.id).unmount();
  assert.equal(handlers.length, 0);
});

test('Learn opens a closed target editor and arms without an OmniBox button', async () => {
  const { api, hub, node, plugin } = await makeRig();
  connect(hub, node.id, 'k1');
  api.emitEvent({ type: 'editorStatus', chainId: node.id, instanceId: plugin.id,
    pluginId: plugin.pluginId, generation: 7, open: false });
  assert.equal(hub.control.armLearn(node.id, source('k1').id).ok, true);
  const open = sentOf(api, 'openEditor')[0];
  assert.deepEqual(open, { v: 1, type: 'openEditor', chainId: node.id,
    instanceId: plugin.id, pluginId: plugin.pluginId, generation: 7 });
  assert.equal(sentOf(api, 'setVstParameterLearn').length, 1);
});

test('Learn refuses an ambiguous node with two open plugin editors', async () => {
  const { api, hub, node } = await makeRig();
  connect(hub, node.id, 'k1');
  const second = hub.nodes.getChain(node.id).append({ pluginId: 'B', name: 'FX', role: 'audio-effect' });
  api.emitEvent({ type: 'instanceStatus', chainId: node.id, instanceId: second.id,
    pluginId: second.pluginId, generation: 8, status: 'ready' });
  api.emitEvent({ type: 'editorStatus', chainId: node.id, instanceId: second.id,
    pluginId: second.pluginId, generation: 8, open: true });
  assert.equal(hub.control.armLearn(node.id, source('k1').id).reason, 'multiple-plugin-editors-open');
  assert.equal(sentOf(api, 'setVstParameterLearn').length, 0);
});

test('Learn arm command carries exact target, generation and opaque operation id', async () => {
  const { api, hub, node, plugin } = await makeRig();
  connect(hub, node.id, 'k1');
  const result = hub.control.armLearn(node.id, source('k1').id);
  const command = sentOf(api, 'setVstParameterLearn')[0];
  assert.equal(result.learnId, command.learnId);
  assert.deepEqual({ ...command, learnId: '<opaque>' }, {
    v: 1, type: 'setVstParameterLearn', chainId: node.id, instanceId: plugin.id,
    pluginId: plugin.pluginId, generation: 7, learnId: '<opaque>', armed: true
  });
  ackCurrent(api, hub, false, 'cancelled');
});

test('captured touch before native armed acknowledgement is ignored', async () => {
  const { api, hub, node, plugin } = await makeRig();
  connect(hub, node.id, 'k1');
  hub.control.armLearn(node.id, source('k1').id);
  const pending = hub.control.pendingLearn;
  api.emitEvent({ type: 'vstParameterTouched', learnId: pending.learnId,
    chainId: node.id, instanceId: plugin.id, pluginId: plugin.pluginId, generation: 7,
    parameterId: '42', name: 'Gain', normalizedValue: 0.2, capturedByLearn: true });
  assert.deepEqual(hub.nodes.getControlBindings(node.id), []);
  assert.equal(hub.control.pendingLearn.state, 'arming');
  ackCurrent(api, hub, false, 'cancelled');
});

test('a touch from a different Learn operation cannot bind', async () => {
  const { api, hub, node, plugin } = await makeRig();
  connect(hub, node.id, 'k1');
  hub.control.armLearn(node.id, source('k1').id);
  ackCurrent(api, hub, true);
  api.emitEvent({ type: 'vstParameterTouched', learnId: 'learn-stale',
    chainId: node.id, instanceId: plugin.id, pluginId: plugin.pluginId, generation: 7,
    parameterId: '42', name: 'Gain', normalizedValue: 0.2, capturedByLearn: true });
  assert.deepEqual(hub.nodes.getControlBindings(node.id), []);
  hub.control.cancelLearn();
  ackCurrent(api, hub, false);
});

test('Hub Cancel sends exact native cancellation and ignores later touches', async () => {
  const { api, hub, node, plugin } = await makeRig();
  connect(hub, node.id, 'k1');
  hub.control.armLearn(node.id, source('k1').id);
  ackCurrent(api, hub, true);
  const pending = hub.control.pendingLearn;
  hub.control.cancelLearn(node.id, source('k1').id);
  const cancel = sentOf(api, 'setVstParameterLearn').at(-1);
  assert.equal(cancel.armed, false);
  assert.equal(cancel.learnId, pending.learnId);
  api.emitEvent({ type: 'vstParameterTouched', learnId: pending.learnId,
    chainId: node.id, instanceId: plugin.id, pluginId: plugin.pluginId, generation: 7,
    parameterId: '42', name: 'Gain', normalizedValue: 0.2, capturedByLearn: true });
  assert.deepEqual(hub.nodes.getControlBindings(node.id), []);
  ackCurrent(api, hub, false);
  assert.equal(hub.control.pendingLearn, null);
});

test('new Learn supersedes old Learn and stale terminal events cannot clear it', async () => {
  const { api, hub, node } = await makeRig();
  connect(hub, node.id, 'k1');
  connect(hub, node.id, 'k2');
  hub.control.armLearn(node.id, source('k1').id);
  ackCurrent(api, hub, true);
  const old = hub.control.pendingLearn;
  hub.control.armLearn(node.id, source('k2').id);
  const current = hub.control.pendingLearn;
  assert.notEqual(current.learnId, old.learnId);
  api.emitEvent({ type: 'vstParameterLearnState', learnId: old.learnId,
    chainId: old.nodeId, instanceId: old.pluginInstanceId, pluginId: old.pluginId,
    generation: old.generation, armed: false, reason: 'superseded' });
  assert.equal(hub.control.pendingLearn.learnId, current.learnId);
  ackCurrent(api, hub, false);
});

test('closing the target editor cancels Learn', async () => {
  const { api, hub, node, plugin } = await makeRig();
  connect(hub, node.id, 'k1');
  hub.control.armLearn(node.id, source('k1').id);
  ackCurrent(api, hub, true);
  api.emitEvent({ type: 'editorStatus', chainId: node.id, instanceId: plugin.id,
    pluginId: plugin.pluginId, generation: 7, open: false });
  assert.equal(hub.control.pendingLearn.state, 'cancelling');
  assert.equal(sentOf(api, 'setVstParameterLearn').at(-1).armed, false);
  ackCurrent(api, hub, false, 'editor-closed');
});

test('plugin loading/error transition cancels Learn', async () => {
  const { api, hub, node, plugin } = await makeRig();
  connect(hub, node.id, 'k1');
  hub.control.armLearn(node.id, source('k1').id);
  ackCurrent(api, hub, true);
  api.emitEvent({ type: 'instanceStatus', chainId: node.id, instanceId: plugin.id,
    pluginId: plugin.pluginId, generation: 7, status: 'loading' });
  assert.equal(hub.control.pendingLearn.state, 'cancelling');
  ackCurrent(api, hub, false, 'target-not-ready');
});

test('chain rebuild with a new runtime generation cancels Learn', async () => {
  const { api, hub, node, plugin } = await makeRig();
  connect(hub, node.id, 'k1');
  hub.control.armLearn(node.id, source('k1').id);
  ackCurrent(api, hub, true);
  api.emitEvent({ type: 'chainChanged', chainId: node.id, instances: [{
    instanceId: plugin.id, pluginId: plugin.pluginId, generation: 8, status: 'ready'
  }] });
  assert.equal(hub.control.pendingLearn.state, 'cancelling');
  ackCurrent(api, hub, false, 'target-rebuilt', { generation: 7 });
});

test('engine crash clears pending Learn without waiting for native IPC', async () => {
  const { api, hub, node } = await makeRig();
  connect(hub, node.id, 'k1');
  hub.control.armLearn(node.id, source('k1').id);
  ackCurrent(api, hub, true);
  api.emitState({ state: 'error', error: 'crashed' });
  assert.equal(hub.control.pendingLearn, null);
  assert.equal(hub.control.learnFeedback(node.id, source('k1').id), 'engine-error');
});

test('plugin removal invalidates its pending Learn before model destruction', async () => {
  const { api, hub, node, plugin } = await makeRig();
  connect(hub, node.id, 'k1');
  hub.control.armLearn(node.id, source('k1').id);
  ackCurrent(api, hub, true);
  assert.equal(hub.control.targetInvalidated(node.id, plugin.id, 'target-removed'), true);
  assert.equal(sentOf(api, 'setVstParameterLearn').at(-1).armed, false);
  ackCurrent(api, hub, false, 'target-removed');
});

test('zero-parameter plugin leaves acknowledged Learn cancellable and unbound', async () => {
  const { api, hub, node } = await makeRig();
  connect(hub, node.id, 'k1');
  hub.control.armLearn(node.id, source('k1').id);
  ackCurrent(api, hub, true);
  assert.equal(hub.control.pendingLearn.state, 'armed');
  assert.deepEqual(hub.nodes.getControlBindings(node.id), []);
  hub.control.cancelLearn();
  ackCurrent(api, hub, false);
});

test('stale editor generation is ignored and exact current target is reopened', async () => {
  const { api, hub, node, plugin } = await makeRig();
  connect(hub, node.id, 'k1');
  api.emitEvent({ type: 'editorStatus', chainId: node.id, instanceId: plugin.id,
    pluginId: plugin.pluginId, generation: 7, open: false });
  api.emitEvent({ type: 'editorStatus', chainId: node.id, instanceId: plugin.id,
    pluginId: plugin.pluginId, generation: 6, open: true });
  assert.equal(hub.control.armLearn(node.id, source('k1').id).ok, true);
  assert.equal(sentOf(api, 'openEditor').at(-1).generation, 7);
});

test('Learn IPC validation rejects malformed identities and types', () => {
  const valid = { v: 1, type: 'setVstParameterLearn', learnId: 'learn-a:1',
    chainId: 'vst-001', instanceId: 'plugin-1', pluginId: 'C:/VST3/Vital.vst3',
    generation: 7, armed: true };
  assert.equal(isValidSetVstParameterLearnCommand(valid), true);
  for (const mutation of [{ v: 2 }, { learnId: '../bad' }, { learnId: 'x'.repeat(161) },
    { chainId: 1 }, { chainId: '../bad' }, { instanceId: 'plugin-0' }, { pluginId: '' },
    { pluginId: 'x'.repeat(2049) }, { generation: 0 }, { generation: 1.5 }, { armed: 1 }]) {
    assert.equal(isValidSetVstParameterLearnCommand({ ...valid, ...mutation }), false);
  }
});
