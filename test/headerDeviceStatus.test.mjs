/**
 * The header names the controller from its Patch Bay node, never from a string
 * of its own.
 *
 * What this file is really pinning is the CHAIN: the loaded profile names the
 * routing node (`modules/minilab/minilabModule.js`), the node names the device
 * everywhere the user reads it (`core/controllerNode.js`), and the header is
 * one of its readers. Step 3 of this workstream had to admit that a
 * profile-derived constant is fixed at module load and no test can swap it;
 * this one can, because a node is data a fixture writes.
 *
 * The one thing to keep in mind while reading the fixtures: 'Vega 49' is not a
 * device anyone owns. It is deliberately a name sharing nothing with the
 * MiniLab 3, so an assertion cannot pass by accident on a leftover literal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeHub } from './helpers.mjs';
import { installDom, makeEl } from './domShim.mjs';
import { controllerName } from '../src/renderer/js/core/controllerNode.js';
import { LOADED_PROFILE } from '../src/renderer/js/midi/loadedProfile.js';

installDom();
const { buildHeader } = await import('../src/renderer/js/ui/header.js');
const { createMiniLabModule } = await import('../src/renderer/js/modules/minilab/minilabModule.js');

const controller = (name, id = 'some-controller') => ({
  id,
  name,
  type: 'midi-output',
  inputs: [{ id: 'midi-in', type: 'midi' }],
  outputs: [{ id: 'midi-out', type: 'midi' }]
});

/** A hub with only what `buildHeader` touches, plus a switchable MIDI state. */
function headerFixture({ state = 'ready', connected = true } = {}) {
  const hub = makeHub();
  hub.midi = { state, isMiniLabConnected: () => connected };
  hub.sequencer = { tempo: 120, recording: false, playTransport() {}, stopTransport() {}, setTempo() {} };
  hub.project = { currentProjectName: 'Untitled', dirty: false, save() {} };
  const statusEl = makeEl('span');
  const previous = document.getElementById;
  document.getElementById = () => null;
  return {
    hub,
    statusEl,
    build: () => { try { buildHeader(hub, statusEl); } finally { document.getElementById = previous; } },
    setMidi: (next) => { Object.assign(hub.midi, next); hub.events.emit('midi:state', hub.midi.state); }
  };
}

test('the header says the name of the controller node, whatever that name is', () => {
  const fixture = headerFixture();
  fixture.hub.network.addNode(controller('Vega 49'));
  fixture.build();
  assert.equal(fixture.statusEl.textContent, 'Vega 49 connected');
  assert.equal(fixture.statusEl.className, 'device-status ok');

  fixture.setMidi({ isMiniLabConnected: () => false });
  assert.equal(fixture.statusEl.textContent, 'No Vega 49 detected');
  assert.equal(fixture.statusEl.className, 'device-status idle');
});

test('no MIDI at all outranks the device name', () => {
  const fixture = headerFixture({ state: 'unavailable' });
  fixture.hub.network.addNode(controller('Vega 49'));
  fixture.build();
  assert.equal(fixture.statusEl.textContent, 'MIDI unavailable');
});

test('with no controller node to name, the header stays generic rather than guessing', () => {
  const fixture = headerFixture({ connected: false });
  fixture.build();
  assert.equal(fixture.statusEl.textContent, 'No controller detected');

  fixture.setMidi({ isMiniLabConnected: () => true });
  assert.equal(fixture.statusEl.textContent, 'Controller connected');
});

test('two hardware MIDI sources make the name a guess, so it is not made', () => {
  const fixture = headerFixture();
  fixture.hub.network.addNode(controller('Vega 49', 'vega-49'));
  fixture.hub.network.addNode(controller('Solaris 61', 'solaris-61'));
  fixture.build();
  assert.equal(fixture.statusEl.textContent, 'Controller connected');
  assert.equal(controllerName(fixture.hub.network), null);
});

test('a MIDI destination is not a controller: it has no side that sends', () => {
  const hub = makeHub();
  hub.network.addNode({
    id: 'external-synth',
    name: 'External Synth',
    type: 'midi-output',
    inputs: [{ id: 'midi-in', type: 'midi' }],
    outputs: []
  });
  assert.equal(controllerName(hub.network), null,
    'a node whose only MIDI port receives cannot be the keyboard the user plays');
});

/**
 * The end of the chain, on the profile that actually ships. Two assertions on
 * purpose: the literal says what a user sees in this build, and the profile
 * expression says where it comes from. Together they fail in the two ways that
 * matter -- a name hardcoded back into a module, and a profile edited without
 * anyone noticing that the whole shell follows it.
 */
test('the shipped profile is what the header ends up saying', () => {
  const fixture = headerFixture();
  const module = createMiniLabModule(fixture.hub);
  fixture.hub.network.addNode({ ...module.routingNode, surface: null });
  fixture.build();
  assert.equal(fixture.statusEl.textContent, 'MiniLab 3 connected');
  assert.equal(fixture.statusEl.textContent, `${LOADED_PROFILE.device.model} connected`);
  assert.equal(module.navEntry.label, LOADED_PROFILE.device.model,
    'the sidebar entry and the Patch Bay card are the same device');
});
