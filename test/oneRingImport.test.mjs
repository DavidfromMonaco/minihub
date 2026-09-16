import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from '../src/renderer/js/core/hub.js';
import { copyOneRingToNode, isOneRingPlugin } from '../src/renderer/js/core/oneRingImport.js';
import { createSequence, fromVstState, toVstState } from '../src/renderer/js/core/oneRingSequence.js';
import { oneRingComponent, vst3StateString } from './juceFixture.mjs';

/**
 * Contract: a One Ring VST's sequence moves into a One Ring node as it was --
 * the live one when the plugin runs -- and the VST node's CTRL OUT cables move
 * with it. The rig is the real hub; the engine is played by `api`.
 */

const ONE_RING = 'C:\\Program Files\\Common Files\\VST3\\ONE RING.vst3';
const settle = () => new Promise((resolve) => setImmediate(resolve));

function mockApi() {
  const data = {};
  const sent = [];
  const listeners = { event: [], state: [] };
  return {
    data,
    sent,
    emitEvent(msg) { listeners.event.forEach((cb) => cb(msg)); },
    loadSettings: async () => ({ ...data }),
    saveSettings: async (settings) => { Object.assign(data, settings); return true; },
    engineCommand: async (msg) => { sent.push(msg); return { ok: true }; },
    engineState: async () => ({ state: 'running', error: null }),
    onEngineEvent: (cb) => { listeners.event.push(cb); return () => {}; },
    onEngineState: (cb) => { listeners.state.push(cb); return () => {}; }
  };
}

function vstSequence(seed) {
  const state = toVstState(createSequence());
  state.seed = String(seed);
  const channel = state.scenes[0].channels[0];
  channel.target = { target: 'placeholder', command: 'MASTER', value: channel.target.value };
  channel.steps[2] = { ...channel.steps[2], enabled: true, probability: 70 };
  return state;
}

async function rig() {
  const api = mockApi();
  const hub = createHub(api);
  await hub.engine.init();
  hub.project._loading = false;
  const vst = hub.nodes.create('vst');
  const mixer = hub.nodes.create('mixer');
  const plugin = hub.nodes.getChain(vst.id).append({ pluginId: ONE_RING, name: 'ONE RING', role: 'audio-effect' });
  const saved = vstSequence(11);
  saved.scenes[0].channels[0].target.target = mixer.id;
  hub.nodes.setPluginState(vst.id, plugin.id, ONE_RING, vst3StateString(oneRingComponent(saved)));
  hub.network.connect(vst.id, 'ctrl-out', mixer.id, 'ctrl-in');
  await settle();
  return { api, hub, vst, mixer, plugin, saved };
}

test('the One Ring VST is known by its bundle or its name, and nothing else is', () => {
  assert.equal(isOneRingPlugin({ pluginId: ONE_RING }), true);
  assert.equal(isOneRingPlugin({ pluginId: 'D:/Plugins/one ring.vst3/Contents/x64-win/ONE RING.vst3', name: 'x' }), true);
  assert.equal(isOneRingPlugin({ pluginId: 'C:/VST3/Dexed.vst3', name: 'ONE RING' }), true);
  assert.equal(isOneRingPlugin({ pluginId: 'C:/VST3/ONE RINGER.vst3', name: 'One Ringer' }), false);
  assert.equal(isOneRingPlugin(null), false);
});

test('its saved sequence becomes a One Ring node, and its CTRL OUT cables move there', async () => {
  const { hub, vst, mixer, plugin, saved } = await rig();
  const result = await copyOneRingToNode(hub, vst.id, plugin.id);
  assert.equal(result.ok, true);
  assert.equal(result.moved, 1);
  const node = hub.nodes.get(result.nodeId);
  assert.equal(node.type, 'one-ring');
  assert.deepEqual(node.content, fromVstState(saved));
  assert.deepEqual(hub.network.connectionsFrom(vst.id, 'ctrl-out'), []);
  assert.deepEqual(hub.network.connectionsFrom(node.id, 'ctrl-out').map((cable) => [cable.to.nodeId, cable.to.portId]),
    [[mixer.id, 'ctrl-in']]);
  assert.equal(hub.nodes.get(vst.id).content.plugins.length, 1, 'the VST stays where it was');
});

test('a running plugin gives its live sequence, not the one last saved', async () => {
  const { api, hub, vst, plugin } = await rig();
  const generation = 4;
  api.emitEvent({
    type: 'chainChanged', chainId: vst.id,
    instances: [{ instanceId: plugin.id, pluginId: ONE_RING, name: 'ONE RING', role: 'audio-effect', bypassed: false, generation, status: 'ready' }]
  });
  api.emitEvent({ type: 'instanceStatus', chainId: vst.id, instanceId: plugin.id, pluginId: ONE_RING, generation, status: 'ready' });
  const pending = copyOneRingToNode(hub, vst.id, plugin.id);
  await settle();
  const asked = api.sent.filter((msg) => msg.type === 'getState');
  assert.deepEqual(asked.map((msg) => [msg.chainId, msg.instanceId]), [[vst.id, plugin.id]]);
  const live = vstSequence(99);
  api.emitEvent({
    type: 'pluginState', chainId: vst.id, instanceId: plugin.id, pluginId: ONE_RING, generation,
    state: vst3StateString(oneRingComponent(live))
  });
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(hub.nodes.get(result.nodeId).content.seed, '99');
});

test('what it refuses: another plugin, no state, a state that is not a sequence', async () => {
  const { hub, vst, plugin } = await rig();
  const dexed = hub.nodes.getChain(vst.id).append({ pluginId: 'C:/VST3/Dexed.vst3', name: 'Dexed', role: 'instrument' });
  assert.deepEqual(await copyOneRingToNode(hub, vst.id, dexed.id), { ok: false, reason: 'not-one-ring' });
  assert.deepEqual(await copyOneRingToNode(hub, 'vst-999', plugin.id), { ok: false, reason: 'not-one-ring' });

  hub.nodes.get(vst.id).content.plugins.find((item) => item.id === plugin.id).state = undefined;
  assert.equal((await copyOneRingToNode(hub, vst.id, plugin.id)).reason, 'no-state');

  hub.nodes.setPluginState(vst.id, plugin.id, ONE_RING, vst3StateString(new TextEncoder().encode('{"nothing":true}')));
  const unreadable = await copyOneRingToNode(hub, vst.id, plugin.id);
  assert.equal(unreadable.reason, 'unreadable');
  assert.match(unreadable.message, /not a One Ring state/);
  assert.equal(hub.nodes.list().filter((node) => node.type === 'one-ring').length, 0, 'nothing is created when nothing is read');
});
