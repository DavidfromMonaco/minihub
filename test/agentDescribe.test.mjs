import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFullHub } from './helpers.mjs';
import {
  describeAudio, describeCables, describeCatalogue, describeNodes, describeSequencer, describeSetup, describeWindows
} from '../src/renderer/js/core/agentDescribe.js';

/**
 * Contract: what an outside agent is told about the setup.
 *
 * The bounds are INTENT §8 sexies. What these tests hold is the part that fails
 * silently: a description that is stale, or too big to read, does not throw —
 * it makes the reader build on something that is not there.
 */

function rig(settings = {}) {
  return makeFullHub({
    nodeInstances: { instances: [], idSeq: {} },
    networkConnections: [],
    networkLayout: {},
    sequencerState: null,
    transportBpm: 120,
    ...settings
  });
}

// ---- the ports are the live ones, not the ones the type declares ----------------

test('a Mixer input grown by a cable appears in the description', () => {
  const hub = rig();
  const vst = hub.nodes.create('vst');
  const mixer = hub.nodes.create('mixer');

  const born = describeNodes(hub).find((node) => node.id === mixer.id);
  assert.deepEqual(born.ports.inputs.map((port) => port.id), ['audio-in-1'],
    'a Mixer is born with one input');

  // Taking the last free input is what makes the node grow another one.
  hub.network.connect(vst.id, 'audio-out', mixer.id, 'audio-in-1');

  const grown = describeNodes(hub).find((node) => node.id === mixer.id);
  assert.deepEqual(grown.ports.inputs.map((port) => port.id), ['audio-in-1', 'audio-in-2'],
    'the description follows the network, not the type registry');
});

test('the network is the list: a node removed from it stops being described', () => {
  const hub = rig();
  const vst = hub.nodes.create('vst');
  assert.ok(describeNodes(hub).some((node) => node.id === vst.id));

  hub.network.removeNode(vst.id);
  assert.equal(describeNodes(hub).some((node) => node.id === vst.id), false,
    'what the network does not route is not part of the setup');
});

test('a routing node with no instance behind it is described, and marked system', () => {
  const hub = rig();
  // What `audio-output` and the controller are: registered into the network by
  // their own module, with no entry in `NodeInstanceManager`. A description
  // that skipped them would be a description with nothing to plug into.
  hub.network.addNode({
    id: 'audio-output', name: 'Audio Output', type: 'audio-output',
    inputs: [{ id: 'audio-in', type: 'audio', label: 'AUDIO IN' }], outputs: []
  });

  const described = describeNodes(hub).find((node) => node.id === 'audio-output');
  assert.equal(described.system, true);
  assert.equal(described.name, 'Audio Output');
  assert.deepEqual(described.ports.inputs.map((port) => port.id), ['audio-in']);
});

// ---- what is deliberately left out ----------------------------------------------

test("a plugin's state chunk never reaches the description", () => {
  const hub = rig();
  const vst = hub.nodes.create('vst');
  vst.content.plugins.push({ id: 'plugin-1', pluginId: 'C:/x.vst3', name: 'Dexed', state: 'AAAA'.repeat(4096) });

  const described = describeNodes(hub).find((node) => node.id === vst.id);
  const [plugin] = described.content.plugins;
  assert.equal(plugin.state, undefined, 'the base64 blob is dropped');
  assert.equal(plugin.name, 'Dexed', 'everything a reader can use survives');
  assert.equal(plugin.pluginId, 'C:/x.vst3');
});

test('the description is a copy: writing to it cannot reach the live node', () => {
  const hub = rig();
  const vst = hub.nodes.create('vst');
  vst.content.plugins.push({ id: 'plugin-1', pluginId: 'C:/x.vst3', name: 'Dexed' });

  const described = describeNodes(hub).find((node) => node.id === vst.id);
  described.content.plugins[0].name = 'tampered';
  assert.equal(hub.nodes.get(vst.id).content.plugins[0].name, 'Dexed');
});

test('a clip reports how many notes it holds, never the notes', () => {
  const hub = rig({
    sequencerState: {
      tracks: [{
        id: 'track-1', name: 'Perc', type: 'midi', outputId: 'vst-001', volume: 1,
        clips: [{
          id: 'clip-1', startPpq: 0, lengthPpq: 16,
          notes: Array.from({ length: 512 }, (_, index) => ({ id: `n${index}`, pitch: 36, startPpq: index }))
        }]
      }]
    }
  });

  const [track] = describeSequencer(hub).tracks;
  assert.equal(track.clips[0].noteCount, 512);
  assert.equal(track.clips[0].notes, undefined, '512 notes are a request of their own');
});

// ---- the cables -------------------------------------------------------------------

test('a cable is described by its endpoints, with the type read back from the port', () => {
  const hub = rig();
  const vst = hub.nodes.create('vst');
  const mixer = hub.nodes.create('mixer');
  hub.network.connect(vst.id, 'audio-out', mixer.id, 'audio-in-1');

  assert.deepEqual(describeCables(hub), [{
    from: { nodeId: vst.id, portId: 'audio-out' },
    to: { nodeId: mixer.id, portId: 'audio-in-1' },
    type: 'audio'
  }]);
});

// ---- the catalogue ----------------------------------------------------------------

test('the catalogue carries what the scanner knows and nothing invented', () => {
  const hub = rig({
    vstCatalog: [{
      pluginId: 'C:/Massive X.vst3', name: 'Massive X', manufacturer: 'NI',
      category: 'Instrument|Synth', role: 'instrument', isInstrument: true,
      numInputChannels: 0, numOutputChannels: 2
    }]
  });
  assert.deepEqual(describeCatalogue(hub), [{
    pluginId: 'C:/Massive X.vst3', name: 'Massive X', manufacturer: 'NI',
    category: 'Instrument|Synth', role: 'instrument', isInstrument: true
  }]);
});

test('an empty machine describes as empty lists rather than as nothing', () => {
  const hub = rig();
  const described = describeSetup(hub);
  assert.deepEqual(described.nodes, []);
  assert.deepEqual(described.cables, []);
  assert.deepEqual(described.catalogue, []);
  assert.equal(described.sequencer, null);
});

test('the description says whether the machine can make a sound at all', () => {
  const hub = rig();
  // No engine: the honest answer is "not running", never an optimistic default.
  assert.equal(describeAudio(hub).running, false);

  hub.engine = { deviceState: { running: true, device: 'Speakers', sampleRate: 48000, bufferSize: 256 } };
  const audio = describeAudio(hub);
  assert.equal(audio.running, true);
  assert.equal(audio.device, 'Speakers');
  assert.equal(describeSetup(hub).audio.running, true, 'and it is part of one read, not a second question');
});

// ---- the windows on screen ----------------------------------------------------------

test('an open plugin editor is described by the node and plugin that own it', () => {
  const hub = rig();
  const vst = hub.nodes.create('vst');
  vst.content.plugins = [{ id: 'plugin-2', pluginId: 'C:/Splice.vst3', name: 'Splice INSTRUMENT' }];
  hub.engine = { getOpenEditors: (chainId) => (chainId === vst.id ? [{ instanceId: 'plugin-2', open: true }] : []) };

  const windows = describeWindows(hub, { main: { visible: true, minimized: true, focused: false }, clipEditors: [] });
  assert.deepEqual(windows.pluginEditors, [{ nodeId: vst.id, pluginInstanceId: 'plugin-2', name: 'Splice INSTRUMENT' }]);
  assert.deepEqual(windows.main, { visible: true, minimized: true, focused: false });
  assert.equal(windows.launchedInsidePackage, null, 'an ordinary launch names no package');
  assert.ok(windows.pages.some((page) => page.id === vst.id), "a node's own page is one show-window accepts");
});

test('without the main process the windows describe as unknown rather than as closed', () => {
  const windows = describeWindows(rig());
  assert.equal(windows.main, null);
  assert.deepEqual(windows.clipEditors, []);
});
