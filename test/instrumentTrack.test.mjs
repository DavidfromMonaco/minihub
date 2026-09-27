import './installNodeEditors.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from '../src/renderer/js/core/hub.js';
import { createAudioOutputModule } from '../src/renderer/js/modules/audioOutput/audioOutputModule.js';
import { defaultSequencerState } from '../src/renderer/js/core/sequencerModel.js';
import {
  audioHomeFor, createInstrumentTrack, instrumentPlugins, openPluginWhenReady, trackPlugin
} from '../src/renderer/js/core/instrumentTrack.js';

const ANALOG = 'C:/Program Files/Common Files/VST3/Analog Lab V.vst3';
const PIANO = 'C:/Program Files/Common Files/VST3/Infinite Space Piano 2.vst3';
const REVERB = 'C:/Program Files/Common Files/VST3/ValhallaRoom.vst3';

function mockApi() {
  const data = { sequencerState: defaultSequencerState() };
  const sent = [];
  const listeners = { event: [], state: [] };
  return {
    data,
    sent,
    emitEvent(msg) { listeners.event.forEach((cb) => cb(msg)); },
    loadSettings: async () => ({ ...data }),
    saveSettings: async (s) => { Object.assign(data, s); return true; },
    diagnosticsLog: () => true,
    engineCommand: async (msg) => { sent.push(msg); return { ok: true }; },
    engineState: async () => ({ state: 'running', error: null }),
    onEngineEvent: (cb) => { listeners.event.push(cb); return () => {}; },
    onEngineState: (cb) => { listeners.state.push(cb); return () => {}; }
  };
}

async function studio() {
  const api = mockApi();
  const hub = createHub(api);
  await hub.settings.load();
  hub.modules.register(createAudioOutputModule(hub));
  hub.nodes.create('sequencer');
  hub.sequencer.load();
  hub.engine.init();
  api.emitEvent({ type: 'plugins', plugins: [
    { pluginId: PIANO, name: 'Infinite Space Piano 2', manufacturer: 'Spitfire', role: 'instrument' },
    { pluginId: REVERB, name: 'ValhallaRoom', manufacturer: 'Valhalla DSP', role: 'audio-effect' },
    { pluginId: ANALOG, name: 'Analog Lab V', manufacturer: 'Arturia', role: 'instrument' }
  ] });
  return { api, hub };
}

const sentOf = (api, type) => api.sent.filter((m) => m.type === type);

test('the instruments a track can play: instruments only, by name', async () => {
  const { hub } = await studio();
  assert.deepEqual(instrumentPlugins(hub).map((plugin) => plugin.name), ['Analog Lab V', 'Infinite Space Piano 2']);
});

test('a track with its instrument is one gesture: node, plugin, cables, track, as a hand would make them', async () => {
  const { api, hub } = await studio();
  const made = createInstrumentTrack(hub, ANALOG);

  const node = hub.nodes.get(made.nodeId);
  assert.equal(node.type, 'vst');
  assert.deepEqual(node.content.plugins.map((plugin) => plugin.name), ['Analog Lab V']);
  assert.equal(sentOf(api, 'createInstance').at(-1).chainId, made.nodeId, 'the engine is asked for the plugin');
  assert.equal(made.track.name, 'Analog Lab V', 'the track is named after what it plays');
  assert.equal(made.track.outputId, made.nodeId);
  const cables = hub.network.connections().map((c) => `${c.from.nodeId}:${c.from.portId}>${c.to.nodeId}:${c.to.portId}`);
  assert.ok(cables.includes(`sequencer:midi-out>${made.nodeId}:midi-in`), 'the Sequencer plays it, by a cable');
  assert.ok(cables.includes(`${made.nodeId}:audio-out>audio-output:audio-in`), 'and it is heard, by a cable');
  assert.deepEqual(trackPlugin(hub, made.track), { nodeId: made.nodeId, pluginInstanceId: made.pluginInstanceId });
});

test("the next instrument joins the Mixer the last one plays into, on a free strip", async () => {
  const { hub } = await studio();
  const first = createInstrumentTrack(hub, ANALOG);
  // The author's patch: the synth into a Mixer, the Mixer into the output.
  const mixer = hub.nodes.create('mixer');
  hub.network.disconnect(first.nodeId, 'audio-out', 'audio-output', 'audio-in');
  hub.network.connect(first.nodeId, 'audio-out', mixer.id, 'audio-in-1');
  hub.network.connect(mixer.id, 'audio-out', 'audio-output', 'audio-in');

  assert.deepEqual(audioHomeFor(hub, first.nodeId), { nodeId: mixer.id, portId: 'audio-in-2' });
  const second = createInstrumentTrack(hub, PIANO);
  const into = hub.network.connectionsFrom(second.nodeId, 'audio-out').map((c) => `${c.to.nodeId}:${c.to.portId}`);
  assert.deepEqual(into, [`${mixer.id}:audio-in-2`]);
  assert.equal(hub.sequencer.model.state.tracks.length, 2);
});

test('a plugin still loading opens its window once it is ready, and only then', async () => {
  const { api, hub } = await studio();
  const made = createInstrumentTrack(hub, ANALOG);
  api.sent.length = 0;
  openPluginWhenReady(hub, made.nodeId, made.pluginInstanceId);
  assert.equal(sentOf(api, 'openEditor').length, 0, 'not while it loads');
  api.emitEvent({ type: 'instanceStatus', chainId: made.nodeId, instanceId: made.pluginInstanceId, pluginId: ANALOG, generation: 1, status: 'ready' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sentOf(api, 'openEditor').length, 1);
  api.emitEvent({ type: 'instanceStatus', chainId: made.nodeId, instanceId: made.pluginInstanceId, pluginId: ANALOG, generation: 2, status: 'ready' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sentOf(api, 'openEditor').length, 1, 'once: a later reload of the plugin does not pop it up again');
});

test('a track that plays no plugin has no plugin window to offer', async () => {
  const { hub } = await studio();
  const track = hub.sequencer.addTrack('midi');
  assert.equal(trackPlugin(hub, track), null);
  assert.equal(createInstrumentTrack(hub, 'C:/nowhere.vst3'), null, 'an unknown plugin makes nothing');
});
