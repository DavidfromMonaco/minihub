import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from '../src/renderer/js/core/hub.js';
import { setupMidiRouting } from '../src/renderer/js/core/midiRouting.js';
import { setupEngineSync } from '../src/renderer/js/core/engineSync.js';
import {
  miniLabScore, isMiniLabName, isPerformanceInputName
} from '../src/renderer/js/midi/minilab.js';

/**
 * Contract: the input that gets armed must be one that can actually deliver
 * what the user plays.
 *
 * A MiniLab 3 exposes four inputs on Windows and only some carry played notes:
 *
 *   Minilab3 MIDI       keys / pads / encoders     <- performance
 *   Minilab3 ALV        Analog Lab channel         <- performance
 *   Minilab3 MCU/HUI    DAW control surface        <- transport & faders only
 *   Minilab3 DIN THRU   5-pin pass-through         <- nothing of ours
 *
 * Scoring them all alike armed the first one enumerated - MCU/HUI - and every
 * key press was then discarded as coming from an unselected input.
 */

const MINILAB_PORTS = [
  { id: 'input-0', name: 'Minilab3 MCU/HUI' },
  { id: 'input-1', name: 'Minilab3 ALV' },
  { id: 'input-2', name: 'Minilab3 MIDI' },
  { id: 'input-3', name: 'Minilab3 DIN THRU' }
];

// ---- port ranking -------------------------------------------------------------

test('the musical port outranks every other MiniLab port', () => {
  const ranked = [...MINILAB_PORTS].sort((a, b) => miniLabScore(b.name) - miniLabScore(a.name));
  assert.equal(ranked[0].name, 'Minilab3 MIDI');
  assert.ok(
    miniLabScore('Minilab3 MIDI') > miniLabScore('Minilab3 MCU/HUI'),
    'the control surface must never win'
  );
  assert.ok(
    miniLabScore('Minilab3 MIDI') > miniLabScore('Minilab3 DIN THRU'),
    'the DIN thru must never win'
  );
});

test('control-surface and DIN-thru ports are marked as unable to send notes', () => {
  assert.equal(isPerformanceInputName('Minilab3 MCU/HUI'), false);
  assert.equal(isPerformanceInputName('Minilab3 DIN THRU'), false);
  assert.equal(isPerformanceInputName('Minilab3 MIDI'), true);
  assert.equal(isPerformanceInputName('Minilab3 ALV'), true);
});

test('all four ports are still recognised as MiniLab hardware', () => {
  for (const p of MINILAB_PORTS) {
    assert.equal(isMiniLabName(p.name), true, `${p.name} is a MiniLab port`);
  }
  assert.equal(isMiniLabName('Some Other Device'), false);
});

test('a non-MiniLab device never scores above a MiniLab port', () => {
  assert.equal(miniLabScore('Some Other Device'), 0);
  assert.ok(miniLabScore('Minilab3 MCU/HUI') > miniLabScore('Some Other Device'));
});

// ---- auto-selection -----------------------------------------------------------

function hubWithPorts(ports, settings = {}) {
  const sent = [];
  const listeners = { event: [], state: [] };
  const api = {
    sent,
    emitState(s) { listeners.state.forEach((cb) => cb(s)); },
    loadSettings: async () => ({ ...settings }),
    saveSettings: async () => true,
    diagnosticsLog: () => true,
    engineCommand: async (msg) => { sent.push(msg); return { ok: true }; },
    engineState: async () => ({ state: 'running', error: null }),
    onEngineEvent: (cb) => { listeners.event.push(cb); return () => {}; },
    onEngineState: (cb) => { listeners.state.push(cb); return () => {}; }
  };
  const hub = createHub(api);
  for (const p of ports) {
    hub.midi.inputs.set(p.id, { id: p.id, name: p.name, manufacturer: 'Arturia', type: 'input' });
  }
  hub.settings.data = { ...settings };
  return { hub, api };
}

test('auto-selection arms the musical port, not the control surface', () => {
  const { hub } = hubWithPorts(MINILAB_PORTS);
  const chosen = hub.midi.findMiniLabInputId();
  assert.equal(chosen, 'input-2');
  assert.equal(hub.midi.getInput(chosen).name, 'Minilab3 MIDI');
});

test('the ALV port is used when the plain musical port is absent', () => {
  const { hub } = hubWithPorts([
    { id: 'input-0', name: 'Minilab3 MCU/HUI' },
    { id: 'input-1', name: 'Minilab3 ALV' }
  ]);
  assert.equal(hub.midi.getInput(hub.midi.findMiniLabInputId()).name, 'Minilab3 ALV');
});

// ---- the played note actually reaches the chain -------------------------------

/** MiniLab -> VST route, wired exactly like app.js. */
async function routedHub(selectedInputId) {
  const { hub, api } = hubWithPorts(MINILAB_PORTS);
  await hub.engine.init();
  setupMidiRouting(hub);
  setupEngineSync(hub);
  hub.graph.addNode({ id: 'minilab-3', name: 'MiniLab 3', outputs: [{ id: 'midi-out', type: 'midi' }] });
  const node = hub.nodes.create('vst');
  hub.graph.connect('minilab-3', 'midi-out', node.id, 'midi-in');
  hub.midi.selectInput(selectedInputId);
  api.sent.length = 0;
  return { hub, api, node };
}

const notesReaching = (api) =>
  api.sent.filter((m) => m.type === 'midi' && (m.data[0] & 0xf0) === 0x90);

test('a key press on the musical port reaches the VST chain', async () => {
  const { hub, api, node } = await routedHub('input-2');

  // Exactly what Web MIDI delivers for one physical key press.
  hub.midi._onMessage('input-2', new Uint8Array([0x90, 60, 100]), 0);
  hub.midi._onMessage('input-2', new Uint8Array([0x80, 60, 0]), 0);

  const midi = api.sent.filter((m) => m.type === 'midi');
  assert.equal(midi.length, 2, 'Note On and Note Off both forwarded');
  assert.equal(midi[0].chainId, node.id);
  assert.deepEqual(midi[0].data, [0x90, 60, 100], 'raw bytes preserved, velocity intact');
  assert.deepEqual(midi[1].data, [0x80, 60, 0]);
});

test('with the control surface armed, played notes are discarded (the reported bug)', async () => {
  const { hub, api } = await routedHub('input-0'); // MCU/HUI

  hub.midi._onMessage('input-2', new Uint8Array([0x90, 60, 100]), 0);

  assert.equal(notesReaching(api).length, 0,
    'this is the failure: keys arrive on input-2 but input-0 is armed');
});

test('channel and velocity survive the whole renderer path', async () => {
  const { hub, api } = await routedHub('input-2');

  hub.midi._onMessage('input-2', new Uint8Array([0x95, 72, 1]), 0);   // channel 6, vel 1
  hub.midi._onMessage('input-2', new Uint8Array([0x9f, 36, 127]), 0); // channel 16, vel 127

  const [a, b] = api.sent.filter((m) => m.type === 'midi').map((m) => m.data);
  assert.deepEqual(a, [0x95, 72, 1], 'low velocity is not rounded away');
  assert.deepEqual(b, [0x9f, 36, 127], 'channel 16 preserved');
});

test('a Note On with velocity 0 is forwarded as the Note Off it is', async () => {
  const { hub, api } = await routedHub('input-2');
  hub.midi._onMessage('input-2', new Uint8Array([0x90, 60, 0]), 0);

  const [data] = api.sent.filter((m) => m.type === 'midi').map((m) => m.data);
  assert.deepEqual(data, [0x90, 60, 0], 'raw bytes are forwarded untouched');
});

test('no physical input is routed when nothing is explicitly selected', async () => {
  const { hub, api } = await routedHub(null);
  hub.midi._onMessage('input-2', new Uint8Array([0x90, 60, 100]), 0);
  assert.equal(notesReaching(api).length, 0,
    'an unselected physical port must not impersonate the visible MiniLab graph source');
});

// ---- hot-plug -----------------------------------------------------------------

test('plugging the controller in after launch re-arms the preferred port', async () => {
  const { hub } = hubWithPorts([], { selectedInputId: 'input-2' });
  hub.midi.midiAccess = { inputs: new Map(), outputs: new Map() };

  // Launched with nothing connected.
  hub.midi._refreshPorts();
  assert.equal(hub.midi.selectedInputId, null);

  // The MiniLab is plugged in: Web MIDI reports its ports.
  hub.midi.midiAccess = {
    inputs: new Map(MINILAB_PORTS.map((p) => [p.id, { ...p, manufacturer: 'Arturia', type: 'input' }])),
    outputs: new Map()
  };
  hub.midi._refreshPorts();

  assert.equal(hub.midi.selectedInputId, 'input-2',
    'the preferred musical port is re-armed rather than left wide open');
});

test('unplugging keeps the preference so it can be restored', async () => {
  const { hub } = hubWithPorts([], { selectedInputId: 'input-2' });
  hub.midi.midiAccess = {
    inputs: new Map(MINILAB_PORTS.map((p) => [p.id, { ...p, manufacturer: 'Arturia', type: 'input' }])),
    outputs: new Map()
  };
  hub.midi._refreshPorts();
  assert.equal(hub.midi.selectedInputId, 'input-2');

  hub.midi.midiAccess = { inputs: new Map(), outputs: new Map() };
  hub.midi._refreshPorts();
  assert.equal(hub.midi.selectedInputId, null, 'nothing armed while it is gone');
  assert.equal(hub.settings.get('selectedInputId'), 'input-2', 'but the preference survives');
});

test('an explicit disconnect is not undone by a port refresh', async () => {
  const { hub } = hubWithPorts(MINILAB_PORTS, { selectedInputId: null });
  hub.midi.midiAccess = {
    inputs: new Map(MINILAB_PORTS.map((p) => [p.id, { ...p, manufacturer: 'Arturia', type: 'input' }])),
    outputs: new Map()
  };
  hub.midi._refreshPorts();
  assert.equal(hub.midi.selectedInputId, null,
    'the user asked for no input; a refresh must not re-arm one');
});
