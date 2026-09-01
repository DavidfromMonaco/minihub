import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SEQUENCER_LIMITS, SequencerModel, normalizeSequencerState, snapPpq, snapStep } from '../src/renderer/js/core/sequencerModel.js';
import { SequencerController } from '../src/renderer/js/core/sequencerController.js';
import { EventBus } from '../src/renderer/js/core/eventBus.js';
import { Graph } from '../src/renderer/js/core/graph.js';

function rig(initial = {}) {
  const data = { ...initial };
  const commands = [];
  const events = new EventBus();
  const settings = { data, get: (key) => data[key], set: async (key, value) => { data[key] = value; } };
  const graph = new Graph(events, settings);
  graph.addNode({
    id: 'sequencer', name: 'Sequencer', type: 'sequencer',
    inputs: [{ id: 'midi-in', type: 'midi' }, { id: 'audio-in', type: 'audio' }],
    outputs: [{ id: 'midi-out', type: 'midi' }, { id: 'audio-out', type: 'audio' }],
    onInput: (_portId, message) => controller.receiveMidiInput(message)
  });
  graph.addNode({ id: 'midi-source', name: 'MIDI Source', type: 'midi-output', inputs: [], outputs: [{ id: 'midi-out', type: 'midi' }] });
  graph.addNode({ id: 'vst-001', name: 'VST 1', type: 'vst', inputs: [{ id: 'midi-in', type: 'midi' }, { id: 'audio-in', type: 'audio' }], outputs: [{ id: 'audio-out', type: 'audio' }], onInput: (_portId, message) => commands.push({ type: 'liveMidi', chainId: 'vst-001', message }) });
  graph.addNode({ id: 'minilab-3', name: 'MiniLab 3', type: 'midi-output', inputs: [{ id: 'midi-in', type: 'midi' }], outputs: [{ id: 'midi-out', type: 'midi' }] });
  graph.addNode({ id: 'audio-input', name: 'Audio Input', type: 'audio-input', inputs: [], outputs: [{ id: 'audio-out', type: 'audio' }] });
  graph.addNode({ id: 'audio-output', name: 'Audio Output', type: 'audio-output', inputs: [{ id: 'audio-in', type: 'audio' }], outputs: [] });
  const engine = {
    syncSequencer: (project) => commands.push({ type: 'syncSequencer', project }),
    setTransport: (state) => commands.push({ type: 'setTransport', ...state }),
    sequencerMidiInput: (...args) => commands.push({ type: 'midiInput', args }),
    sequencerRecord: (enabled) => commands.push({ type: 'record', enabled }),
    sequencerExport: (options) => commands.push({ type: 'export', ...options }),
    sequencerCancelExport: () => { commands.push({ type: 'cancelExport' }); return { ok: true }; },
    sequencerPanic: () => commands.push({ type: 'panic' }),
    selectMidiOutput: (device) => commands.push({ type: 'selectMidiOutput', device })
  };
  const api = {
    audioPickOpen: async () => 'C:\\audio\\loop.wav',
    audioPickSave: async (_name, format = 'wav') => `C:\\audio\\mix.${format}`,
    audioCommitTake: async (_path, name) => ({ ok: true, filePath: `C:\\takes\\${name}.wav` })
  };
  const hub = { events, settings, graph, engine, api, midi: { listInputs: () => [], selectedOutputId: '', getOutput: () => null }, project: { currentProjectName: 'Test' } };
  const controller = new SequencerController(hub).load(); hub.sequencer = controller;
  return { hub, controller, commands, data };
}

test('snap divisions map bars through 1/32 to stable PPQ units', () => {
  assert.deepEqual(['1 bar','1/2','1/4','1/8','1/16','1/32'].map(snapStep), [4,2,1,.5,.25,.125]);
  assert.equal(snapPpq(1.19, '1/16'), 1.25);
  assert.equal(snapPpq(-2, '1/32'), 0);
});

test('timeline clip move, resize, duplicate and delete honor snap', () => {
  const model = new SequencerModel(); const track = model.addTrack('midi'); const clip = model.addMidiClip(track.id, .19, 4);
  assert.equal(clip.startPpq, .25);
  model.moveClip(clip.id, 2.13); assert.equal(clip.startPpq, 2.25);
  model.resizeClip(clip.id, 1.11); assert.equal(clip.lengthPpq, 1);
  const copy = model.duplicateClip(clip.id); assert.equal(copy.startPpq, 3.25); assert.notEqual(copy.id, clip.id);
  assert.equal(model.removeClip(clip.id), true); assert.deepEqual(track.clips.map((item) => item.id), [copy.id]);
});

test('multi-selection moves, copies, pastes, duplicates and deletes one offset-preserving group', () => {
  const model = new SequencerModel();
  const firstTrack = model.addTrack('midi');
  const secondTrack = model.addTrack('midi');
  const first = model.addMidiClip(firstTrack.id, 0, 1);
  const middle = model.addMidiClip(firstTrack.id, 2, 1);
  const last = model.addMidiClip(secondTrack.id, 5, 2);

  model.selectClip(first.id);
  model.selectClip(middle.id, { toggle: true });
  assert.deepEqual(model.selectedClipIds(), [first.id, middle.id]);
  model.selectClip(last.id, { range: true });
  assert.deepEqual(new Set(model.selectedClipIds()), new Set([middle.id, last.id]),
    'Shift selects the ordered range from the last Ctrl anchor');

  model.selectClip(first.id);
  model.selectClip(last.id, { toggle: true });
  const origins = model.clipPlacements();
  assert.equal(model.moveClips(model.selectedClipIds(), 1.13, null, {
    anchorClipId: first.id, origins
  }), true);
  assert.deepEqual([first.startPpq, last.startPpq], [1.25, 6.25],
    'one snapped common delta preserves the five-beat temporal offset');

  const payload = model.copyClips();
  const pasted = model.pasteClips(payload, 10);
  assert.equal(pasted.length, 2);
  assert.deepEqual(pasted.map((clip) => clip.startPpq), [10, 15]);
  assert.deepEqual(pasted.map((clip) => model._clip(clip.id).track.id), [firstTrack.id, secondTrack.id]);

  const duplicated = model.duplicateClips();
  assert.equal(duplicated.length, 2);
  assert.equal(duplicated[1].startPpq - duplicated[0].startPpq, 5);
  assert.equal(model.removeClips(), 2);
  assert.equal(duplicated.every((clip) => model._clip(clip.id) === null), true);
  model.selectClip(null);
  assert.deepEqual(model.selectedClipIds(), []);
});

test('MIDI clip events preserve pitch, timing, velocity and channel without an editor state', () => {
  const model = new SequencerModel(); const track = model.addTrack('midi');
  const clip = model.addMidiClip(track.id, 0, 8, [
    { pitch: 60, startPpq: .1, durationPpq: .5, velocity: 23, channel: 6 },
    { pitch: 64, startPpq: .6, durationPpq: 1, velocity: 127, channel: 16 }
  ]);
  assert.deepEqual(clip.notes.map((note) => [note.pitch, note.startPpq, note.durationPpq, note.velocity, note.channel]), [
    [60, .1, .5, 23, 6], [64, .6, 1, 127, 16]
  ]);
  assert.equal('pianoZoom' in model.snapshot(), false);
});

test('native-aligned project limits reject edits before they can become transient data loss', () => {
  const model = new SequencerModel();
  model.state.tracks.length = SEQUENCER_LIMITS.tracks;
  assert.equal(model.addTrack('midi'), null);

  const clipModel = new SequencerModel();
  const track = clipModel.addTrack('midi');
  const clip = clipModel.addMidiClip(track.id, 0, 4);
  track.clips.length = SEQUENCER_LIMITS.clipsPerTrack;
  assert.equal(clipModel.addMidiClip(track.id, 4, 4), null);
  assert.equal(clipModel.duplicateClip(clip.id), null);

  track.clips.length = 1;
  assert.equal(SEQUENCER_LIMITS.notesPerClip, 65536);
});

test('loop range normalizes order and is included in the native snapshot', async () => {
  const { controller, commands } = rig();
  controller.model.setLoop({ enabled: true, startPpq: 8.12, endPpq: 7 }); controller.changed();
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.deepEqual(controller.model.state.loop, { enabled: true, startPpq: 8, endPpq: 8.25 });
  assert.ok(commands.some((command) => command.type === 'setTransport' && command.loop?.enabled));
});

test('track output selection creates authoritative Patch Bay routes', async () => {
  const { controller, hub, commands } = rig(); const midi = controller.model.addTrack('midi'); const audio = controller.model.addTrack('audio');
  controller.setTrack(midi.id, { outputId: 'vst-001' }); controller.setTrack(audio.id, { outputId: 'audio-output' });
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.equal(hub.graph.connectionsFrom('sequencer', 'midi-out')[0].to.nodeId, 'vst-001');
  assert.equal(hub.graph.connectionsFrom('sequencer', 'audio-out')[0].to.nodeId, 'audio-output');
  const sync = commands.filter((command) => command.type === 'syncSequencer').at(-1);
  assert.equal(sync.project.tracks.find((track) => track.id === midi.id).outputId, 'vst-001');
});

test('multiple MIDI tracks keep independent VST destinations and visible fan-out cables', async () => {
  const { controller, hub, commands } = rig();
  hub.graph.addNode({
    id: 'vst-002', name: 'VST 2', type: 'vst',
    inputs: [{ id: 'midi-in', type: 'midi' }, { id: 'audio-in', type: 'audio' }],
    outputs: [{ id: 'audio-out', type: 'audio' }]
  });
  const first = controller.model.addTrack('midi');
  const second = controller.model.addTrack('midi');
  controller.setTrack(first.id, { outputId: 'vst-001' });
  controller.setTrack(second.id, { outputId: 'vst-002' });
  await new Promise((resolve) => queueMicrotask(resolve));

  assert.deepEqual(hub.graph.connectionsFrom('sequencer', 'midi-out')
    .map((connection) => connection.to.nodeId).sort(), ['vst-001', 'vst-002']);
  const nativeTracks = commands.filter((command) => command.type === 'syncSequencer').at(-1).project.tracks;
  assert.equal(nativeTracks.find((track) => track.id === first.id).outputId, 'vst-001');
  assert.equal(nativeTracks.find((track) => track.id === second.id).outputId, 'vst-002');

  controller.removeTrack(first.id);
  assert.deepEqual(hub.graph.connectionsFrom('sequencer', 'midi-out')
    .map((connection) => connection.to.nodeId), ['vst-002'],
  'removing one track removes only its VST cable');
});

test('focused exclusive arm and intentional multi-arm route live MIDI to exact track destinations', () => {
  const { controller, hub, commands } = rig();
  hub.graph.addNode({
    id: 'vst-002', name: 'VST 2', type: 'vst',
    inputs: [{ id: 'midi-in', type: 'midi' }, { id: 'audio-in', type: 'audio' }],
    outputs: [{ id: 'audio-out', type: 'audio' }],
    onInput: (_portId, message) => commands.push({ type: 'liveMidi', chainId: 'vst-002', message })
  });
  hub.midi.selectedInputId = 'minilab-port';
  hub.graph.connect('minilab-3', 'midi-out', 'sequencer', 'midi-in');
  const first = controller.model.addTrack('midi');
  const second = controller.model.addTrack('midi');
  controller.setTrack(first.id, { inputId: 'minilab-port', outputId: 'vst-001' });
  controller.setTrack(second.id, { inputId: 'minilab-port', outputId: 'vst-002' });
  controller.setTrackArmed(first.id, true);
  commands.length = 0;

  controller.receiveMidiInput({ sourceId: 'minilab-port', raw: [0x90, 60, 100] });
  assert.deepEqual(commands.filter((item) => item.type === 'liveMidi').map((item) => item.chainId), ['vst-001']);

  controller.exporting = true;
  controller.receiveMidiInput({ sourceId: 'minilab-port', raw: [0x80, 60, 0] });
  assert.deepEqual(commands.filter((item) => item.type === 'liveMidi').slice(-1).map((item) => item.chainId), ['vst-001'],
    'the held Note Off remains immediate while export owns its private graph');

  controller.focusTrack(second.id);
  assert.deepEqual([first.armed, second.armed], [false, true], 'normal focus is exclusive by default');
  commands.length = 0;
  controller.receiveMidiInput({ sourceId: 'minilab-port', raw: [0x90, 62, 100] });
  assert.deepEqual(commands.filter((item) => item.type === 'liveMidi').map((item) => item.chainId), ['vst-002']);

  controller.receiveMidiInput({ sourceId: 'minilab-port', raw: [0x80, 62, 0] });
  controller.setTrackArmed(first.id, true, { additive: true });
  commands.length = 0;
  controller.receiveMidiInput({ sourceId: 'minilab-port', raw: [0x90, 64, 100] });
  assert.deepEqual(commands.filter((item) => item.type === 'liveMidi').map((item) => item.chainId).sort(),
    ['vst-001', 'vst-002'], 'Ctrl/Meta/Shift arm explicitly enables multi-destination monitoring');
});

test('record readiness explains each missing step instead of silently disabling Record', () => {
  const { controller, hub, commands } = rig();
  assert.match(controller.recordBlockReason(), /Add at least one MIDI or audio track/);
  const track = controller.model.addTrack('midi');
  assert.match(controller.recordBlockReason(), /Arm at least one track/);
  controller.setTrack(track.id, { armed: true });
  assert.match(controller.recordBlockReason(), /No MIDI input is detected or selected/);
  hub.midi.selectedInputId = 'selected-midi';
  assert.match(controller.recordBlockReason(), /Choose the detected MIDI port/);
  controller.setTrack(track.id, { inputId: 'selected-midi' });
  assert.match(controller.recordBlockReason(), /Connect MiniLab 3 MIDI OUT/);
  hub.graph.connect('minilab-3', 'midi-out', 'sequencer', 'midi-in');
  assert.equal(controller.recordBlockReason(), '');
  assert.equal(controller.startRecording(), true);
  assert.equal(commands.some((command) => command.type === 'record' && command.enabled), true);
});

test('enabled metronome enters one native pre-count without starting a second transport', () => {
  const { controller, hub, commands } = rig({ metronomeEnabled: true });
  const track = controller.model.addTrack('midi');
  hub.midi.selectedInputId = 'selected-midi';
  controller.setTrack(track.id, { armed: true, inputId: 'selected-midi' });
  hub.graph.connect('minilab-3', 'midi-out', 'sequencer', 'midi-in');
  commands.length = 0;

  assert.equal(controller.startRecording(), true);
  assert.equal(controller.preCounting, true);
  assert.equal(controller.recording, true);
  assert.equal(controller.playing, true);
  assert.deepEqual(commands.filter((command) => command.type === 'record'), [
    { type: 'record', enabled: true }
  ]);
  assert.equal(commands.some((command) => command.type === 'setTransport' && command.playing === true), false,
    'native record command owns the pre-count and then resumes the one live transport');

  hub.events.emit('engine:transport', {
    bpm: 120, playing: false, recording: false, preCount: true,
    preCountBeat: 2, preCountBeats: 4, ppqPosition: 0
  });
  assert.equal(controller.preCounting, true);
  assert.equal(controller.playing, true, 'pre-count is presented as an active transport phase');
  hub.events.emit('engine:transport', {
    bpm: 120, playing: true, recording: true, preCount: false,
    preCountBeat: 3, preCountBeats: 4, ppqPosition: 0
  });
  assert.equal(controller.preCounting, false);
  assert.equal(controller.recording, true);
  assert.equal(controller.playing, true);
});

test('audio source selection creates and cleans the authoritative AUDIO IN cable', async () => {
  const { controller, hub, commands } = rig();
  const first = controller.model.addTrack('audio');
  const second = controller.model.addTrack('audio');
  controller.setTrack(first.id, { inputId: 'audio-input' });
  controller.setTrack(second.id, { inputId: 'audio-input' });
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.deepEqual(hub.graph.connectionsTo('sequencer', 'audio-in').map((connection) => connection.from),
    [{ nodeId: 'audio-input', portId: 'audio-out' }], 'shared source owns one visible cable');
  assert.equal(commands.filter((command) => command.type === 'syncSequencer').at(-1).project.tracks
    .find((track) => track.id === first.id).inputId, 'audio-input');

  controller.removeTrack(first.id);
  assert.equal(hub.graph.connectionsTo('sequencer', 'audio-in').length, 1,
    'the cable stays while another track uses the source');
  controller.removeTrack(second.id);
  assert.equal(hub.graph.connectionsTo('sequencer', 'audio-in').length, 0,
    'deleting the final owner removes the obsolete cable');
});

test('audio track selectors refuse feedback routes in both directions', () => {
  const first = rig();
  const outputFirst = first.controller.model.addTrack('audio');
  first.controller.setTrack(outputFirst.id, { outputId: 'vst-001' });
  const rejectedInput = first.controller.model.addTrack('audio');
  first.controller.setTrack(rejectedInput.id, { inputId: 'vst-001' });
  assert.equal(first.hub.graph.connectionsTo('sequencer', 'audio-in').length, 0,
    'a Sequencer destination cannot be selected back as its source');

  const second = rig();
  const inputFirst = second.controller.model.addTrack('audio');
  second.controller.setTrack(inputFirst.id, { inputId: 'vst-001' });
  second.controller.setTrack(inputFirst.id, { outputId: 'vst-001' });
  assert.equal(second.hub.graph.connectionsFrom('sequencer', 'audio-out').length, 0,
    'a Sequencer source cannot also become its destination');
});

test('MIDI track selects the existing hardware-output node and synchronizes the selected OS port', async () => {
  const { controller, hub, commands } = rig();
  const track = controller.model.addTrack('midi');
  hub.graph.connect('minilab-3', 'midi-out', 'sequencer', 'midi-in');
  controller.setTrack(track.id, { outputId: 'minilab-3' });
  hub.midi.selectedOutputId = 'system-midi-out';
  hub.midi.getOutput = (id) => id === 'system-midi-out' ? { id, name: 'System MIDI Out' } : null;
  hub.events.emit('engine:state', { state: 'running' });
  await new Promise((resolve) => queueMicrotask(resolve));

  const route = hub.graph.connectionsFrom('sequencer', 'midi-out').find((connection) => connection.to.nodeId === 'minilab-3');
  const sync = commands.filter((command) => command.type === 'syncSequencer').at(-1);
  assert.ok(route);
  assert.equal(hub.graph.connectionsTo('sequencer', 'midi-in').length, 1,
    'hardware source input cable coexists with hardware destination cable');
  assert.equal(sync.project.tracks.find((item) => item.id === track.id).outputKind, 'midi-output');
  assert.deepEqual(commands.filter((command) => command.type === 'selectMidiOutput').at(-1), {
    type: 'selectMidiOutput', device: { identifier: 'system-midi-out', name: 'System MIDI Out' }
  });
});

test('MIDI track input is native-active only for the selected WebMIDI port and a real cable', async () => {
  const { controller, hub, commands } = rig();
  const track = controller.model.addTrack('midi');
  controller.model.updateTrack(track.id, { armed: true, inputId: 'selected-midi' });
  hub.graph.connect('minilab-3', 'midi-out', 'sequencer', 'midi-in');
  hub.midi.selectedInputId = 'other-midi';
  controller.changed();
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.equal(commands.filter((command) => command.type === 'syncSequencer').at(-1).project.tracks[0].inputId, '');
  assert.equal(controller.startRecording(), false);

  hub.midi.selectedInputId = 'selected-midi';
  controller.changed();
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.equal(commands.filter((command) => command.type === 'syncSequencer').at(-1).project.tracks[0].inputId, 'selected-midi');
  assert.equal(controller.startRecording(), true);
  controller.stopRecording();
});

test('Record cannot start while a project replacement owns the transition lock', () => {
  const { controller, hub, commands } = rig();
  const track = controller.model.addTrack('midi');
  controller.model.updateTrack(track.id, { armed: true, inputId: 'selected-midi' });
  hub.midi.selectedInputId = 'selected-midi';
  hub.graph.connect('minilab-3', 'midi-out', 'sequencer', 'midi-in');
  hub.project = { _transitionPending: true };
  const oldAlert = globalThis.alert;
  const messages = [];
  Object.defineProperty(globalThis, 'alert', { configurable: true, value: (message) => messages.push(message) });
  try {
    assert.equal(controller.startRecording({ notify: true }), false);
  } finally {
    if (oldAlert === undefined) delete globalThis.alert;
    else Object.defineProperty(globalThis, 'alert', { configurable: true, value: oldAlert });
  }
  assert.equal(commands.some((command) => command.type === 'record'), false);
  assert.match(messages[0], /changing project/);
});

test('a rogue MIDI cable cannot impersonate the canonical MiniLab recording ingress', async () => {
  const { controller, hub, commands } = rig();
  hub.graph.addNode({
    id: 'rogue-arp', type: 'arpeggiator', inputs: [],
    outputs: [{ id: 'midi-out', type: 'midi' }]
  });
  hub.midi.selectedInputId = 'selected-midi';
  const track = controller.model.addTrack('midi');
  controller.model.updateTrack(track.id, { armed: true, inputId: 'selected-midi' });
  hub.graph.connect('rogue-arp', 'midi-out', 'sequencer', 'midi-in');
  controller.changed();
  await new Promise((resolve) => queueMicrotask(resolve));
  const native = commands.filter((command) => command.type === 'syncSequencer').at(-1);
  assert.equal(native.project.tracks.find((item) => item.id === track.id).inputId, '');
  assert.equal(controller.startRecording(), false,
    'record remains gated until minilab-3.midi-out is visibly connected');
});

test('changing or deleting the last track destination removes only its obsolete route', () => {
  const { controller, hub } = rig(); const first = controller.model.addTrack('midi'); const second = controller.model.addTrack('midi');
  controller.setTrack(first.id, { outputId: 'vst-001' }); controller.setTrack(second.id, { outputId: 'vst-001' });
  controller.setTrack(first.id, { outputId: '' });
  assert.equal(hub.graph.connectionsFrom('sequencer', 'midi-out').length, 1, 'shared route remains for the second track');
  controller.removeTrack(second.id);
  assert.equal(hub.graph.connectionsFrom('sequencer', 'midi-out').length, 0, 'last owner removes the stale cable');
});

test('real native MIDI recording result becomes an editable clip', async () => {
  const { controller, hub } = rig(); const track = controller.model.addTrack('midi'); controller.setTrack(track.id, { armed: true, inputId: 'minilab-midi' });
  hub.events.emit('engine:sequencerMidiRecorded', { trackId: track.id, startPpq: 4, endPpq: 6, events: [
    { pitch: 61, startPpq: 4.25, durationPpq: .75, velocity: 87, channel: 3 }
  ] });
  const clip = track.clips[0]; assert.equal(clip.startPpq, 4); assert.equal(clip.lengthPpq, 2);
  assert.deepEqual([clip.notes[0].pitch, clip.notes[0].startPpq, clip.notes[0].durationPpq, clip.notes[0].velocity, clip.notes[0].channel], [61,.25,.75,87,3]);
});

test('real native audio take is committed and automatically becomes a clip', async () => {
  const { controller, hub } = rig({ transportBpm: 120 }); const track = controller.model.addTrack('audio');
  hub.events.emit('engine:sequencerAudioRecorded', { trackId: track.id, filePath: 'C:\\temp\\take.wav', startPpq: 2, durationSeconds: 1.5, bpm: 120 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(track.clips.length, 1); assert.match(track.clips[0].filePath, /takes/); assert.equal(track.clips[0].lengthPpq, 3);
});

test('native missing-media status remains visible on the matching audio clip', () => {
  const { controller } = rig();
  const track = controller.model.addTrack('audio');
  const clip = controller.model.addAudioClip(track.id, {
    filePath: 'C:\\missing\\take.wav', durationSeconds: 2, trimEndSeconds: 2, lengthPpq: 4
  });
  controller._acceptAudioInfo({ clipId: clip.id, available: false, message: 'Audio file is missing' });
  assert.equal(clip.mediaAvailable, false);
  assert.equal(clip.mediaError, 'Audio file is missing');
});

test('record, compensated MIDI input, panic and master export use native commands', async () => {
  const { controller, hub, commands } = rig(); const track = controller.model.addTrack('midi'); controller.setTrack(track.id, { armed: true, inputId: 'in-1' });
  hub.midi.selectedInputId = 'in-1';
  assert.equal(controller.startRecording(), false, 'an armed selection without a cable cannot start recording');
  hub.events.emit('midi:inputMessage', { sourceId: 'in-1', raw: [0x91, 64, 111], offsetMs: -12 });
  assert.equal(commands.some((command) => command.type === 'midiInput'), false, 'legacy renderer event is not a hidden recording route');
  hub.graph.connect('minilab-3', 'midi-out', 'sequencer', 'midi-in');
  assert.equal(controller.startRecording(), true);
  hub.graph.emitData('minilab-3', 'midi-out', { sourceId: 'in-1', raw: [0x91, 64, 111], offsetMs: -12 });
  hub.events.emit('midi:panic'); controller.stopRecording(); await controller.exportMaster('full', { tailSeconds: 3, bits: 32 });
  assert.ok(commands.some((command) => command.type === 'record' && command.enabled));
  assert.ok(commands.some((command) => command.type === 'midiInput' && command.args[2] === -12));
  assert.ok(commands.some((command) => command.type === 'panic'));
  assert.ok(commands.some((command) => command.type === 'export' && command.bits === 32 && command.tailSeconds === 3));
});

test('WAV, MP3 and OGG exports share one native render command with codec-specific options', async () => {
  for (const scenario of [
    { format: 'wav', bits: 16, expected: ['mix.wav', 16, 320, -1] },
    { format: 'mp3', bitrateKbps: 192, expected: ['mix.mp3', 24, 192, -1] },
    { format: 'ogg', qualityIndex: 8, expected: ['mix.ogg', 24, 320, 8] }
  ]) {
    const { controller, commands } = rig();
    assert.equal(await controller.exportMaster('full', scenario), true);
    const command = commands.find((item) => item.type === 'export');
    assert.ok(command.filePath.endsWith(scenario.expected[0]));
    assert.deepEqual(
      [command.format, command.bits, command.bitrateKbps, command.qualityIndex],
      [scenario.format, ...scenario.expected.slice(1)]
    );
  }
});

test('export cancellation targets only the offline export command', async () => {
  const { controller, commands } = rig();
  controller.exporting = true;
  assert.equal(await controller.cancelExport(), true);
  assert.ok(commands.some((command) => command.type === 'cancelExport'));
  assert.equal(controller.playing, false, 'cancel does not fabricate a live transport transition');
});

test('export rejection clears Rendering state and reports a visible error', async () => {
  const { controller, hub } = rig();
  const statuses = [];
  hub.events.on('sequencer:export', (status) => statuses.push(status));
  hub.engine.sequencerExport = async () => ({ ok: false, reason: 'engine-not-started' });
  assert.equal(await controller.exportMaster('full'), false);
  assert.equal(controller.exporting, false);
  assert.deepEqual(statuses, [
    {
      state: 'preparing', stage: 'START', filePath: 'C:\\audio\\mix.wav',
      startPpq: 0, endPpq: 4
    },
    { state: 'error', filePath: 'C:\\audio\\mix.wav', message: 'engine-not-started' }
  ]);
});

test('native export progress keeps the UI active and a terminal event always clears it', () => {
  const { controller, hub } = rig();
  hub.events.emit('engine:sequencerExport', {
    state: 'preparing', stage: 'prepare-vst', filePath: 'C:\\audio\\mix.wav'
  });
  assert.equal(controller.exporting, true);
  hub.events.emit('engine:sequencerExport', {
    state: 'progress', stage: 'progress', progress: 0.5, frames: 24000, targetFrames: 48000
  });
  assert.equal(controller.exporting, true, 'progress is an active state, not a false terminal');
  hub.events.emit('engine:sequencerExport', {
    state: 'complete', stage: 'DONE', filePath: 'C:\\audio\\mix.wav'
  });
  assert.equal(controller.exporting, false);
  assert.equal(controller._exportWatchdog, null);
});

test('a stalled export is cancelled and returns the UI to an actionable error', async () => {
  const { controller, hub, commands } = rig();
  controller._exportWatchdogTimeoutMs = 10;
  const statuses = [];
  hub.events.on('sequencer:export', (status) => statuses.push(status));
  hub.events.emit('engine:sequencerExport', {
    state: 'started', stage: 'render-blocks', filePath: 'C:\\audio\\stalled.wav'
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(controller.exporting, false);
  assert.ok(commands.some((command) => command.type === 'cancelExport'));
  assert.equal(statuses.at(-1).state, 'error');
  assert.equal(statuses.at(-1).stage, 'watchdog');
});

test('repeated progress telemetry with unchanged frames cannot defeat the export watchdog', async () => {
  const { controller, hub, commands } = rig();
  controller._exportWatchdogTimeoutMs = 25;
  hub.events.emit('engine:sequencerExport', {
    state: 'started', stage: 'render-blocks', filePath: 'C:\\audio\\stalled-telemetry.wav'
  });
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 4));
    hub.events.emit('engine:sequencerExport', {
      state: 'progress', stage: 'progress', frames: 0, targetFrames: 48000,
      filePath: 'C:\\audio\\stalled-telemetry.wav'
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 18));
  assert.equal(controller.exporting, false);
  assert.equal(commands.filter((command) => command.type === 'cancelExport').length, 1);
});

test('real frame advancement extends the export watchdog deadline', async () => {
  const { controller, hub, commands } = rig();
  controller._exportWatchdogTimeoutMs = 24;
  hub.events.emit('engine:sequencerExport', {
    state: 'started', stage: 'render-blocks', filePath: 'C:\\audio\\advancing.wav'
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  hub.events.emit('engine:sequencerExport', {
    state: 'progress', stage: 'progress', frames: 12000, targetFrames: 48000,
    filePath: 'C:\\audio\\advancing.wav'
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(controller.exporting, true, 'advanced frames rearm the inactivity deadline');
  assert.equal(commands.filter((command) => command.type === 'cancelExport').length, 0);
  hub.events.emit('engine:sequencerExport', { state: 'complete', stage: 'DONE' });
});

test('normalization preserves manual-save project fields and rejects corrupt ranges', () => {
  const state = normalizeSequencerState({ tracks: [{ id:'track-1', type:'midi', volume:1, clips:[{id:'clip-1',startPpq:1,lengthPpq:2,notes:[{id:'n',pitch:200,startPpq:-4,durationPpq:0,velocity:0,channel:99}]}] }], loop:{enabled:true,startPpq:8,endPpq:2}, snap:'bad' });
  const note = state.tracks[0].clips[0].notes[0]; assert.deepEqual([note.pitch,note.startPpq,note.velocity,note.channel],[127,0,1,16]);
  assert.equal(state.loop.endPpq, 8.125); assert.equal(state.snap, '1/16');
});

test('manual project state round-trips tracks, clips, notes, audio references, loop and mix', () => {
  const { controller, data } = rig({ transportBpm: 137 }); const midi = controller.model.addTrack('midi'); const audio = controller.model.addTrack('audio');
  controller.model.addMidiClip(midi.id, 3, 5, [{ pitch: 48, startPpq: 1, durationPpq: 2, velocity: 72, channel: 9 }]);
  controller.model.addAudioClip(audio.id, { filePath: 'D:\\audio\\take.wav', startPpq: 8, lengthPpq: 3, trimStartSeconds: .2, trimEndSeconds: 1.7, durationSeconds: 2, gain: .6 });
  controller.model.setLoop({ enabled: true, startPpq: 4, endPpq: 12 }); controller.model.updateTrack(audio.id, { muted: true, volume: .42, inputId: 'audio-input', outputId: 'audio-output' }); controller.changed();
  const restored = new SequencerModel(data.sequencerState).snapshot();
  assert.deepEqual(restored.tracks, controller.model.snapshot().tracks); assert.deepEqual(restored.loop, { enabled: true, startPpq: 4, endPpq: 12 });
  assert.equal(restored.tracks[1].clips[0].filePath, 'D:\\audio\\take.wav'); assert.equal(restored.tracks[1].volume, .42); assert.equal(restored.tracks[1].muted, true);
});
