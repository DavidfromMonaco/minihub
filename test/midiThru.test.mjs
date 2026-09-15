/**
 * A VST node's MIDI OUT repeats what enters its MIDI IN (DECISIONS.md D-039).
 *
 * The series is answered by ONE walk, `midiThruReach`, and three consumers
 * deliver on it: live playing, the sequencer's native plan and the
 * arpeggiator's native destinations. These tests pin the walk, and then pin
 * that each consumer actually reads it -- a series one of them computes on its
 * own is an instrument heard while monitoring and missing from the bounce. The
 * sequencer's half is in `sequencer.test.mjs`, beside its rig.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHub } from './helpers.mjs';
import { midiThruReach } from '../src/renderer/js/core/midiThru.js';
import { createHub } from '../src/renderer/js/core/hub.js';
import { describeMidiNetwork, setupEngineSync } from '../src/renderer/js/core/engineSync.js';
import { getNodeType } from '../src/renderer/js/core/nodeTypes.js';

const midiIn = { id: 'midi-in', type: 'midi' };
const midiOut = { id: 'midi-out', type: 'midi' };
const audioOut = { id: 'audio-out', type: 'audio' };

function vst(network, id) {
  network.addNode({ id, name: id, type: 'vst', inputs: [midiIn], outputs: [midiOut, audioOut] });
}

function mockApi() {
  const sent = [];
  return {
    sent,
    loadSettings: async () => ({}),
    saveSettings: async () => true,
    engineCommand: async (msg) => { sent.push(msg); return { ok: true }; },
    engineState: async () => ({ state: 'running', error: null }),
    onEngineEvent: () => () => {},
    onEngineState: () => () => {}
  };
}

const sentOf = (api, type) => api.sent.filter((message) => message.type === type);

// ---- the walk ----------------------------------------------------------------

test('a VST node is born with a MIDI OUT facing its MIDI IN', () => {
  const type = getNodeType('vst');
  assert.deepEqual(type.ports.outputs.map((port) => [port.id, port.type]),
    [['midi-out', 'midi'], ['audio-out', 'audio'], ['ctrl-out', 'control']],
    'MIDI OUT on the MIDI row, AUDIO OUT on the audio row, CTRL OUT on the control row');
});

test('the series runs through every VST cabled after the first, and stops where MIDI stops being passed on', () => {
  const { network } = makeHub();
  vst(network, 'vst-a'); vst(network, 'vst-b'); vst(network, 'vst-c');
  network.addNode({ id: 'arp', name: 'Arp', type: 'arpeggiator', inputs: [midiIn], outputs: [midiOut] });
  network.addNode({ id: 'vst-after-arp', name: 'After arp', type: 'vst', inputs: [midiIn], outputs: [midiOut] });
  network.addNode({ id: 'keys', name: 'Keys', type: 'midi-output', inputs: [midiIn], outputs: [midiOut] });
  network.connect('vst-a', 'midi-out', 'vst-b', 'midi-in');
  network.connect('vst-b', 'midi-out', 'vst-c', 'midi-in');
  network.connect('vst-b', 'midi-out', 'arp', 'midi-in');
  network.connect('arp', 'midi-out', 'vst-after-arp', 'midi-in');
  network.connect('vst-c', 'midi-out', 'keys', 'midi-in');

  assert.deepEqual(midiThruReach(network, 'vst-a'), [
    { id: 'vst-b', kind: 'vst', via: 'vst-a' },
    { id: 'vst-c', kind: 'vst', via: 'vst-b' },
    { id: 'arp', kind: 'arpeggiator', via: 'vst-b' },
    { id: 'keys', kind: 'midi-output', via: 'vst-c' }
  ], 'an arpeggiator makes its own notes, so what it plays is not the series');
  assert.deepEqual(midiThruReach(network, 'vst-c').map((hop) => hop.id), ['keys'],
    'the walk only ever goes downstream');
});

test('an instrument two paths reach is answered once, through the first cable that reaches it', () => {
  const { network } = makeHub();
  for (const id of ['vst-a', 'vst-b', 'vst-c', 'vst-d']) vst(network, id);
  network.connect('vst-a', 'midi-out', 'vst-b', 'midi-in');
  network.connect('vst-a', 'midi-out', 'vst-c', 'midi-in');
  network.connect('vst-b', 'midi-out', 'vst-d', 'midi-in');
  network.connect('vst-c', 'midi-out', 'vst-d', 'midi-in');

  const reach = midiThruReach(network, 'vst-a');
  assert.deepEqual(reach.map((hop) => hop.id), ['vst-b', 'vst-c', 'vst-d']);
  assert.equal(reach.find((hop) => hop.id === 'vst-d').via, 'vst-b');
});

test('the Sequencer is never part of a series, and audio cables are not MIDI', () => {
  const { network } = makeHub();
  vst(network, 'vst-a'); vst(network, 'vst-b');
  network.addNode({ id: 'sequencer', name: 'Sequencer', type: 'sequencer', inputs: [midiIn, { id: 'audio-in', type: 'audio' }], outputs: [] });
  network.connect('vst-a', 'midi-out', 'sequencer', 'midi-in');
  network.connect('vst-a', 'audio-out', 'sequencer', 'audio-in');
  assert.deepEqual(midiThruReach(network, 'vst-a'), []);
  assert.deepEqual(midiThruReach(network, 'sequencer'), [], 'only a VST node has a series');
  assert.deepEqual(midiThruReach(network, 'absent'), []);
});

test('the walk ends even on a network that holds a cycle', () => {
  // connect() refuses a cycle; this network is built by hand to lie about it.
  const nodes = new Map([['a', { id: 'a', type: 'vst', inputs: [midiIn], outputs: [midiOut] }],
    ['b', { id: 'b', type: 'vst', inputs: [midiIn], outputs: [midiOut] }]]);
  const cables = [
    { from: { nodeId: 'a', portId: 'midi-out' }, to: { nodeId: 'b', portId: 'midi-in' } },
    { from: { nodeId: 'b', portId: 'midi-out' }, to: { nodeId: 'a', portId: 'midi-in' } }
  ];
  const network = { getNode: (id) => nodes.get(id), connectionsFrom: (id) => cables.filter((c) => c.from.nodeId === id) };
  assert.deepEqual(midiThruReach(network, 'a').map((hop) => hop.id), ['b']);
});

test('the Patch Bay takes a VST-to-VST MIDI cable and refuses the one that would loop it', () => {
  const hub = createHub(mockApi());
  const a = hub.nodes.create('vst');
  const b = hub.nodes.create('vst');
  assert.equal(hub.network.connect(a.id, 'midi-out', b.id, 'midi-in'), true);
  assert.throws(() => hub.network.connect(b.id, 'midi-out', a.id, 'midi-in'), /feedback cycle/);
});

// ---- live playing --------------------------------------------------------------

test('a note played into the first VST reaches the whole series, each node once', () => {
  const api = mockApi();
  const hub = createHub(api);
  const received = { keys: [], sequencer: [] };
  hub.network.addNode({ id: 'minilab-3', name: 'MiniLab', type: 'midi-output', inputs: [midiIn], outputs: [midiOut],
    onInput: (_port, data) => received.keys.push(data.raw) });
  hub.network.addNode({ id: 'sequencer', name: 'Sequencer', type: 'sequencer', inputs: [midiIn], outputs: [],
    onInput: (_port, data) => received.sequencer.push(data.raw) });
  const a = hub.nodes.create('vst');
  const b = hub.nodes.create('vst');
  const c = hub.nodes.create('vst');
  const arp = hub.nodes.create('arpeggiator');
  hub.network.connect('minilab-3', 'midi-out', a.id, 'midi-in');
  hub.network.connect(a.id, 'midi-out', b.id, 'midi-in');
  hub.network.connect(a.id, 'midi-out', c.id, 'midi-in');
  hub.network.connect(b.id, 'midi-out', c.id, 'midi-in');
  hub.network.connect(c.id, 'midi-out', arp.id, 'midi-in');
  hub.network.connect(c.id, 'midi-out', 'minilab-3', 'midi-in');
  hub.network.connect(b.id, 'midi-out', 'sequencer', 'midi-in');

  hub.network.emitData('minilab-3', 'midi-out', { raw: [0x90, 60, 100] });

  assert.deepEqual(sentOf(api, 'midi').map((message) => message.chainId), [a.id, b.id, c.id],
    'C is cabled from both A and B, and plays the note once');
  assert.deepEqual(sentOf(api, 'midiNode').map((message) => message.nodeId), [arp.id]);
  assert.deepEqual(received.keys, [[0x90, 60, 100]], 'the hardware output hears it through its own node');
  assert.deepEqual(received.sequencer, [],
    'a VST never hands the Sequencer its notes: it records the keyboard, not a copy of it');
});

test('pulling the cable between two VSTs takes the second out of the series at once', () => {
  const api = mockApi();
  const hub = createHub(api);
  hub.network.addNode({ id: 'minilab-3', name: 'MiniLab', type: 'midi-output', inputs: [midiIn], outputs: [midiOut] });
  const a = hub.nodes.create('vst');
  const b = hub.nodes.create('vst');
  hub.network.connect('minilab-3', 'midi-out', a.id, 'midi-in');
  hub.network.connect(a.id, 'midi-out', b.id, 'midi-in');
  hub.network.disconnect(a.id, 'midi-out', b.id, 'midi-in');
  hub.network.emitData('minilab-3', 'midi-out', { raw: [0x90, 62, 100] });
  assert.deepEqual(sentOf(api, 'midi').map((message) => message.chainId), [a.id]);
});

// ---- the engine's half ---------------------------------------------------------

test('a VST fed only through another VST is MIDI-enabled in the engine', async () => {
  const api = mockApi();
  const hub = createHub(api);
  await hub.engine.init();
  const a = hub.nodes.create('vst');
  const b = hub.nodes.create('vst');
  setupEngineSync(hub);
  hub.network.connect(a.id, 'midi-out', b.id, 'midi-in');
  assert.deepEqual(sentOf(api, 'setChainMidiEnabled').filter((message) => message.chainId === b.id).at(-1),
    { v: 1, type: 'setChainMidiEnabled', chainId: b.id, enabled: true },
    'without this the chain drops every note the series hands it');
});

test("an arpeggiator's destinations carry the series behind its VSTs, and no other arpeggiator", () => {
  const hub = createHub(mockApi());
  const arp = hub.nodes.create('arpeggiator');
  const other = hub.nodes.create('arpeggiator');
  const a = hub.nodes.create('vst');
  const b = hub.nodes.create('vst');
  hub.network.addNode({ id: 'minilab-3', name: 'MiniLab', type: 'midi-output', inputs: [midiIn], outputs: [midiOut] });
  hub.network.connect(arp.id, 'midi-out', a.id, 'midi-in');
  hub.network.connect(a.id, 'midi-out', b.id, 'midi-in');
  hub.network.connect(a.id, 'midi-out', other.id, 'midi-in');
  hub.network.connect(b.id, 'midi-out', 'minilab-3', 'midi-in');
  hub.network.connect(arp.id, 'midi-out', b.id, 'midi-in');

  const described = describeMidiNetwork(hub).find((node) => node.id === arp.id);
  assert.deepEqual(described.destinations, [a.id, b.id, 'minilab-3'],
    'B is reached twice and listed once; the engine cannot feed one arpeggiator from another');
});
