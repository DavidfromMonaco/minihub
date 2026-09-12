import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SequencerController } from '../src/renderer/js/core/sequencerController.js';
import { defaultSequencerState } from '../src/renderer/js/core/sequencerModel.js';
import { EventBus } from '../src/renderer/js/core/eventBus.js';
import { Network } from '../src/renderer/js/core/network.js';

/**
 * Contract: a track's MIDI input is a piece of hardware, not a session number.
 *
 * Reported 2026-09-07. The MiniLab 3 had to be picked again in the track Input
 * field at every launch. The cause is that Web MIDI ids are assigned per
 * session -- the same keyboard was `input-2`, then `input-0`, then `input-2`
 * again over three launches -- while a track stored the bare id. Once the id
 * moved, `hasInputRoute` compared a stale string to `midi.selectedInputId`,
 * said no, and recording was refused.
 *
 * The application already answered this once for the global selection, with a
 * descriptor and `samePhysicalPort`. These tests say the sequencer reuses that
 * answer rather than inventing a second one.
 */

const MINILAB = { name: 'Minilab3 MIDI', manufacturer: 'Arturia', type: 'input' };
const OTHER = { name: 'BeatStep', manufacturer: 'Arturia', type: 'input' };

const port = (id, device) => ({ id, ...device });

function rig({ tracks = [], inputs = [], selectedInputId = null } = {}) {
  const data = { sequencerState: { ...defaultSequencerState(), tracks } };
  const commands = [];
  const events = new EventBus();
  const settings = { data, get: (key) => data[key], set: async (key, value) => { data[key] = value; } };
  const network = new Network(events, settings);
  network.addNode({
    id: 'sequencer', name: 'Sequencer', type: 'sequencer',
    inputs: [{ id: 'midi-in', type: 'midi' }, { id: 'audio-in', type: 'audio' }],
    outputs: [{ id: 'midi-out', type: 'midi' }, { id: 'audio-out', type: 'audio' }]
  });
  // `midi-output` with a `midi-out` port is what `isControllerNode` recognises
  // as a hardware source, and its cable is the ingress `hasInputRoute` demands.
  network.addNode({
    id: 'minilab-3', name: 'MiniLab 3', type: 'midi-output',
    inputs: [{ id: 'midi-in', type: 'midi' }], outputs: [{ id: 'midi-out', type: 'midi' }]
  });
  network.connect('minilab-3', 'midi-out', 'sequencer', 'midi-in');
  const midi = { listInputs: () => inputs, selectedInputId, selectedOutputId: '', getOutput: () => null };
  const engine = {
    syncSequencer: (project) => commands.push({ type: 'syncSequencer', project }),
    setSequencerTrackControl: () => {},
    setTransport: () => {}
  };
  const hub = { events, settings, network, engine, api: {}, midi, project: { currentProjectName: 'Test' } };
  const controller = new SequencerController(hub).load();
  hub.sequencer = controller;
  const track = () => controller.model.state.tracks[0];
  return { hub, controller, commands, data, midi, track };
}

const midiTrack = (extra = {}) => ({
  id: 'track-1', type: 'midi', name: 'MIDI 1', armed: true, ...extra
});

// ---- the reported bug ---------------------------------------------------------

test('a track follows its keyboard when Web MIDI renumbers the port', () => {
  const { controller, track, hub } = rig({
    tracks: [midiTrack({ inputId: 'input-2', inputPort: port('input-2', MINILAB) })],
    // Same keyboard, second launch, different id. This is the whole failure.
    inputs: [port('input-0', MINILAB)]
  });
  hub.midi.selectedInputId = 'input-0';
  hub.events.emit('midi:preference', {});

  assert.equal(track().inputId, 'input-0', 'the track was re-pointed at the same hardware');
  assert.equal(controller.hasInputRoute(track()), true, 'and recording is no longer refused');
});

test('the resolution is persisted, so the next launch starts from the right id', async () => {
  const { hub, data } = rig({
    tracks: [midiTrack({ inputId: 'input-2', inputPort: port('input-2', MINILAB) })],
    inputs: [port('input-0', MINILAB)]
  });
  hub.events.emit('midi:preference', {});
  await Promise.resolve();

  assert.equal(data.sequencerState.tracks[0].inputId, 'input-0');
  assert.equal(data.sequencerState.tracks[0].inputPort.id, 'input-0');
});

// ---- projects written before the descriptor existed ---------------------------

test('a legacy bare id is believed once, and the fingerprint is written back', () => {
  const { track, hub } = rig({
    tracks: [midiTrack({ inputId: 'input-2' })],
    inputs: [port('input-2', MINILAB)]
  });
  hub.events.emit('midi:preference', {});

  assert.deepEqual(track().inputPort, port('input-2', MINILAB),
    'the port on the desk is what the id meant, so record it while that is still true');
  assert.equal(track().inputId, 'input-2', 'and nothing moved');
});

test('a legacy bare id that resolves to nothing is left exactly as it was', () => {
  const { track, hub } = rig({
    tracks: [midiTrack({ inputId: 'input-2' })],
    inputs: []
  });
  hub.events.emit('midi:preference', {});

  assert.equal(track().inputId, 'input-2', 'there is nothing to match it against yet');
  assert.equal(track().inputPort, null);
});

// ---- the project file that travels --------------------------------------------

test('an absent device leaves the track unrouted, never armed on the id it left behind', () => {
  const { track, controller, hub } = rig({
    tracks: [midiTrack({ inputId: 'input-0', inputPort: port('input-0', MINILAB) })],
    // Another machine. `input-0` exists here and is somebody else's keyboard.
    inputs: [port('input-0', OTHER)]
  });
  hub.midi.selectedInputId = 'input-0';
  hub.events.emit('midi:preference', {});

  assert.equal(track().inputId, '', 'the stale id is dropped rather than reused');
  assert.equal(controller.hasInputRoute(track()), false,
    'the track says it has no input instead of recording the wrong instrument');
  assert.deepEqual(track().inputPort, port('input-0', MINILAB),
    'the descriptor survives, so the track re-arms itself when the MiniLab is back');
});

test('the track re-arms itself when the device comes back', () => {
  const { track, controller, hub } = rig({
    tracks: [midiTrack({ inputId: 'input-0', inputPort: port('input-0', MINILAB) })],
    inputs: []
  });
  hub.events.emit('midi:preference', {});
  assert.equal(track().inputId, '');

  hub.midi.listInputs = () => [port('input-3', MINILAB)];
  hub.midi.selectedInputId = 'input-3';
  hub.events.emit('midi:preference', {});

  assert.equal(track().inputId, 'input-3');
  assert.equal(controller.hasInputRoute(track()), true);
});

// ---- what the Input field writes ----------------------------------------------

test('choosing a port in the Input field records the hardware, not only the id', () => {
  const { controller, track } = rig({
    tracks: [midiTrack({ inputId: '' })],
    inputs: [port('input-2', MINILAB)],
    selectedInputId: 'input-2'
  });

  controller.setTrack('track-1', { inputId: 'input-2' });

  assert.deepEqual(track().inputPort, port('input-2', MINILAB));
});

test('clearing the Input field clears the fingerprint with it', () => {
  const { controller, track } = rig({
    tracks: [midiTrack({ inputId: 'input-2', inputPort: port('input-2', MINILAB) })],
    inputs: [port('input-2', MINILAB)],
    selectedInputId: 'input-2'
  });

  controller.setTrack('track-1', { inputId: '' });

  assert.equal(track().inputPort, null, 'otherwise the next resolution would arm it again');
});

// ---- the boundaries -----------------------------------------------------------

test('an audio track has no fingerprint and is not touched by the resolution', () => {
  const { track, hub } = rig({
    tracks: [{ id: 'track-1', type: 'audio', name: 'Audio 1', inputId: 'audio-input', inputPort: port('x', MINILAB) }],
    inputs: [port('input-2', MINILAB)]
  });
  hub.events.emit('midi:preference', {});

  assert.equal(track().inputPort, null, 'an audio track input is a Patch Bay node id, and that one is ours');
  assert.equal(track().inputId, 'audio-input');
});

test('the engine is never handed the fingerprint', async () => {
  const { controller, commands } = rig({
    tracks: [midiTrack({ inputId: 'input-2', inputPort: port('input-2', MINILAB) })],
    inputs: [port('input-2', MINILAB)],
    selectedInputId: 'input-2'
  });
  controller.syncNative();
  await Promise.resolve();

  const sync = commands.find((item) => item.type === 'syncSequencer');
  assert.ok(sync, 'the sequencer was synchronised');
  assert.equal('inputPort' in sync.project.tracks[0], false);
  assert.equal(sync.project.tracks[0].inputId, 'input-2', 'the resolved id still goes over');
});
