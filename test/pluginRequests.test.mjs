import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from '../src/renderer/js/core/hub.js';
import { handleAgentRequest } from '../src/renderer/js/core/agentRequests.js';
import { describeNodes } from '../src/renderer/js/core/agentDescribe.js';

/**
 * Contract: an agent reaches what a plugin keeps in its own state -- One Ring's
 * channels, steps and scenes -- by handing it a request in the plugin's own
 * vocabulary, through the one plugin it names, and reads the plugin's answer
 * unchanged.
 *
 * The rig is the real hub with the engine played by `api`: a chain report says
 * which plugins take requests, and a `pluginRequestResult` answers each one,
 * exactly as the native engine does.
 */

const ONE_RING = 'C:\\VST3\\ONE RING.vst3';
const DEXED = 'C:\\VST3\\Dexed.vst3';
const settle = () => new Promise((resolve) => setImmediate(resolve));

function mockApi() {
  const sent = [];
  const listeners = { event: [], state: [] };
  return {
    sent,
    emitEvent(msg) { listeners.event.forEach((cb) => cb(msg)); },
    loadSettings: async () => ({}),
    saveSettings: async () => true,
    engineCommand: async (msg) => { sent.push(msg); return { ok: true }; },
    engineState: async () => ({ state: 'running', error: null }),
    onEngineEvent: (cb) => { listeners.event.push(cb); return () => {}; },
    onEngineState: (cb) => { listeners.state.push(cb); return () => {}; },
    parameterRequestTimeoutMs: 50
  };
}

async function rig() {
  const api = mockApi();
  const hub = createHub(api);
  await hub.engine.init();
  hub.project._loading = false;
  const node = hub.nodes.create('vst');
  const ring = hub.nodes.getChain(node.id).append({ pluginId: ONE_RING, name: 'ONE RING', role: 'audio-effect' });
  const dexed = hub.nodes.getChain(node.id).append({ pluginId: DEXED, name: 'Dexed', role: 'instrument' });
  api.emitEvent({ type: 'chainChanged', chainId: node.id, instances: [
    { instanceId: ring.id, pluginId: ONE_RING, generation: 3, status: 'ready', controlSource: true, requests: true },
    { instanceId: dexed.id, pluginId: DEXED, generation: 4, status: 'ready' }
  ] });
  await settle();
  const ask = (request) => handleAgentRequest(hub, { expectedProjectId: hub.project.projectId, ...request });
  /** Ask, then answer as the engine would, and hand back what the agent reads. */
  async function askAnswered(request, result) {
    const pending = ask(request);
    await settle();
    const command = api.sent.findLast((msg) => msg.type === 'pluginRequest');
    if (command && result) {
      api.emitEvent({ type: 'pluginRequestResult', requestId: command.requestId,
        chainId: command.chainId, instanceId: command.instanceId, ...result });
    }
    return { answer: await pending, command };
  }
  return { api, hub, node, ring, dexed, ask, askAnswered };
}

test("the plugin's answer reaches the agent unchanged, addressed to the instance it looked at", async () => {
  const { hub, node, ring, askAnswered } = await rig();
  const { answer, command } = await askAnswered(
    { kind: 'plugin', nodeId: node.id, pluginInstanceId: ring.id, request: { kind: 'get', channel: 2 } },
    { status: 'ok', reply: { ok: true, seed: '77', channels: [{ channel: 2, steps: [] }] } }
  );
  assert.deepEqual(answer, { ok: true, seed: '77', channels: [{ channel: 2, steps: [] }] });
  assert.deepEqual(command.request, { kind: 'get', channel: 2 }, 'handed through whole');
  assert.equal(command.pluginId, ONE_RING);
  assert.equal(command.generation, 3, 'the generation the chain report gave: a reloaded plugin answers stale');
  assert.equal(hub.engine.acceptsRequests(node.id, ring.id), true);
});

test("a plugin's own refusal is an answer, not a failure of the channel", async () => {
  const { node, ring, askAnswered } = await rig();
  const { answer } = await askAnswered(
    { kind: 'plugin', nodeId: node.id, pluginInstanceId: ring.id, request: { kind: 'set', channels: [{ channel: 17 }] } },
    { status: 'ok', reply: { ok: false, reason: 'invalid-value', message: 'channels[0].channel: a channel from 1 to 16' } }
  );
  assert.deepEqual(answer, { ok: false, reason: 'invalid-value', message: 'channels[0].channel: a channel from 1 to 16' });
});

test('who is asked is checked before anything is sent', async () => {
  const { api, hub, node, ring, dexed, ask } = await rig();
  const before = api.sent.length;
  assert.deepEqual(await ask({ kind: 'plugin', nodeId: node.id, pluginInstanceId: 'plugin-99', request: { kind: 'get' } }),
    { ok: false, reason: 'plugin-not-found' });
  assert.equal((await ask({ kind: 'plugin', nodeId: node.id, pluginInstanceId: dexed.id, request: { kind: 'get' } })).reason,
    'requests-not-supported', 'a plugin with parameters only says so, and points at them');
  assert.equal((await ask({ kind: 'plugin', nodeId: node.id, pluginInstanceId: ring.id, request: 'get' })).reason,
    'invalid-request');
  assert.equal((await ask({ kind: 'plugin', nodeId: node.id, pluginInstanceId: ring.id, request: [] })).reason,
    'invalid-request');
  assert.deepEqual(await handleAgentRequest(hub, { kind: 'plugin', nodeId: node.id, pluginInstanceId: ring.id,
    request: { kind: 'set' }, expectedProjectId: 'another-project' }), { ok: false, reason: 'stale-project' },
    'a request that can reprogram a plugin is gated like any edit');
  api.emitEvent({ type: 'chainChanged', chainId: node.id, instances: [
    { instanceId: ring.id, pluginId: ONE_RING, generation: 3, status: 'error', requests: true }
  ] });
  assert.equal((await ask({ kind: 'plugin', nodeId: node.id, pluginInstanceId: ring.id, request: { kind: 'get' } })).reason,
    'plugin-failed');
  assert.equal(api.sent.slice(before).some((msg) => msg.type === 'pluginRequest'), false);
});

test("the engine's refusals and silence arrive as reasons", async () => {
  const { node, ring, askAnswered } = await rig();
  const stale = await askAnswered(
    { kind: 'plugin', nodeId: node.id, pluginInstanceId: ring.id, request: { kind: 'status' } },
    { status: 'stale-instance' }
  );
  assert.deepEqual(stale.answer, { ok: false, reason: 'stale-instance' });
  const silent = await askAnswered({ kind: 'plugin', nodeId: node.id, pluginInstanceId: ring.id, request: { kind: 'status' } }, null);
  assert.deepEqual(silent.answer, { ok: false, reason: 'timeout' });
});

test('describe says which plugins take requests', async () => {
  const { hub, node, ring, dexed } = await rig();
  const described = describeNodes(hub).find((entry) => entry.id === node.id);
  const plugins = described.content.plugins;
  assert.equal(plugins.find((plugin) => plugin.id === ring.id).requests, true);
  assert.equal('requests' in plugins.find((plugin) => plugin.id === dexed.id), false);
});
