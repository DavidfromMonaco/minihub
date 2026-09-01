import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from '../src/renderer/js/core/hub.js';
import { getVstParametersForNode } from '../src/renderer/js/core/vstParameterDiscovery.js';

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
    engineCommand: async (msg) => { sent.push(msg); return { ok: true }; },
    engineState: async () => ({ state: 'running', error: null }),
    onEngineEvent: (cb) => { listeners.event.push(cb); return () => {}; },
    onEngineState: (cb) => { listeners.state.push(cb); return () => {}; }
  };
}

function sentOf(api, type) {
  return api.sent.filter((m) => m.type === type);
}

/** A ready parameter record as the engine would report it. */
function param(id, name, normalizedValue, extra = {}) {
  return {
    parameterId: id,
    idStable: true,
    name,
    normalizedValue,
    automatable: true,
    readOnly: null,
    label: '',
    text: String(normalizedValue),
    index: 0,
    ...extra
  };
}

/**
 * Build a hub with a VST node holding the given plugins (each with its own
 * engine `vstParameters` response), then run `getVstParametersForNode` and
 * emit the matching engine events so its promises resolve.
 */
async function discover(api, plugins, nodeId) {
  const hub = createHub(api);
  hub.engine.init();
  const inst = hub.nodes.create('vst');
  const chain = hub.nodes.getChain(inst.id);
  for (const p of plugins) chain.append({ pluginId: p.pluginId, name: p.name, role: p.role });

  const promise = getVstParametersForNode(hub, inst.id);
  for (const p of plugins) {
    const request = sentOf(api, 'getVstParameters').find((m) => m.instanceId === p.id);
    api.emitEvent({
      type: 'vstParameters',
      requestId: request.requestId,
      chainId: inst.id,
      instanceId: p.id,
      status: p.status || 'ok',
      pluginId: p.pluginId,
      name: p.name,
      parameters: p.parameters || []
    });
  }
  const result = await promise;
  return { hub, inst, result };
}

// ---- 1: parameters are associated with the correct VST node -----------------
test('parameters are associated with the correct VST node', async () => {
  const api = mockApi();
  const { result } = await discover(api, [
    { id: 'plugin-1', pluginId: 'X', name: 'Analog Lab V', parameters: [param('1', 'Cutoff', 0.5)] }
  ]);
  assert.equal(result.vstNodeId, 'vst-001');
  assert.equal(result.status, 'ok');
  assert.equal(result.plugins.length, 1);
  assert.equal(result.plugins[0].instanceId, 'plugin-1');
  assert.equal(result.plugins[0].parameters[0].name, 'Cutoff');
});

// ---- 2: parameters remain grouped by their owning plugin ---------------------
test('parameters remain grouped by their owning plugin', async () => {
  const api = mockApi();
  const { result } = await discover(api, [
    { id: 'plugin-1', pluginId: 'X', name: 'Analog Lab V', parameters: [param('1', 'Cutoff', 0.5), param('2', 'Resonance', 0.3)] },
    { id: 'plugin-2', pluginId: 'Y', name: 'Reverb', parameters: [param('7', 'Mix', 0.4), param('8', 'Decay', 0.2)] }
  ]);
  assert.equal(result.plugins.length, 2);
  const [inst, fx] = result.plugins;
  assert.equal(inst.name, 'Analog Lab V');
  assert.deepEqual(inst.parameters.map((p) => p.name), ['Cutoff', 'Resonance']);
  assert.equal(fx.name, 'Reverb');
  assert.deepEqual(fx.parameters.map((p) => p.name), ['Mix', 'Decay']);
});

// ---- 3: stable parameter IDs are preserved ------------------------------------
test('stable parameter IDs are preserved through discovery', async () => {
  const api = mockApi();
  const { result } = await discover(api, [
    { id: 'plugin-1', pluginId: 'X', name: 'Plugin', parameters: [param('42', 'Cutoff', 0.5)] }
  ]);
  assert.equal(result.plugins[0].parameters[0].parameterId, '42');
  assert.equal(result.plugins[0].parameters[0].idStable, true);
});

// ---- 4: duplicate display names do not collapse into one parameter ----------
test('duplicate display names do not collapse into one parameter', async () => {
  const api = mockApi();
  const { result } = await discover(api, [
    { id: 'plugin-1', pluginId: 'X', name: 'Plugin', parameters: [param('1', 'Gain', 0.5), param('2', 'Gain', 0.9)] }
  ]);
  const params = result.plugins[0].parameters;
  assert.equal(params.length, 2, 'both same-name parameters survive');
  assert.equal(params[0].parameterId, '1');
  assert.equal(params[1].parameterId, '2');
});

// ---- 5: normalized values are represented correctly -------------------------
test('normalized values are represented correctly (0.0..1.0)', async () => {
  const api = mockApi();
  const { result } = await discover(api, [
    { id: 'plugin-1', pluginId: 'X', name: 'Plugin', parameters: [param('1', 'A', 0.0), param('2', 'B', 0.52), param('3', 'C', 1.0)] }
  ]);
  const vals = result.plugins[0].parameters.map((p) => p.normalizedValue);
  assert.deepEqual(vals, [0.0, 0.52, 1.0]);
});

// ---- 6: zero-parameter plugins are safe --------------------------------------
test('zero-parameter plugins are safe', async () => {
  const api = mockApi();
  const { result } = await discover(api, [
    { id: 'plugin-1', pluginId: 'X', name: 'NoParams', parameters: [] }
  ]);
  assert.equal(result.plugins.length, 1);
  assert.equal(result.plugins[0].status, 'ok');
  assert.deepEqual(result.plugins[0].parameters, []);
});

// ---- 7: unavailable / PENDING plugin runtime is handled safely --------------
test('unavailable / PENDING plugin runtime is handled safely', async () => {
  const api = mockApi();
  const { result } = await discover(api, [
    { id: 'plugin-1', pluginId: 'X', name: 'Loading', status: 'instance-not-found', parameters: [] },
    { id: 'plugin-2', pluginId: 'Y', name: 'NotReady', status: 'not-ready', parameters: [] },
    { id: 'plugin-3', pluginId: 'Z', name: 'Ready', status: 'ok', parameters: [param('1', 'Cutoff', 0.5)] }
  ]);
  assert.equal(result.plugins[0].status, 'instance-not-found');
  assert.deepEqual(result.plugins[0].parameters, []);
  assert.equal(result.plugins[1].status, 'not-ready');
  assert.deepEqual(result.plugins[1].parameters, []);
  assert.equal(result.plugins[2].status, 'ok');
  assert.equal(result.plugins[2].parameters.length, 1);
});

// ---- 8: deleted plugins/nodes cannot return stale parameter data ------------
test('deleted VST node cannot return stale parameter data', async () => {
  const api = mockApi();
  const hub = createHub(api);
  hub.engine.init();
  const inst = hub.nodes.create('vst');
  const chain = hub.nodes.getChain(inst.id);
  chain.append({ pluginId: 'X', name: 'Plugin', role: 'audio-effect' });

  hub.nodes.delete(inst.id);
  const result = await getVstParametersForNode(hub, inst.id);
  assert.equal(result.status, 'node-not-found');
  assert.deepEqual(result.plugins, []);
});

test('a plugin removed from the chain is no longer requested (no stale data)', async () => {
  const api = mockApi();
  const hub = createHub(api);
  hub.engine.init();
  const inst = hub.nodes.create('vst');
  const chain = hub.nodes.getChain(inst.id);
  chain.append({ pluginId: 'X', name: 'A', role: 'audio-effect' });
  chain.append({ pluginId: 'Y', name: 'B', role: 'audio-effect' });
  chain.remove('plugin-1');

  const promise = getVstParametersForNode(hub, inst.id);
  const request = sentOf(api, 'getVstParameters').find((m) => m.instanceId === 'plugin-2');
  api.emitEvent({ type: 'vstParameters', requestId: request.requestId, chainId: inst.id, instanceId: 'plugin-2', status: 'ok', pluginId: 'Y', name: 'B', parameters: [param('1', 'Mix', 0.5)] });
  const result = await promise;
  assert.equal(result.plugins.length, 1, 'removed plugin is not queried');
  assert.equal(result.plugins[0].instanceId, 'plugin-2');
  assert.equal(sentOf(api, 'getVstParameters').some((m) => m.instanceId === 'plugin-1'), false);
});

test('a plugin removed while discovery is in flight cannot return stale data', async () => {
  const api = mockApi();
  const hub = createHub(api);
  await hub.engine.init();
  const inst = hub.nodes.create('vst');
  const chain = hub.nodes.getChain(inst.id);
  chain.append({ pluginId: 'X', name: 'A', role: 'audio-effect' });

  const promise = getVstParametersForNode(hub, inst.id);
  const request = sentOf(api, 'getVstParameters')[0];
  chain.remove('plugin-1');
  api.emitEvent({ type: 'vstParameters', requestId: request.requestId, chainId: inst.id, instanceId: 'plugin-1', pluginId: 'X', status: 'ok', parameters: [param('1', 'Stale', 0.5)] });

  const result = await promise;
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.plugins, []);
});

test('a node deleted while discovery is in flight settles as node-not-found', async () => {
  const api = mockApi();
  const hub = createHub(api);
  await hub.engine.init();
  const inst = hub.nodes.create('vst');
  hub.nodes.getChain(inst.id).append({ pluginId: 'X', name: 'A', role: 'audio-effect' });

  const promise = getVstParametersForNode(hub, inst.id);
  const request = sentOf(api, 'getVstParameters')[0];
  hub.nodes.delete(inst.id);
  api.emitEvent({ type: 'vstParameters', requestId: request.requestId, chainId: inst.id, instanceId: 'plugin-1', pluginId: 'X', status: 'ok', parameters: [param('1', 'Stale', 0.5)] });

  const result = await promise;
  assert.equal(result.status, 'node-not-found');
  assert.deepEqual(result.plugins, []);
});

test('a response from a replaced native plugin is marked stale', async () => {
  const api = mockApi();
  const hub = createHub(api);
  await hub.engine.init();
  const inst = hub.nodes.create('vst');
  hub.nodes.getChain(inst.id).append({ pluginId: 'X', name: 'A', role: 'audio-effect' });

  const promise = getVstParametersForNode(hub, inst.id);
  const request = sentOf(api, 'getVstParameters')[0];
  api.emitEvent({ type: 'vstParameters', requestId: request.requestId, chainId: inst.id, instanceId: 'plugin-1', pluginId: 'REPLACED', status: 'ok', parameters: [param('1', 'Wrong object', 0.5)] });

  const result = await promise;
  assert.equal(result.plugins[0].status, 'stale-instance');
  assert.deepEqual(result.plugins[0].parameters, []);
});

// ---- 9: reorder does not silently change parameter identity -----------------
test('plugin reorder does not change parameter identity', async () => {
  const api = mockApi();
  const hub = createHub(api);
  hub.engine.init();
  const inst = hub.nodes.create('vst');
  const chain = hub.nodes.getChain(inst.id);
  chain.append({ pluginId: 'X', name: 'A', role: 'audio-effect' });
  chain.append({ pluginId: 'Y', name: 'B', role: 'audio-effect' });
  chain.append({ pluginId: 'Z', name: 'C', role: 'audio-effect' });
  // Move plugin-1 (A) to the end.
  chain.reorder('plugin-1', 2);

  const promise = getVstParametersForNode(hub, inst.id);
  for (const [id, name, pid] of [['plugin-1', 'A', 'X'], ['plugin-2', 'B', 'Y'], ['plugin-3', 'C', 'Z']]) {
    const request = sentOf(api, 'getVstParameters').find((m) => m.instanceId === id);
    api.emitEvent({ type: 'vstParameters', requestId: request.requestId, chainId: inst.id, instanceId: id, status: 'ok', pluginId: pid, name, parameters: [param('1', 'P', 0.5)] });
  }
  const result = await promise;
  // Order reflects the reordered chain, but identity follows the plugin id.
  assert.deepEqual(result.plugins.map((p) => p.instanceId), ['plugin-2', 'plugin-3', 'plugin-1']);
  const a = result.plugins.find((p) => p.instanceId === 'plugin-1');
  assert.equal(a.name, 'A');
  assert.equal(a.parameters[0].parameterId, '1', 'parameter identity unchanged after reorder');
});

// ---- 10: malformed / unsupported requests are handled without crashing ------
test('request for an unknown instance returns a controlled status', async () => {
  const api = mockApi();
  const hub = createHub(api);
  hub.engine.init();
  const inst = hub.nodes.create('vst');
  const chain = hub.nodes.getChain(inst.id);
  chain.append({ pluginId: 'X', name: 'A', role: 'audio-effect' });

  const promise = getVstParametersForNode(hub, inst.id);
  // Engine reports the instance is unknown to it (e.g. not yet created).
  const request = sentOf(api, 'getVstParameters')[0];
  api.emitEvent({ type: 'vstParameters', requestId: request.requestId, chainId: inst.id, instanceId: 'plugin-1', status: 'instance-not-found', message: 'Unknown instance: plugin-1', parameters: [] });
  const result = await promise;
  assert.equal(result.status, 'ok'); // node-level discovery still succeeds
  assert.equal(result.plugins[0].status, 'instance-not-found');
  assert.deepEqual(result.plugins[0].parameters, []);
});

test('getVstParameters command is serialized with the versioned protocol', async () => {
  const api = mockApi();
  const hub = createHub(api);
  hub.engine.init();
  const p = hub.engine.getVstParameters('vst-001', 'plugin-2');
  const request = sentOf(api, 'getVstParameters')[0];
  api.emitEvent({ type: 'vstParameters', requestId: request.requestId, chainId: 'vst-001', instanceId: 'plugin-2', status: 'ok', parameters: [param('1', 'Cutoff', 0.5)] });
  const res = await p;
  assert.deepEqual(sentOf(api, 'getVstParameters')[0], { v: 1, type: 'getVstParameters', requestId: request.requestId, chainId: 'vst-001', instanceId: 'plugin-2' });
  assert.equal(res.status, 'ok');
  assert.equal(res.parameters.length, 1);
});

test('a request against a non-VST node is refused', async () => {
  const api = mockApi();
  const hub = createHub(api);
  hub.engine.init();
  hub.nodes.create('video');
  const result = await getVstParametersForNode(hub, 'video-001');
  assert.equal(result.status, 'node-not-found');
  assert.deepEqual(result.plugins, []);
});

test('engine-not-started resolves with a controlled status, never hangs', async () => {
  const api = mockApi();
  // Main process rejects the command when the engine is down.
  api.engineCommand = async (msg) => { api.sent.push(msg); return { ok: false, reason: 'engine-not-started' }; };
  const hub = createHub(api);
  hub.engine.init();
  const inst = hub.nodes.create('vst');
  const chain = hub.nodes.getChain(inst.id);
  chain.append({ pluginId: 'X', name: 'A', role: 'audio-effect' });

  const result = await getVstParametersForNode(hub, inst.id);
  assert.equal(result.status, 'ok');
  assert.equal(result.plugins.length, 1);
  assert.equal(result.plugins[0].status, 'error');
  assert.deepEqual(result.plugins[0].parameters, []);
});

test('simultaneous requests for the same plugin correlate independently', async () => {
  const api = mockApi();
  const hub = createHub(api);
  await hub.engine.init();
  const first = hub.engine.getVstParameters('vst-001', 'plugin-1');
  const second = hub.engine.getVstParameters('vst-001', 'plugin-1');
  const [a, b] = sentOf(api, 'getVstParameters');
  assert.notEqual(a.requestId, b.requestId);

  // Deliberately answer the second request first.
  api.emitEvent({ type: 'vstParameters', requestId: b.requestId, chainId: b.chainId, instanceId: b.instanceId, status: 'ok', parameters: [param('2', 'Second', 0.2)] });
  api.emitEvent({ type: 'vstParameters', requestId: a.requestId, chainId: a.chainId, instanceId: a.instanceId, status: 'ok', parameters: [param('1', 'First', 0.1)] });
  assert.equal((await first).parameters[0].name, 'First');
  assert.equal((await second).parameters[0].name, 'Second');
});

test('same-chain different-plugin responses may arrive out of order', async () => {
  const api = mockApi();
  const hub = createHub(api);
  await hub.engine.init();
  const one = hub.engine.getVstParameters('vst-001', 'plugin-1');
  const two = hub.engine.getVstParameters('vst-001', 'plugin-2');
  const [a, b] = sentOf(api, 'getVstParameters');
  api.emitEvent({ type: 'vstParameters', requestId: b.requestId, chainId: b.chainId, instanceId: b.instanceId, status: 'ok', parameters: [param('2', 'B', 0.2)] });
  api.emitEvent({ type: 'vstParameters', requestId: a.requestId, chainId: a.chainId, instanceId: a.instanceId, status: 'ok', parameters: [param('1', 'A', 0.1)] });
  assert.equal((await one).parameters[0].name, 'A');
  assert.equal((await two).parameters[0].name, 'B');
});

test('engine crash settles pending parameter requests and stale responses stay stale', async () => {
  const api = mockApi();
  const hub = createHub(api);
  await hub.engine.init();
  const old = hub.engine.getVstParameters('vst-001', 'plugin-1');
  const oldRequest = sentOf(api, 'getVstParameters')[0];
  api.emitState({ state: 'error', error: 'crashed' });
  await assert.rejects(old, /engine-error/);

  api.emitState({ state: 'running', error: null });
  const current = hub.engine.getVstParameters('vst-001', 'plugin-1');
  const currentRequest = sentOf(api, 'getVstParameters').at(-1);
  api.emitEvent({ type: 'vstParameters', requestId: oldRequest.requestId, chainId: oldRequest.chainId, instanceId: oldRequest.instanceId, status: 'ok', parameters: [param('9', 'Stale', 0.9)] });
  api.emitEvent({ type: 'vstParameters', requestId: currentRequest.requestId, chainId: currentRequest.chainId, instanceId: currentRequest.instanceId, status: 'ok', parameters: [param('1', 'Current', 0.1)] });
  assert.equal((await current).parameters[0].name, 'Current');
});

test('client dispose settles pending parameter requests', async () => {
  const api = mockApi();
  const hub = createHub(api);
  await hub.engine.init();
  const pending = hub.engine.getVstParameters('vst-001', 'plugin-1');
  hub.engine.dispose();
  await assert.rejects(pending, /client-disposed/);
});

test('rejected engineCommand cleans up the pending request', async () => {
  const api = mockApi();
  api.engineCommand = async (msg) => {
    api.sent.push(msg);
    if (msg.type === 'getVstParameters') throw new Error('IPC rejected');
    return { ok: true };
  };
  const hub = createHub(api);
  await hub.engine.init();
  await assert.rejects(hub.engine.getVstParameters('vst-001', 'plugin-1'), /IPC rejected/);
  assert.equal(hub.engine._pendingParams.size, 0);
});

test('a timed out request rejects and releases its correlation entry', async () => {
  const api = mockApi();
  api.parameterRequestTimeoutMs = 5;
  const hub = createHub(api);
  await hub.engine.init();

  await assert.rejects(hub.engine.getVstParameters('vst-001', 'plugin-1'), /timed out/);
  assert.equal(hub.engine._pendingParams.size, 0);
});

test('last-touched events preserve ParamID and ignore replaced generations', async () => {
  const api = mockApi();
  const hub = createHub(api);
  await hub.engine.init();
  const seen = [];
  hub.events.on('engine:vstParameterTouched', (msg) => seen.push(msg));

  api.emitEvent({ type: 'instanceStatus', chainId: 'vst-001', instanceId: 'plugin-1', pluginId: 'X', generation: 8, status: 'ready' });
  api.emitEvent({ type: 'vstParameterTouched', chainId: 'vst-001', instanceId: 'plugin-1', pluginId: 'X', generation: 7, parameterId: '100', name: 'Gain', normalizedValue: 0.1, gestureAware: true });
  api.emitEvent({ type: 'vstParameterTouched', chainId: 'vst-001', instanceId: 'plugin-1', pluginId: 'X', generation: 8, parameterId: '100', name: 'Gain', normalizedValue: 0.2, gestureAware: true });
  api.emitEvent({ type: 'vstParameterTouched', chainId: 'vst-001', instanceId: 'plugin-1', pluginId: 'X', generation: 8, parameterId: '101', name: 'Gain', normalizedValue: 0.3, gestureAware: true });

  assert.deepEqual(seen.map((msg) => msg.parameterId), ['100', '101']);
  assert.deepEqual(seen.map((msg) => msg.normalizedValue), [0.2, 0.3]);
});

test('last-touched event for an instance absent from current chain state is ignored', async () => {
  const api = mockApi();
  const hub = createHub(api);
  await hub.engine.init();
  const seen = [];
  hub.events.on('engine:vstParameterTouched', (msg) => seen.push(msg));

  api.emitEvent({ type: 'chainChanged', chainId: 'vst-001', instances: [] });
  api.emitEvent({ type: 'vstParameterTouched', chainId: 'vst-001', instanceId: 'plugin-1', pluginId: 'X', generation: 3, parameterId: '100', name: 'Gain', normalizedValue: 0.5, gestureAware: true });
  assert.deepEqual(seen, []);
});
