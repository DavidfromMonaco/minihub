import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from '../src/renderer/js/core/hub.js';
import { setupMidiRouting } from '../src/renderer/js/core/midiRouting.js';
import { setupEngineSync } from '../src/renderer/js/core/engineSync.js';

/**
 * Contract: when the MIDI route disappears while notes are held, everything
 * downstream is silenced.
 *
 * A held note's Note Off is only ever sent by the device that started it. If
 * that device is unplugged, deselected, or its cable is pulled, the Note Off
 * either never happens or is filtered out - and the instrument holds the note
 * forever. Each of those cases must produce an explicit panic instead.
 */

function mockApi() {
  const sent = [];
  const listeners = { event: [], state: [] };
  return {
    sent,
    emitState(s) { listeners.state.forEach((cb) => cb(s)); },
    loadSettings: async () => ({}),
    saveSettings: async () => true,
    diagnosticsLog: () => true,
    engineCommand: async (msg) => { sent.push(msg); return { ok: true }; },
    engineState: async () => ({ state: 'running', error: null }),
    onEngineEvent: (cb) => { listeners.event.push(cb); return () => {}; },
    onEngineState: (cb) => { listeners.state.push(cb); return () => {}; }
  };
}

/** A connected MiniLab -> VST route with the MIDI fan-out wired up. */
async function setupRoute() {
  const api = mockApi();
  const hub = createHub(api);
  await hub.engine.init();
  setupMidiRouting(hub);
  // Same wiring as app.js: the graph is what tells the engine which chains
  // still have a MIDI route.
  setupEngineSync(hub);
  hub.graph.addNode({ id: 'minilab-3', name: 'MiniLab 3', outputs: [{ id: 'midi-out', type: 'midi' }] });
  const node = hub.nodes.create('vst');
  hub.graph.connect('minilab-3', 'midi-out', node.id, 'midi-in');
  api.sent.length = 0;
  return { api, hub, node };
}

const midiSent = (api) => api.sent.filter((m) => m.type === 'midi').map((m) => m.data);
const isAllNotesOff = (d) => (d[0] & 0xf0) === 0xb0 && d[1] === 123;
const isAllSoundOff = (d) => (d[0] & 0xf0) === 0xb0 && d[1] === 120;

/** Register an input port with the MIDI manager without a real Web MIDI stack. */
function addInput(hub, id, name) {
  hub.midi.inputs.set(id, { id, name, manufacturer: '', type: 'input' });
}

// ---- device disappears --------------------------------------------------------

test('unplugging the selected input silences every connected chain', async () => {
  const { api, hub, node } = await setupRoute();
  addInput(hub, 'in-1', 'MiniLab 3');
  hub.midi.selectInput('in-1');
  api.sent.length = 0;

  // The device goes away: Web MIDI reports the port list without it.
  hub.midi.midiAccess = { inputs: new Map(), outputs: new Map() };
  hub.midi._refreshPorts();

  const data = midiSent(api);
  assert.ok(data.length > 0, 'a panic must reach the engine');
  assert.ok(data.every((d) => isAllNotesOff(d) || isAllSoundOff(d)), 'only panic messages');
  assert.equal(data.filter(isAllNotesOff).length, 16, 'All Notes Off on all 16 channels');
  assert.equal(data.filter(isAllSoundOff).length, 16, 'All Sound Off on all 16 channels');
  assert.ok(api.sent.every((m) => m.chainId === node.id), 'addressed to the connected chain');
  assert.equal(hub.midi.selectedInputId, null, 'and the selection is cleared');
});

test('switching to a different input silences the notes the old one held', async () => {
  const { api, hub } = await setupRoute();
  addInput(hub, 'in-1', 'MiniLab 3');
  addInput(hub, 'in-2', 'Other Controller');
  hub.midi.selectInput('in-1');
  api.sent.length = 0;

  hub.midi.selectInput('in-2');
  assert.equal(midiSent(api).filter(isAllNotesOff).length, 16);
});

test('selecting an input for the first time does not fire a panic', async () => {
  const { api, hub } = await setupRoute();
  addInput(hub, 'in-1', 'MiniLab 3');
  hub.midi.selectInput('in-1');
  assert.equal(midiSent(api).length, 0, 'nothing was held, nothing to silence');
});

test('re-selecting the same input does not fire a panic', async () => {
  const { api, hub } = await setupRoute();
  addInput(hub, 'in-1', 'MiniLab 3');
  hub.midi.selectInput('in-1');
  api.sent.length = 0;
  hub.midi.selectInput('in-1');
  assert.equal(midiSent(api).length, 0);
});

// ---- route disappears ---------------------------------------------------------

test('a panic only reaches chains that are actually connected', async () => {
  const { api, hub, node } = await setupRoute();
  const disconnected = hub.nodes.create('vst'); // no cable
  addInput(hub, 'in-1', 'MiniLab 3');
  hub.midi.selectInput('in-1');
  api.sent.length = 0;

  hub.midi.midiAccess = { inputs: new Map(), outputs: new Map() };
  hub.midi._refreshPorts();

  const chains = new Set(api.sent.filter((m) => m.type === 'midi').map((m) => m.chainId));
  assert.deepEqual([...chains], [node.id]);
  assert.ok(!chains.has(disconnected.id), 'an unconnected chain is never touched');
});

test('pulling the MIDI cable stops further notes reaching the chain', async () => {
  const { api, hub, node } = await setupRoute();
  hub.events.emit('midi:message', { type: 'noteon', channel: 1, note: 60, velocity: 100, raw: [0x90, 60, 100] });
  assert.equal(midiSent(api).length, 1);

  const mark = api.sent.length;
  hub.graph.disconnect('minilab-3', 'midi-out', node.id, 'midi-in');
  hub.events.emit('midi:message', { type: 'noteoff', channel: 1, note: 60, velocity: 0, raw: [0x80, 60, 0] });

  const after = api.sent.slice(mark);
  assert.equal(after.filter((m) => m.type === 'midi').length, 0,
    'the route is gone, so nothing more is forwarded');

  // The engine silences that chain itself when its MIDI enable goes false -
  // see Chain::setMidiEnabled. The renderer must have told it so.
  const disable = after.filter((m) => m.type === 'setChainMidiEnabled' && m.chainId === node.id);
  assert.ok(disable.length > 0 && disable[disable.length - 1].enabled === false,
    'the engine must be told the chain lost its MIDI route');
});

test('panic messages are well-formed channel messages', async () => {
  const { api, hub } = await setupRoute();
  addInput(hub, 'in-1', 'MiniLab 3');
  hub.midi.selectInput('in-1');
  api.sent.length = 0;
  hub.midi.midiAccess = { inputs: new Map(), outputs: new Map() };
  hub.midi._refreshPorts();

  for (const d of midiSent(api)) {
    assert.equal(d.length, 3, 'three bytes, so the engine forwards it');
    assert.ok(d[0] >= 0xb0 && d[0] <= 0xbf, 'control change status');
    assert.ok(d[1] === 123 || d[1] === 120);
    assert.equal(d[2], 0);
  }
  const channels = midiSent(api).filter(isAllNotesOff).map((d) => (d[0] & 0x0f) + 1);
  assert.deepEqual(channels, Array.from({ length: 16 }, (_, i) => i + 1));
});
