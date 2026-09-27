import './installNodeEditors.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from '../src/renderer/js/core/hub.js';
import { defaultSequencerState } from '../src/renderer/js/core/sequencerModel.js';
import { setupMidiRouting } from '../src/renderer/js/core/midiRouting.js';
import { setupControlRouting } from '../src/renderer/js/core/controlRouting.js';
import { createTapTempo, installControllerTransport, transportKeyOf } from '../src/renderer/js/core/controllerTransport.js';
import { validateControllerProfile } from '../src/renderer/js/midi/controllerProfile.js';
import MINILAB from '../src/renderer/js/midi/profiles/minilab-3.json' with { type: 'json' };

/** What the MiniLab 3 sent, Shift held, in the author's captures of 2026-09-26. */
const shifted = (controller, value = 127) => ({
  type: 'cc', channel: 1, controller, value, raw: [0xb0, controller, value],
  sourceName: 'Minilab3 MIDI', sourceId: 'input-0', profileId: 'minilab-3', hubTimestamp: 0
});

function mockApi() {
  const data = { sequencerState: defaultSequencerState() };
  const sent = [];
  return {
    data, sent,
    loadSettings: async () => ({ ...data }),
    saveSettings: async (s) => { Object.assign(data, s); return true; },
    diagnosticsLog: () => true,
    engineCommand: async (msg) => { sent.push(msg); return { ok: true }; },
    engineState: async () => ({ state: 'running', error: null }),
    onEngineEvent: () => () => {},
    onEngineState: () => () => {}
  };
}

async function studio() {
  const api = mockApi();
  const hub = createHub(api);
  await hub.settings.load();
  hub.nodes.create('sequencer');
  hub.sequencer.load();
  installControllerTransport(hub);
  return { api, hub };
}

test('the profile declares the five keys the MiniLab prints over its pads, and stays valid', () => {
  assert.equal(validateControllerProfile(MINILAB).ok, true, JSON.stringify(validateControllerProfile(MINILAB).errors));
  assert.deepEqual([105, 106, 107, 108, 109].map((cc) => transportKeyOf(shifted(cc))),
    ['loop', 'stop', 'play', 'record', 'tap']);
  assert.equal(transportKeyOf({ ...shifted(74), controller: 74 }), null, 'a knob is not a transport key');
  const bad = structuredClone(MINILAB);
  bad.controls.find((c) => c.id === 'p6').bindings.find((b) => b.when.number === 107).transport = 'rewind';
  assert.equal(validateControllerProfile(bad).ok, false, 'a transport key the application has not got is refused');
});

test('Play starts and stops, Stop stops, Rec starts a take and ends it', async () => {
  const { hub } = await studio();
  hub.events.emit('midi:message', shifted(107));
  assert.equal(hub.sequencer.playing, true);
  hub.events.emit('midi:message', shifted(107, 0));
  assert.equal(hub.sequencer.playing, true, 'the release does nothing');
  hub.events.emit('midi:message', shifted(107));
  assert.equal(hub.sequencer.playing, false, 'pressed again, it stops, as Space does');

  hub.events.emit('midi:message', shifted(107));
  hub.events.emit('midi:message', shifted(106));
  assert.equal(hub.sequencer.playing, false);

  let blocked = null;
  hub.events.on('sequencer:record-blocked', (event) => { blocked = event.message; });
  hub.events.emit('midi:message', shifted(108));
  assert.ok(blocked, 'a take that cannot start says why, as the header button does');
  assert.equal(hub.sequencer.recording, false);
  hub.sequencer.recordBlockReason = () => '';
  hub.events.emit('midi:message', shifted(108));
  assert.equal(hub.sequencer.recording, true);
  hub.events.emit('midi:message', shifted(108));
  assert.equal(hub.sequencer.recording, false, 'Rec again ends the take');
});

test('Loop turns the loop on and off', async () => {
  const { hub } = await studio();
  assert.equal(hub.sequencer.model.state.loop.enabled, false);
  hub.events.emit('midi:message', shifted(105));
  assert.equal(hub.sequencer.model.state.loop.enabled, true);
  hub.events.emit('midi:message', shifted(105));
  assert.equal(hub.sequencer.model.state.loop.enabled, false);
});

test('Tap sets the tempo from the second tap, and a pause starts a new count', () => {
  const tap = createTapTempo();
  assert.equal(tap(0), null, 'one tap is not a tempo');
  assert.equal(tap(500), 120);
  assert.equal(tap(1000), 120);
  assert.equal(tap(1540), 117, 'the intervals are averaged: 1540 ms over three taps is 117');
  assert.equal(tap(5000), null, 'after a pause, the count starts again');
  assert.equal(tap(5750), 80);
});

test('Tap on the keyboard moves the transport tempo', async () => {
  const { hub } = await studio();
  hub.events.emit('midi:message', { ...shifted(109), hubTimestamp: 1000 });
  hub.events.emit('midi:message', { ...shifted(109), hubTimestamp: 1600 });
  assert.equal(hub.sequencer.tempo, 100);
});

test('a transport key reaches neither the synths nor a control binding', async () => {
  const { hub } = await studio();
  setupMidiRouting(hub);
  setupControlRouting(hub);
  const emitted = [];
  const original = hub.network.emitData.bind(hub.network);
  hub.network.emitData = (nodeId, portId, data) => { emitted.push(`${nodeId}:${portId}`); return original(nodeId, portId, data); };
  hub.events.emit('midi:message', shifted(108, 0));
  assert.deepEqual(emitted, [], 'Rec is not CC 108 sent to Analog Lab, nor written into the take');
  hub.events.emit('midi:message', { ...shifted(74), controller: 74, raw: [0xb0, 74, 64], value: 64 });
  assert.ok(emitted.includes('minilab-3:midi-out'), 'a knob still plays down the MIDI path');
});
