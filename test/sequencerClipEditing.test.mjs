import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  QUANTIZE_GRIDS, SNAP_STEPS, SequencerModel, TICKS_PER_QUARTER, ppqToTicks, ticksToPpq
} from '../src/renderer/js/core/sequencerModel.js';
import { SequencerController } from '../src/renderer/js/core/sequencerController.js';
import { notesInBox, selectNoteIds } from '../src/renderer/js/core/clipEditorSelection.js';

function controllerRig() {
  const commands = [];
  const data = { transportBpm: 120 };
  const hub = {
    settings: { get: (key) => data[key], set: (key, value) => { data[key] = value; } },
    network: { connectionsTo: () => [], connectionsFrom: () => [], getNode: () => null },
    engine: {
      setTransport: (state) => commands.push({ type: 'transport', ...state }),
      syncSequencer: (state) => commands.push({ type: 'sync', state })
    },
    events: { emit() {} },
    midi: { selectedOutputId: '', getOutput: () => null },
    api: {},
    project: { projectId: 'project-editing', _transitionPending: false }
  };
  const controller = new SequencerController(hub);
  hub.sequencer = controller;
  return { controller, commands, data, hub };
}

test('Start and End navigation seek through authoritative transport state', () => {
  const { controller, commands } = controllerRig();
  const midi = controller.model.addTrack('midi');
  const audio = controller.model.addTrack('audio');
  controller.model.addMidiClip(midi.id, 3, 2);
  controller.model.addAudioClip(audio.id, { startPpq: 9, lengthPpq: 5, durationSeconds: 4, trimEndSeconds: 4 });
  controller.playing = true;

  assert.equal(controller.goToStart(), true);
  assert.equal(commands.at(-1).seekPpq, 0);
  assert.equal(controller.goToEnd(), true);
  assert.equal(commands.at(-1).seekPpq, 14);
  assert.equal(controller.playing, true, 'navigation does not replace Play/Stop state in the renderer');
  assert.ok(commands.every((command) => command.type !== 'transport' || !Object.hasOwn(command, 'playing')),
    'navigation is represented only as an engine seek command');
});

test('End of an empty arrangement is exactly zero', () => {
  const { controller, commands } = controllerRig();
  assert.equal(controller.model.arrangementEndPpq(), 0);
  controller.goToEnd();
  assert.deepEqual(commands.at(-1), { type: 'transport', seekPpq: 0 });
});

test('selection, compatible-track move, rejection of type conversion, and deletion use stable IDs', () => {
  const model = new SequencerModel();
  const midiA = model.addTrack('midi');
  const midiB = model.addTrack('midi');
  const audio = model.addTrack('audio');
  const clip = model.addMidiClip(midiA.id, 1, 4);

  assert.equal(model.selectClip(clip.id), true);
  assert.equal(model.state.selectedClipId, clip.id);
  assert.equal(model.moveClip(clip.id, 2.12, midiB.id), true);
  assert.equal(midiA.clips.length, 0);
  assert.deepEqual(midiB.clips.map((item) => item.id), [clip.id]);
  assert.equal(clip.startPpq, 2);
  assert.equal(model.moveClip(clip.id, 8, audio.id), false);
  assert.deepEqual(midiB.clips.map((item) => item.id), [clip.id], 'failed move never converts or detaches the clip');
  assert.equal(model.removeClip(clip.id), true);
  assert.equal(model.state.selectedClipId, null);
});

test('left and right resize preserve MIDI source data and clamp invalid bounds', () => {
  const model = new SequencerModel();
  const track = model.addTrack('midi');
  const clip = model.addMidiClip(track.id, 4, 4, [
    { pitch: 60, startPpq: 0.5, durationPpq: 1, velocity: 90, channel: 1 },
    { pitch: 64, startPpq: 2, durationPpq: 1, velocity: 91, channel: 1 }
  ]);
  const originalNotes = structuredClone(clip.notes);

  assert.equal(model.resizeClip(clip.id, 5, 'start'), true);
  assert.deepEqual([clip.startPpq, clip.lengthPpq, clip.sourceOffsetPpq], [5, 3, 1]);
  assert.deepEqual(clip.notes, originalNotes, 'left trim changes the playback window, not stored MIDI events');
  assert.equal(model.resizeClip(clip.id, 2, 'end'), true);
  assert.equal(clip.lengthPpq, 2);
  assert.deepEqual(clip.notes, originalNotes, 'right trim is also non-destructive');

  model.resizeClip(clip.id, -100, 'start');
  assert.equal(clip.startPpq, 4, 'left extension cannot precede the available source or timeline');
  model.resizeClip(clip.id, 999, 'start');
  assert.ok(clip.lengthPpq >= 0.25);
  assert.ok(clip.startPpq >= 0);
});

test('audio trim resize maps PPQ to source seconds without corrupting media bounds', () => {
  const model = new SequencerModel();
  const track = model.addTrack('audio');
  const clip = model.addAudioClip(track.id, {
    startPpq: 4, lengthPpq: 4, durationSeconds: 4, trimStartSeconds: 0, trimEndSeconds: 4
  });
  model.resizeClip(clip.id, 5, 'start', { bpm: 120 });
  assert.deepEqual([clip.startPpq, clip.lengthPpq, clip.trimStartSeconds], [5, 3, 0.5]);
  model.resizeClip(clip.id, 2, 'end', { bpm: 120 });
  assert.deepEqual([clip.lengthPpq, clip.trimEndSeconds], [2, 1.5]);
  assert.ok(clip.trimEndSeconds > clip.trimStartSeconds);
});

test('manipulated clip bounds survive canonical snapshot save/load', () => {
  const model = new SequencerModel();
  const first = model.addTrack('midi');
  const second = model.addTrack('midi');
  const clip = model.addMidiClip(first.id, 1, 6, [{ pitch: 72, startPpq: 2, durationPpq: 1, velocity: 80, channel: 2 }]);
  model.moveClip(clip.id, 4, second.id);
  model.resizeClip(clip.id, 5, 'start');
  model.resizeClip(clip.id, 1.5, 'end');

  const serialized = JSON.stringify(model.snapshot());
  const restored = new SequencerModel(JSON.parse(serialized));
  const found = restored._clip(clip.id);
  assert.ok(found);
  assert.equal(found.track.id, second.id);
  assert.deepEqual(
    [found.clip.startPpq, found.clip.lengthPpq, found.clip.sourceOffsetPpq, found.clip.notes[0].id],
    [5, 1.5, 1, clip.notes[0].id]
  );
});

test('every quantization grid lands on exact canonical ticks at 100 percent', () => {
  assert.deepEqual(QUANTIZE_GRIDS, {
    '1 bar': 3840, '1/2': 1920, '1/4': 960, '1/8': 480, '1/16': 240, '1/32': 120,
    '1/8 triplet': 320, '1/16 triplet': 160
  });
  for (const division of Object.keys(SNAP_STEPS)) {
    assert.ok(Object.hasOwn(QUANTIZE_GRIDS, division),
      `Snap offers ${division}, so "Quantize to ${division}" has to mean something`);
  }
  for (const [grid, step] of Object.entries(QUANTIZE_GRIDS)) {
    const model = new SequencerModel();
    const track = model.addTrack('midi');
    const originalTick = step + Math.round(step * 0.4);
    const clip = model.addMidiClip(track.id, 0, 8, [{
      pitch: 60, startPpq: ticksToPpq(originalTick), durationPpq: 0.5, velocity: 77, channel: 3
    }]);
    assert.equal(model.quantizeMidiClip(clip.id, { grid, strength: 100 }), 1);
    assert.equal(ppqToTicks(clip.notes[0].startPpq), step, `${grid} target`);
    assert.deepEqual([clip.notes[0].velocity, clip.notes[0].channel], [77, 3]);
  }
  assert.equal(TICKS_PER_QUARTER, 960);
});

test('quantization strength, scope, and timing modes have exact deterministic ticks', () => {
  const make = () => {
    const model = new SequencerModel();
    const track = model.addTrack('midi');
    const clip = model.addMidiClip(track.id, 0, 4, [
      { id: 'ignored-by-normalizer', pitch: 60, startPpq: ticksToPpq(300), durationPpq: ticksToPpq(300), velocity: 70, channel: 1 },
      { pitch: 64, startPpq: ticksToPpq(330), durationPpq: 0.333333333, velocity: 71, channel: 1 }
    ]);
    return { model, clip };
  };

  {
    const { model, clip } = make();
    model.quantizeMidiClip(clip.id, { grid: '1/4', strength: 50, scope: 'selected', selectedNoteIds: [clip.notes[0].id] });
    assert.equal(ppqToTicks(clip.notes[0].startPpq), 150);
    assert.equal(ppqToTicks(clip.notes[1].startPpq), 330);
  }
  {
    const { model, clip } = make();
    clip.notes[0].startPpq = 0.3000004;
    const exact = JSON.stringify(model.snapshot());
    model.quantizeMidiClip(clip.id, { grid: '1/4', strength: 0 });
    assert.equal(JSON.stringify(model.snapshot()), exact, '0% is an exact no-op even for off-tick recorded timing');
  }
  {
    const { model, clip } = make();
    const noteId = clip.notes[1].id;
    const duration = clip.notes[1].durationPpq;
    model.quantizeMidiClip(clip.id, { grid: '1/16', strength: 100, scope: 'selected', selectedNoteIds: [noteId], timing: 'starts' });
    const note = clip.notes.find((item) => item.id === noteId);
    assert.equal(ppqToTicks(note.startPpq), 240);
    assert.equal(note.durationPpq, duration, 'starts-only preserves the exact stored duration, not just its rounded tick count');
  }
  {
    const { model, clip } = make();
    const noteId = clip.notes[1].id;
    model.quantizeMidiClip(clip.id, { grid: '1/16', strength: 100, scope: 'selected', selectedNoteIds: [noteId], timing: 'starts+ends' });
    const note = clip.notes.find((item) => item.id === noteId);
    assert.deepEqual([ppqToTicks(note.startPpq), ppqToTicks(note.durationPpq)], [240, 480]);
    const once = JSON.stringify(model.snapshot());
    model.quantizeMidiClip(clip.id, { grid: '1/16', strength: 100, scope: 'selected', selectedNoteIds: [noteId], timing: 'starts+ends' });
    assert.equal(JSON.stringify(model.snapshot()), once, 're-applying full quantization is deterministic and idempotent');
  }
});

test('quantization safely handles empty selection and clip boundaries', () => {
  const model = new SequencerModel();
  const track = model.addTrack('midi');
  const clip = model.addMidiClip(track.id, 0, 2, [{
    pitch: 60, startPpq: ticksToPpq(1900), durationPpq: ticksToPpq(30), velocity: 90, channel: 1
  }]);
  const before = JSON.stringify(model.snapshot());
  assert.equal(model.quantizeMidiClip(clip.id, { scope: 'selected', selectedNoteIds: [] }), 0);
  assert.equal(JSON.stringify(model.snapshot()), before);
  model.quantizeMidiClip(clip.id, { grid: '1/4', strength: 100, timing: 'starts' });
  const end = ppqToTicks(clip.notes[0].startPpq) + ppqToTicks(clip.notes[0].durationPpq);
  assert.ok(ppqToTicks(clip.notes[0].startPpq) >= 0);
  assert.ok(end <= 2 * TICKS_PER_QUARTER);
  assert.ok(ppqToTicks(clip.notes[0].durationPpq) > 0);
});

test('entire-clip quantization preserves source notes hidden by non-destructive trimming', () => {
  const model = new SequencerModel();
  const track = model.addTrack('midi');
  const clip = model.addMidiClip(track.id, 0, 4, [
    { pitch: 60, startPpq: 0.5, durationPpq: 0.1, velocity: 90, channel: 1 },
    { pitch: 64, startPpq: 1.4, durationPpq: 0.25, velocity: 91, channel: 1 }
  ]);
  const hiddenId = clip.notes[0].id;
  model.resizeClip(clip.id, 1, 'start');
  assert.equal(clip.sourceOffsetPpq, 1);
  assert.equal(model.quantizeMidiClip(clip.id, { grid: '1/4', strength: 100, scope: 'entire' }), 1);
  assert.equal(clip.notes.find((note) => note.id === hiddenId).startPpq, 0.5,
    'a fully trimmed-out source event is not clamped into the visible window');
  model.resizeClip(clip.id, 0, 'start');
  assert.equal(clip.notes.find((note) => note.id === hiddenId).startPpq, 0.5,
    'extending the clip reveals the original hidden timing');
});

test('quantization preserves the hidden onset of a note crossing the left trim boundary', () => {
  for (const timing of ['starts', 'starts+ends']) {
    const model = new SequencerModel();
    const track = model.addTrack('midi');
    const clip = model.addMidiClip(track.id, 0, 4, [
      { pitch: 60, startPpq: 0.5, durationPpq: 1, velocity: 90, channel: 1 }
    ]);
    model.resizeClip(clip.id, 1, 'start');
    const applied = model.quantizeMidiClip(clip.id, { grid: '1/4', strength: 100, scope: 'entire', timing });
    assert.equal(clip.notes[0].startPpq, 0.5, `${timing} preserves the trimmed-out onset`);
    assert.equal(applied, timing === 'starts' ? 0 : 1,
      'starts+ends may quantize only the visible end endpoint');
    model.resizeClip(clip.id, 0, 'start');
    assert.equal(clip.notes[0].startPpq, 0.5, `${timing} re-extension recovers the onset`);
  }
});

test('Clip Editor additive note selection retains earlier notes and supports toggling', () => {
  let selected = selectNoteIds(new Set(), 'a');
  selected = selectNoteIds(selected, 'b', { additive: true });
  assert.deepEqual([...selected], ['a', 'b']);
  selected = selectNoteIds(selected, 'b', { additive: true });
  assert.deepEqual([...selected], ['a']);
  selected = selectNoteIds(selected, 'c');
  assert.deepEqual([...selected], ['c']);
});

test('Clip Editor operations mutate the same canonical project state and reject stale/deleted clips', () => {
  const { controller, hub } = controllerRig();
  const midi = controller.model.addTrack('midi');
  const audio = controller.model.addTrack('audio');
  const midiClip = controller.model.addMidiClip(midi.id, 0, 4, [{ pitch: 60, startPpq: 0.3, durationPpq: 0.5, velocity: 90, channel: 1 }]);
  const audioClip = controller.model.addAudioClip(audio.id, { startPpq: 0, lengthPpq: 2, durationSeconds: 2, trimEndSeconds: 2 });

  assert.equal(controller.clipEditorState(midiClip.id).track.type, 'midi');
  assert.equal(controller.clipEditorState(audioClip.id).track.type, 'audio');
  const response = controller.handleClipEditorRequest({
    kind: 'update', clipId: midiClip.id, expectedProjectId: hub.project.projectId,
    operation: 'quantize', payload: { grid: '1/16', strength: 100, scope: 'entire', timing: 'starts' }
  });
  assert.equal(response.ok, true);
  assert.equal(ppqToTicks(controller.model._clip(midiClip.id).clip.notes[0].startPpq), 240);
  assert.equal(ppqToTicks(JSON.parse(JSON.stringify(controller.model.snapshot())).tracks[0].clips[0].notes[0].startPpq), 240,
    'the immediately serializable project state contains the editor mutation');

  assert.equal(controller.handleClipEditorRequest({
    kind: 'update', clipId: midiClip.id, expectedProjectId: 'different-project', operation: 'delete-notes', payload: { noteIds: [] }
  }).reason, 'stale-project');
  controller.model.removeClip(midiClip.id);
  assert.equal(controller.handleClipEditorRequest({ kind: 'get', clipId: midiClip.id }).reason, 'clip-not-found');
});

test('Clip Editor transport commands control and reflect the one Sequencer/native transport', async () => {
  const { controller, commands, hub } = controllerRig();
  const published = [];
  hub.api.clipEditorPublishTransport = async (state) => { published.push(structuredClone(state)); return true; };
  const track = controller.model.addTrack('midi');
  const clip = controller.model.addMidiClip(track.id, 0, 8, [
    { pitch: 60, startPpq: 0, durationPpq: 1, velocity: 100, channel: 1 }
  ]);
  const request = (operation) => controller.handleClipEditorRequest({
    kind: 'transport', clipId: clip.id, expectedProjectId: hub.project.projectId, operation
  });

  assert.equal(request('play').ok, true);
  assert.equal(controller.playing, true);
  assert.deepEqual(commands.at(-1), { type: 'transport', playing: true });
  controller.playheadPpq = 3.5;
  const returned = request('return-start');
  assert.equal(returned.transport.ppqPosition, 0);
  assert.equal(controller.playing, true, 'Return to Start does not create a second stop/reset semantic');
  assert.deepEqual(commands.at(-1), { type: 'transport', seekPpq: 0 });
  assert.equal(request('stop').ok, true);
  assert.equal(controller.playing, false);
  assert.deepEqual(commands.at(-1), { type: 'transport', playing: false });
  assert.equal(request('independent-clock').reason, 'unsupported-request');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(published.at(-1), {
    ppqPosition: 0, playing: false, recording: false, bpm: 120
  });
});

test('very short audio edits retain one live, saved, native, and End length invariant', () => {
  const { controller, hub } = controllerRig();
  const track = controller.model.addTrack('audio');
  const clip = controller.model.addAudioClip(track.id, {
    startPpq: 2, lengthPpq: 2, durationSeconds: 1, trimStartSeconds: 0, trimEndSeconds: 1
  });
  const response = controller.handleClipEditorRequest({
    kind: 'update', clipId: clip.id, expectedProjectId: hub.project.projectId,
    operation: 'update-audio', payload: { trimEndSeconds: 0.05 }
  });
  const saved = controller.model.snapshot().tracks[0].clips[0];
  assert.equal(response.state.clip.lengthPpq, 0.125);
  assert.equal(clip.lengthPpq, saved.lengthPpq);
  assert.equal(controller.model.arrangementEndPpq(), 2.125);
});

test('recording callbacks cannot cross a committed transition and replay after an aborted one', async () => {
  {
    const { controller, hub } = controllerRig();
    const track = controller.model.addTrack('audio');
    let release;
    hub.api.audioCommitTake = () => new Promise((resolve) => { release = resolve; });
    const pending = controller._acceptAudioRecording({
      trackId: track.id, filePath: 'C:/temp/old.wav', startPpq: 0, durationSeconds: 1, bpm: 120
    });
    controller.beginProjectTransition();
    controller.finishProjectTransition(true);
    release({ ok: true, filePath: 'C:/takes/old.wav' });
    await pending;
    assert.equal(track.clips.length, 0, 'a delayed old-project commit is dropped after handoff commits');
  }
  {
    const { controller, hub } = controllerRig();
    const track = controller.model.addTrack('audio');
    let release;
    hub.api.audioCommitTake = () => new Promise((resolve) => { release = resolve; });
    const pending = controller._acceptAudioRecording({
      trackId: track.id, filePath: 'C:/temp/kept.wav', startPpq: 0, durationSeconds: 1, bpm: 120
    });
    controller.beginProjectTransition();
    controller.finishProjectTransition(false);
    release({ ok: true, filePath: 'C:/takes/kept.wav' });
    await pending;
    assert.equal(track.clips.length, 1, 'an aborted handoff retains its in-flight take in the same project');
  }
  {
    const { controller } = controllerRig();
    const track = controller.model.addTrack('midi');
    const message = { trackId: track.id, startPpq: 0, endPpq: 1, events: [
      { pitch: 60, startPpq: 0, durationPpq: 0.5, velocity: 100, channel: 1 }
    ] };
    controller.beginProjectTransition();
    controller._acceptMidiRecording(message);
    assert.equal(track.clips.length, 0);
    controller.finishProjectTransition(false);
    assert.equal(track.clips.length, 1, 'a quiesce-generated take is replayed if the transition aborts');
  }
});

test('Clip Editor open is refused while project replacement owns the transition', () => {
  const { controller, hub } = controllerRig();
  const opened = [];
  hub.api.clipEditorOpen = (id) => opened.push(id);
  const track = controller.model.addTrack('midi');
  const clip = controller.model.addMidiClip(track.id, 0, 4);
  hub.project._transitionPending = true;
  assert.equal(controller.openClipEditor(clip.id), false);
  assert.deepEqual(opened, []);
  hub.project._transitionPending = false;
  assert.equal(controller.openClipEditor(clip.id), true);
  assert.deepEqual(opened, [clip.id]);
});

test('dedicated editor assets separate MIDI Piano Roll from audio controls and main arrangement', () => {
  const editorSource = fs.readFileSync(new URL('../src/renderer/js/clipEditor.js', import.meta.url), 'utf8');
  const mainSource = fs.readFileSync(new URL('../src/renderer/js/modules/sequencer/sequencerModule.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../src/renderer/styles/base.css', import.meta.url), 'utf8');
  assert.match(editorSource, /type === 'midi' \? midiMarkup\(current\) : audioMarkup\(current\)/);
  assert.match(editorSource, /aria-label="Piano Roll"/);
  assert.match(editorSource, /aria-label="Sequencer transport"/);
  assert.match(editorSource, /data-transport-action="return-start"/);
  assert.match(editorSource, /data-transport-action="play"/);
  assert.match(editorSource, /data-transport-action="stop"/);
  assert.match(editorSource, /data-clip-playhead/);
  assert.match(editorSource, /onTransportState/);
  assert.doesNotMatch(editorSource, /setInterval|independent-clock/);
  assert.doesNotMatch(audioMarkupSource(editorSource), /Piano Roll|clip-piano-grid/);
  assert.match(mainSource, /addEventListener\('dblclick',[\s\S]*openClipEditor\(element\.dataset\.clipId\)/);
  assert.doesNotMatch(mainSource, /data-clip-editor|Piano Roll|clip-piano-grid/);
  assert.match(mainSource, /new globalThis\.ResizeObserver\(resizeRender\)/);
  assert.match(mainSource, /note\.startPpq \+ note\.durationPpq > sourceOffset/);
  assert.match(editorSource, /setPointerCapture\?\.\(event\.pointerId\)/);
  assert.match(editorSource, /addEventListener\('pointercancel', pointerCancel/);
  assert.match(editorSource, /addEventListener\('blur', pointerCancel\)/);
  assert.match(css, /\.content\.sequencer-workspace \{ padding:0; overflow:hidden; \}/);
  assert.match(css, /\.sequencer-page \{[^}]*width:100%; height:100%/);
  assert.match(css, /\.seq-scroll \{[^}]*width:100%; height:100%/);
});

function audioMarkupSource(source) {
  return source.slice(source.indexOf('function audioMarkup'), source.indexOf('function render'));
}

test('a note selection moves as one group, and the clip window reduces the delta for all of it', () => {
  const { controller } = controllerRig();
  const track = controller.model.addTrack('midi');
  const clip = controller.model.addMidiClip(track.id, 0, 4, [
    { pitch: 60, startPpq: 0, durationPpq: 1, velocity: 100, channel: 1 },
    { pitch: 64, startPpq: 1, durationPpq: 1, velocity: 100, channel: 1 },
    { pitch: 67, startPpq: 2, durationPpq: 1, velocity: 100, channel: 1 }
  ]);
  const ids = clip.notes.map((note) => note.id);

  assert.equal(controller.model.moveMidiNotes(clip.id, ids, { deltaPpq: 0.5, deltaPitch: 12 }), 3);
  assert.deepEqual(clip.notes.map((note) => [note.startPpq, note.pitch]),
    [[0.5, 72], [1.5, 76], [2.5, 79]], 'one common delta keeps the chord shape');

  // Pushed against the end of the clip: the group stops together. Clamping
  // note by note would let the first two keep going and flatten the chord.
  controller.model.moveMidiNotes(clip.id, ids, { deltaPpq: 40 });
  const starts = clip.notes.map((note) => note.startPpq);
  assert.equal(Math.max(...starts) < clip.sourceOffsetPpq + clip.lengthPpq, true);
  assert.deepEqual(starts.map((start) => Number((start - starts[0]).toFixed(5))), [0, 1, 2],
    'the intervals between the notes survive the wall');

  controller.model.moveMidiNotes(clip.id, ids, { deltaPitch: 400 });
  assert.deepEqual(clip.notes.map((note) => note.pitch), [120, 124, 127],
    'the highest note reaches 127 and the group stops there');

  assert.equal(controller.model.moveMidiNotes(clip.id, ['no-such-note'], { deltaPpq: 1 }), 0,
    'an unknown id moves nothing rather than moving everything');
});

test('the note drag preview and the model agree, because they share one clamp', async () => {
  const { clampNoteGroupDelta } = await import('../src/renderer/js/core/sequencerModel.js');
  const { controller } = controllerRig();
  const track = controller.model.addTrack('midi');
  const clip = controller.model.addMidiClip(track.id, 0, 4, [
    { pitch: 60, startPpq: 1, durationPpq: 1, velocity: 100, channel: 1 },
    { pitch: 72, startPpq: 2, durationPpq: 1, velocity: 100, channel: 1 }
  ]);
  const ids = clip.notes.map((note) => note.id);
  const origins = clip.notes.map((note) => ({ startPpq: note.startPpq, pitch: note.pitch, durationPpq: note.durationPpq }));
  const window = { lowerPpq: clip.sourceOffsetPpq, upperPpq: clip.sourceOffsetPpq + clip.lengthPpq };
  const request = { deltaPpq: 9, deltaPitch: 90 };

  // What the Clip Editor draws under the cursor, in its own window.
  const preview = clampNoteGroupDelta(origins, window, request);
  // What the model does when the gesture ends, in the main window.
  controller.model.moveMidiNotes(clip.id, ids, request);

  assert.deepEqual(clip.notes.map((note) => [note.startPpq, note.pitch]),
    origins.map((origin) => [origin.startPpq + preview.deltaPpq, origin.pitch + preview.deltaPitch]),
    'the drawn position is the committed position -- this is the jump that used to happen on release');
});

test('a note is resized by either edge, and the group keeps a legal length', () => {
  const { controller } = controllerRig();
  const track = controller.model.addTrack('midi');
  const clip = controller.model.addMidiClip(track.id, 0, 4, [
    { pitch: 60, startPpq: 1, durationPpq: 1, velocity: 100, channel: 1 }
  ]);
  const [note] = clip.notes;

  controller.model.moveMidiNotes(clip.id, [note.id], { deltaDurationPpq: 0.5 });
  assert.equal(note.durationPpq, 1.5, 'the end edge lengthens the note');

  controller.model.moveMidiNotes(clip.id, [note.id], { deltaPpq: 0.5, deltaDurationPpq: -0.5 });
  assert.deepEqual([note.startPpq, note.durationPpq], [1.5, 1],
    'the start edge moves the start and pays for it in duration');

  controller.model.moveMidiNotes(clip.id, [note.id], { deltaDurationPpq: -99 });
  assert.equal(note.durationPpq > 0, true, 'a note never collapses to nothing');

  controller.model.moveMidiNotes(clip.id, [note.id], { deltaDurationPpq: 99 });
  assert.equal(note.startPpq + note.durationPpq, clip.sourceOffsetPpq + clip.lengthPpq,
    'and never grows past the visible clip');
});

test('splitting a MIDI clip is lossless: both halves keep the source, and take a window onto it', () => {
  const { controller } = controllerRig();
  const track = controller.model.addTrack('midi');
  const clip = controller.model.addMidiClip(track.id, 4, 8, [
    { pitch: 60, startPpq: 0, durationPpq: 1, velocity: 100, channel: 1 },
    { pitch: 64, startPpq: 3.5, durationPpq: 2, velocity: 100, channel: 1 },
    { pitch: 67, startPpq: 6, durationPpq: 1, velocity: 100, channel: 1 }
  ]);
  controller.playheadPpq = 8;

  const parts = controller.splitClips([clip.id]);
  assert.equal(parts.length, 2);
  const [head, tail] = parts;
  assert.deepEqual([head.startPpq, head.lengthPpq], [4, 4]);
  assert.deepEqual([tail.startPpq, tail.lengthPpq], [8, 4]);
  assert.equal(head.startPpq + head.lengthPpq, tail.startPpq, 'no gap, no overlap');
  assert.deepEqual(controller.model.state.selectedClipIds.sort(), [head.id, tail.id].sort(),
    'both halves are selected');

  // The note at 3.5 straddles the cut at local 4. It is stored WHOLE in both
  // halves; each half shows the part inside its own window. That is what
  // answers the scissor's design question without deciding it.
  assert.equal(head.notes.length, 3, 'the head keeps every note of the source');
  assert.equal(tail.notes.length, 3, 'and so does the tail');
  assert.equal(head.sourceOffsetPpq, 0);
  assert.equal(tail.sourceOffsetPpq, 4, 'the tail reads the source four quarters in');
  assert.equal(tail.sourceLengthPpq >= tail.sourceOffsetPpq + tail.lengthPpq, true);
  assert.equal(new Set([...head.notes, ...tail.notes].map((note) => note.id)).size, 6,
    'the two halves never share a note id');

  // Pull the tail's left edge back out: the straddling note is still entire.
  controller.resizeClip(tail.id, 4, 'start');
  const restored = controller.model._clip(tail.id).clip;
  assert.equal(restored.sourceOffsetPpq, 0, 'a split followed by a rejoin loses nothing');
  assert.equal(restored.notes.length, 3);
});

test('splitting an audio clip moves the trim pair, and a cut outside the clip is refused', () => {
  const { controller } = controllerRig();
  const track = controller.model.addTrack('audio');
  const clip = controller.model.addAudioClip(track.id, {
    filePath: 'D:\audio\take.wav', startPpq: 0, lengthPpq: 8,
    durationSeconds: 4, trimStartSeconds: 0, trimEndSeconds: 4
  });

  // 8 quarters at 120 BPM is 4 seconds; the cut at quarter 4 is 2 seconds in.
  const parts = controller.splitClips([clip.id], 4);
  assert.equal(parts.length, 2);
  const [head, tail] = parts;
  assert.deepEqual([head.trimStartSeconds, head.trimEndSeconds], [0, 2]);
  assert.deepEqual([tail.trimStartSeconds, tail.trimEndSeconds], [2, 4]);
  assert.equal(head.trimEndSeconds, tail.trimStartSeconds, 'the two windows meet exactly');
  assert.equal(tail.filePath, clip.filePath, 'and both point at the same media');
  assert.equal(head.durationSeconds, tail.durationSeconds, 'no sample was moved or copied');

  assert.deepEqual(controller.splitClips([head.id], 0), [], 'a cut on the clip start is refused');
  assert.deepEqual(controller.splitClips([head.id], 99), [], 'and so is one past its end');
  assert.deepEqual(controller.splitClips(['no-such-clip'], 2), [], 'and an unknown id splits nothing');
  assert.equal(controller.model.state.tracks[0].clips.length, 2, 'a refused split adds no clip');
});

test('a clip menu quantizes to the toolbar Snap, and the clipboard reports whether Paste means anything', () => {
  const { controller } = controllerRig();
  const track = controller.model.addTrack('midi');
  controller.model.state.snap = '1/4';
  const clip = controller.model.addMidiClip(track.id, 0, 8, [
    { pitch: 60, startPpq: ticksToPpq(1100), durationPpq: 0.5, velocity: 100, channel: 1 }
  ]);

  assert.equal(controller.hasClipboard(), false, 'nothing copied yet, so Paste is greyed');
  assert.equal(controller.quantizeClips([clip.id], { grid: '1/4', strength: 100 }), 1);
  assert.equal(ppqToTicks(clip.notes[0].startPpq), TICKS_PER_QUARTER,
    'the grid is the Snap value already on screen, not one asked for in a dialog');

  controller.selectClip(clip.id);
  assert.equal(controller.copySelectedClips(), true);
  assert.equal(controller.hasClipboard(), true);
});

test('a rubber band over the piano roll selects by pitch row and by time', () => {
  const notes = [
    { id: 'low', pitch: 48, startPpq: 0, durationPpq: 1 },
    { id: 'mid', pitch: 60, startPpq: 1, durationPpq: 1 },
    { id: 'high', pitch: 72, startPpq: 2, durationPpq: 1 },
    { id: 'long', pitch: 60, startPpq: 0, durationPpq: 8 }
  ];

  assert.deepEqual(notesInBox(notes, { startPpq: 0.5, endPpq: 1.5, fromPitch: 55, toPitch: 65 }),
    ['mid', 'long'], 'inside the band in both dimensions');
  assert.deepEqual(notesInBox(notes, { startPpq: 0.5, endPpq: 1.5, fromPitch: 60, toPitch: 60 }),
    ['mid', 'long'], 'a single row is a legal band: a pitch is a row, not a coordinate');
  assert.deepEqual(notesInBox(notes, { startPpq: 3, endPpq: 9, fromPitch: 40, toPitch: 90 }),
    ['long'], 'a note is caught by any part of itself, not only its start');
  assert.deepEqual(notesInBox(notes, { startPpq: 9, endPpq: 1, fromPitch: 90, toPitch: 40 }).sort(),
    ['high', 'long', 'mid'], 'and the band may be drawn in either direction');
  assert.deepEqual(notesInBox(notes, { startPpq: 0, endPpq: 0, fromPitch: 0, toPitch: 127 }), []);
  assert.deepEqual(notesInBox(undefined, {}), []);
});

test('velocity is set over a selection, notes duplicate after themselves, and Snap belongs to the project', () => {
  const { controller } = controllerRig();
  const track = controller.model.addTrack('midi');
  const clip = controller.model.addMidiClip(track.id, 0, 8, [
    { pitch: 60, startPpq: 0, durationPpq: 1, velocity: 40, channel: 1 },
    { pitch: 64, startPpq: 1, durationPpq: 1, velocity: 90, channel: 1 }
  ]);
  const ids = clip.notes.map((note) => note.id);

  assert.equal(controller.model.setMidiNotes(clip.id, ids, { velocity: 111 }), 2);
  assert.deepEqual(clip.notes.map((note) => note.velocity), [111, 111]);
  controller.model.setMidiNotes(clip.id, ids, { velocity: 999 });
  assert.deepEqual(clip.notes.map((note) => note.velocity), [127, 127], 'and it is clamped to MIDI range');
  assert.equal(controller.model.setMidiNotes(clip.id, ids, { startPpq: 4 }), 2);
  assert.deepEqual(clip.notes.map((note) => note.startPpq), [0, 1],
    'timing is not settable here: that is move-notes, and it is relative');

  // The two notes span 0..2, so the copies land at 2 and 3 -- immediately
  // after the figure rather than at some fixed bar.
  const copies = controller.model.duplicateMidiNotes(clip.id, ids);
  assert.equal(copies.length, 2);
  assert.deepEqual(copies.map((note) => note.startPpq), [2, 3]);
  assert.equal(new Set(clip.notes.map((note) => note.id)).size, 4, 'the copies carry new ids');

  // A copy that would land outside the clip's visible window is not created:
  // the editor could not draw it, so the user could not take it back.
  const late = controller.model.addMidiClip(track.id, 0, 2, [
    { pitch: 60, startPpq: 1.5, durationPpq: 0.5, velocity: 80, channel: 1 }
  ]);
  assert.deepEqual(controller.model.duplicateMidiNotes(late.id, [late.notes[0].id]), []);

  const snapped = controller.handleClipEditorRequest({
    kind: 'update', clipId: clip.id, expectedProjectId: 'project-editing',
    operation: 'set-snap', payload: { snap: '1 bar' }
  });
  assert.equal(snapped.ok, true);
  assert.equal(controller.model.state.snap, '1 bar',
    'one Snap for the project, reachable from the Clip Editor as well as the toolbar');
  assert.equal(snapped.state.snap, '1 bar', 'and the editor is told the new value');
});

test('the Clip Editor can sound a note, and only through the cable the Patch Bay drew', async (t) => {
  const { controller, hub, commands } = controllerRig();
  const track = controller.model.addTrack('midi');
  const clip = controller.model.addMidiClip(track.id, 0, 4, [
    { pitch: 60, startPpq: 0, durationPpq: 1, velocity: 96, channel: 1 }
  ]);
  const routed = [];
  hub.network.emitDataTo = (nodeId, portId, targetId, data) => {
    routed.push({ nodeId, portId, targetId, raw: [...data.raw] });
    return true;
  };

  assert.equal(controller.auditionNote(clip.id, { pitch: 60 }), false,
    'a track with no Destination sounds nothing rather than inventing a route');

  controller.model.updateTrack(track.id, { outputId: 'vst-001' });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  assert.equal(controller.auditionNote(clip.id, { pitch: 64, velocity: 96, durationMs: 300 }), true);
  assert.deepEqual(routed.map((item) => item.raw), [[0x90, 64, 96]], 'note on, at the velocity asked for');
  assert.deepEqual([routed[0].nodeId, routed[0].portId, routed[0].targetId],
    ['sequencer', 'midi-out', 'vst-001'], 'out through the network, like live input');

  // The note-off is scheduled by the controller, never sent by the editor: one
  // that rides on a pointerup is one a closed window can swallow.
  t.mock.timers.tick(299);
  assert.equal(routed.length, 1, 'still held');
  t.mock.timers.tick(2);
  assert.deepEqual(routed.at(-1).raw, [0x80, 64, 0], 'and released on its own');

  routed.length = 0;
  controller.auditionNote(clip.id, { pitch: 70 });
  controller.auditionNote(clip.id, { pitch: 70 });
  assert.deepEqual(routed.map((item) => item.raw), [[0x90, 70, 100], [0x80, 70, 0], [0x90, 70, 100]],
    'a second tap on the same key retriggers instead of stacking two pending note-offs');

  routed.length = 0;
  controller.releaseAuditionNotes();
  assert.deepEqual(routed.map((item) => item.raw), [[0x80, 70, 0]],
    'and a project leaving silences what it left on');
  t.mock.timers.tick(5000);
  assert.equal(routed.length, 1, 'the cancelled timer never fires a second off');

  assert.equal(controller.auditionNote(clip.id, { pitch: 'C' }), false);
  assert.equal(controller.auditionNote('no-such-clip', { pitch: 60 }), false);
  t.mock.timers.reset();
  assert.equal(commands.some((command) => command.type === 'sync'), false,
    'sounding a note is a performance: it writes no state and rebuilds no native plan');
});
