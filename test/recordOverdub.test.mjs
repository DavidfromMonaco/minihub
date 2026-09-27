import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SequencerModel } from '../src/renderer/js/core/sequencerModel.js';
import { SequencerController, normalizeRecordMode } from '../src/renderer/js/core/sequencerController.js';

// Where a clip's notes sound in the arrangement, as [pitch, quarter].
const heard = (clip) => clip.notes
  .filter((note) => note.startPpq >= clip.sourceOffsetPpq && note.startPpq < clip.sourceOffsetPpq + clip.lengthPpq)
  .map((note) => [note.pitch, clip.startPpq + note.startPpq - clip.sourceOffsetPpq]);

function withClip() {
  const model = new SequencerModel();
  const track = model.addTrack('midi');
  const clip = model.addMidiClip(track.id, 4, 4, [{ pitch: 60, startPpq: 0, durationPpq: 1 }, { pitch: 62, startPpq: 2, durationPpq: 1 }]);
  return { model, track, clip };
}

test('an overdub plays its notes into the clip they were played over', () => {
  const { model, track, clip } = withClip();
  const written = model.recordMidiTake(track.id, { startPpq: 4, endPpq: 8, events: [
    { pitch: 64, startPpq: 5, durationPpq: 0.5, velocity: 90, channel: 1 }
  ] });
  assert.deepEqual(written, [clip]);
  assert.equal(track.clips.length, 1, 'no second clip stacked over the first');
  assert.deepEqual(heard(clip), [[60, 4], [64, 5], [62, 6]]);
});

test('round a loop, every pass of an overdub adds up, as on a drum machine', () => {
  const { model, track, clip } = withClip();
  model.recordMidiTake(track.id, { startPpq: 4, endPpq: 8, events: [
    { pitch: 36, startPpq: 4, durationPpq: 0.25, pass: 0 },
    { pitch: 38, startPpq: 5, durationPpq: 0.25, pass: 1 },
    { pitch: 42, startPpq: 4.5, durationPpq: 0.25, pass: 2 }
  ] });
  assert.deepEqual(heard(clip).map(([pitch]) => pitch).sort(), [36, 38, 42, 60, 62]);
});

test('a replace clears what the take went over, and keeps the last pass played', () => {
  const { model, track, clip } = withClip();
  model.recordMidiTake(track.id, { startPpq: 5, endPpq: 8, events: [
    { pitch: 70, startPpq: 5, durationPpq: 0.5, pass: 0 },
    { pitch: 72, startPpq: 7, durationPpq: 0.5, pass: 1 }
  ] }, { mode: 'replace' });
  assert.deepEqual(heard(clip), [[60, 4], [72, 7]], 'the note before the take stays, the one it covered goes, and the first pass with it');
});

test('a note played past a clip stretches it to the bar line, never over the next clip', () => {
  const { model, track, clip } = withClip();
  const next = model.addMidiClip(track.id, 16, 4);
  model.recordMidiTake(track.id, { startPpq: 4, endPpq: 14, events: [
    { pitch: 65, startPpq: 9, durationPpq: 1 },
    { pitch: 67, startPpq: 13, durationPpq: 6 }
  ] });
  assert.equal(clip.startPpq, 4);
  assert.equal(clip.startPpq + clip.lengthPpq, 16, 'stretched to where the next clip starts');
  assert.deepEqual(heard(clip).map(([pitch]) => pitch), [60, 62, 65, 67]);
  assert.equal(clip.notes.find((note) => note.pitch === 67).durationPpq, 3, 'cut where the clip now ends');
  assert.equal(next.notes.length, 0, 'the next clip is left alone');
});

test('a note played just before a clip stretches it back to the bar, the notes staying put', () => {
  const model = new SequencerModel();
  const track = model.addTrack('midi');
  const clip = model.addMidiClip(track.id, 8, 4, [{ pitch: 60, startPpq: 0, durationPpq: 1 }]);
  model.recordMidiTake(track.id, { startPpq: 6, endPpq: 12, events: [{ pitch: 55, startPpq: 7, durationPpq: 0.5 }] });
  assert.equal(clip.startPpq, 4, 'back to the bar the note was played in');
  assert.deepEqual(heard(clip), [[55, 7], [60, 8]]);
});

test('a take over no clip makes one, with its notes where they were played', () => {
  const model = new SequencerModel();
  const track = model.addTrack('midi');
  const [clip] = model.recordMidiTake(track.id, { startPpq: 2.1, endPpq: 6, events: [{ pitch: 60, startPpq: 2.3, durationPpq: 1 }] });
  assert.equal(clip.startPpq, 2, 'on the grid, before the take began');
  assert.deepEqual(heard(clip), [[60, 2.3]]);
});

test('an audio take in Replace mode cuts out the sound it covers, exactly there', () => {
  const model = new SequencerModel();
  const track = model.addTrack('audio');
  const old = model.addAudioClip(track.id, {
    filePath: 'C:/old.wav', startPpq: 0, lengthPpq: 16, durationSeconds: 8, trimStartSeconds: 0, trimEndSeconds: 8,
    fadeIn: { seconds: 0.5 }, fadeOut: { seconds: 1 }
  });
  const take = model.addAudioClip(track.id, { filePath: 'C:/take.wav', startPpq: 4, lengthPpq: 4.2, durationSeconds: 2.1, trimEndSeconds: 2.1 });
  model.clearAudioRange(track.id, take.startPpq, take.startPpq + take.lengthPpq, { bpm: 120, keep: take.id });
  const others = track.clips.filter((clip) => clip !== take).sort((a, b) => a.startPpq - b.startPpq);
  assert.equal(others.length, 2, 'what was before the take, and what was after it');
  const [head, tail] = others;
  assert.equal(head, old);
  assert.deepEqual([head.startPpq, head.lengthPpq, head.trimEndSeconds, head.fadeIn.seconds, head.fadeOut.seconds], [0, 4, 2, 0.5, 0]);
  assert.ok(Math.abs(tail.startPpq - 8.2) < 1e-9 && Math.abs(tail.lengthPpq - 7.8) < 1e-9, 'off the grid, where the take ends');
  assert.ok(Math.abs(tail.trimStartSeconds - 4.1) < 1e-9, 'playing on from the same moment of the sound');
  assert.deepEqual([tail.fadeIn.seconds, tail.fadeOut.seconds], [0, 1]);
});

function rig(recordMode) {
  const data = { transportBpm: 120, recordMode };
  const hub = {
    settings: { get: (key) => data[key], set: (key, value) => { data[key] = value; } },
    network: { connectionsTo: () => [], connectionsFrom: () => [], getNode: () => null },
    engine: { setTransport: () => {}, syncSequencer: () => {}, sequencerRecord: () => {}, sequencerMidiInput: () => {} },
    events: { emit() {}, on() { return () => {}; } }, midi: { selectedOutputId: '', getOutput: () => null },
    api: { audioCommitTake: async (filePath) => ({ ok: true, filePath }) },
    project: { projectId: 'p', _transitionPending: false }
  };
  const controller = new SequencerController(hub);
  controller.load();
  return { controller, data };
}

test('the Record mode is remembered, Overdub unless Replace was chosen, and a take keeps the mode it began in', () => {
  assert.equal(normalizeRecordMode('sideways'), 'overdub');
  const { controller, data } = rig(undefined);
  assert.equal(controller.recordMode, 'overdub');
  const track = controller.model.addTrack('midi');
  controller.model.addMidiClip(track.id, 0, 4, [{ pitch: 60, startPpq: 1, durationPpq: 1 }]);
  controller.setRecordMode('replace');
  assert.equal(data.recordMode, 'replace', 'remembered');
  controller.recordBlockReason = () => '';
  controller.startRecording();
  controller.setRecordMode('overdub'); // for the next take
  controller.stopRecording();
  controller._acceptMidiRecording({ trackId: track.id, startPpq: 0, endPpq: 4, events: [{ pitch: 64, startPpq: 2, durationPpq: 1 }] });
  assert.deepEqual(track.clips[0].notes.map((note) => note.pitch), [64], 'replaced, as the take began');
  assert.equal(rig('replace').controller.recordMode, 'replace');
});

// D-064: what the wheels, knobs and pedal did during a take.

test('a clip keeps controller moves, bounded, in the order they were made', () => {
  const model = new SequencerModel({ tracks: [{ type: 'midi', clips: [{ lengthPpq: 4, controls: [
    { kind: 'pitchbend', startPpq: 2, value: 20000, channel: 0 },
    { kind: 'cc', number: 64, startPpq: 1, value: 127, channel: 2 },
    { kind: 'wobble', number: 300, startPpq: 9, value: -4 }
  ] }] }] });
  assert.deepEqual(model.state.tracks[0].clips[0].controls, [
    { kind: 'cc', number: 64, startPpq: 1, value: 127, channel: 2 },
    { kind: 'pitchbend', number: 0, startPpq: 2, value: 16383, channel: 1 },
    { kind: 'cc', number: 127, startPpq: 4, value: 0, channel: 1 }
  ]);
});

test('an overdub lays a knob turned over a clip into it, with no note', () => {
  const { model, track, clip } = withClip();
  model.recordMidiTake(track.id, { startPpq: 4, endPpq: 8, events: [], controls: [
    { kind: 'cc', number: 1, startPpq: 5, value: 10, channel: 1 },
    { kind: 'cc', number: 1, startPpq: 6, value: 90, channel: 1 }
  ] });
  assert.equal(track.clips.length, 1);
  assert.deepEqual(clip.controls.map((control) => [control.startPpq, control.value]), [[1, 10], [2, 90]], 'in the clip\'s own quarters');
  assert.equal(clip.notes.length, 2, 'the notes untouched');
});

test('a replace clears the moves the take went over, with its notes', () => {
  const { model, track, clip } = withClip();
  clip.controls = [{ kind: 'cc', number: 64, startPpq: 0.5, value: 127, channel: 1 }, { kind: 'cc', number: 64, startPpq: 3, value: 0, channel: 1 }];
  model.recordMidiTake(track.id, { startPpq: 6, endPpq: 8, events: [], controls: [{ kind: 'pitchbend', startPpq: 6.5, value: 9000 }] }, { mode: 'replace' });
  assert.deepEqual(clip.controls.map((control) => [control.kind, control.startPpq]), [['cc', 0.5], ['pitchbend', 2.5]]);
});

test('a split keeps the moves on both halves, each seeing its own', () => {
  const { model, clip } = withClip();
  clip.controls = [{ kind: 'cc', number: 1, startPpq: 1, value: 20, channel: 1 }, { kind: 'cc', number: 1, startPpq: 3, value: 100, channel: 1 }];
  const [, tail] = model.splitClip(clip.id, 6);
  assert.equal(tail.controls.length, 2, 'the whole source, as the notes');
  assert.equal(tail.sourceOffsetPpq, 2);
});

test('the arrangement draws a clip\'s controller as a stepped line', async () => {
  const { controlLinesMarkup } = await import('../src/renderer/js/modules/sequencer/sequencerModule.js');
  const clip = { sourceOffsetPpq: 1, lengthPpq: 4, controls: [
    { kind: 'cc', number: 1, startPpq: 0, value: 0, channel: 1 },
    { kind: 'cc', number: 1, startPpq: 2, value: 127, channel: 1 },
    { kind: 'polypressure', number: 60, startPpq: 2, value: 50, channel: 1 }
  ] };
  const markup = controlLinesMarkup(clip, 10);
  assert.match(markup, /<path d="M0 100\.0 H10 V0\.0 H40"\/>/, 'from the value it opens on, stepping where it moves, to the clip\'s end');
  assert.equal((markup.match(/<path/g) || []).length, 1, 'a key\'s pressure is not drawn');
  assert.equal(controlLinesMarkup({ sourceOffsetPpq: 0, lengthPpq: 4, controls: [] }, 10), '');
});

// D-065: a knob bound to a plugin parameter, recorded as automation.

const laneTake = (points, extra = {}) => ({
  nodeId: 'vst-1', pluginInstanceId: 'plugin-3', pluginId: 'C:/Synth.vst3', parameterId: '42',
  startPpq: 0, endPpq: 16, points, ...extra
});

test('a lane is a straight line between its points, held at both ends, a step where two share a quarter', async () => {
  const { automationValueAt } = await import('../src/renderer/js/core/sequencerModel.js');
  const points = [{ ppq: 2, value: 0.2 }, { ppq: 4, value: 0.6 }, { ppq: 4, value: 1 }];
  assert.equal(automationValueAt(points, 0), 0.2);
  assert.ok(Math.abs(automationValueAt(points, 3) - 0.4) < 1e-12);
  assert.equal(automationValueAt(points, 4), 1, 'the later point of a step, from its quarter');
  assert.equal(automationValueAt(points, 9), 1);
});

test('the first take of a knob makes its lane, named from its binding', () => {
  const model = new SequencerModel();
  const track = model.addTrack('midi');
  const lane = model.recordAutomationTake(track.id, laneTake([{ ppq: 1, value: 0.3 }, { ppq: 2, value: 0.8 }]), { name: 'Cutoff', pluginName: 'Synth' });
  assert.deepEqual(track.automation, [lane]);
  assert.deepEqual([lane.name, lane.pluginName, lane.parameterId], ['Cutoff', 'Synth', '42']);
  assert.deepEqual(lane.points, [{ ppq: 1, value: 0.3 }, { ppq: 2, value: 0.8 }]);
});

test('an overdub is the hand from its first move to its last, the curve kept either side', () => {
  const model = new SequencerModel();
  const track = model.addTrack('midi');
  const lane = model.recordAutomationTake(track.id, laneTake([{ ppq: 0, value: 0 }, { ppq: 8, value: 0.8 }]));
  model.recordAutomationTake(track.id, laneTake([{ ppq: 3, value: 1 }, { ppq: 4, value: 1 }]));
  assert.deepEqual(lane.points.map(({ ppq, value }) => ({ ppq, value: Math.round(value * 1e9) / 1e9 })), [
    { ppq: 0, value: 0 }, { ppq: 3, value: 0.3 }, { ppq: 3, value: 1 }, { ppq: 4, value: 1 }, { ppq: 4, value: 0.4 }, { ppq: 8, value: 0.8 }
  ]);
});

test('a replace latches: the last value held to the end of the take', () => {
  const model = new SequencerModel();
  const track = model.addTrack('midi');
  const lane = model.recordAutomationTake(track.id, laneTake([{ ppq: 0, value: 0 }, { ppq: 16, value: 0 }]));
  model.recordAutomationTake(track.id, laneTake([{ ppq: 2, value: 0.5 }, { ppq: 3, value: 0.7 }], { endPpq: 12 }), { mode: 'replace' });
  assert.deepEqual(lane.points, [
    { ppq: 0, value: 0 }, { ppq: 2, value: 0 }, { ppq: 2, value: 0.5 }, { ppq: 3, value: 0.7 }, { ppq: 12, value: 0.7 }, { ppq: 12, value: 0 }, { ppq: 16, value: 0 }
  ]);
});

test('round a loop, each pass is laid over the one before it', () => {
  const model = new SequencerModel();
  const track = model.addTrack('midi');
  const lane = model.recordAutomationTake(track.id, laneTake([
    { ppq: 4, value: 0.1, pass: 0 }, { ppq: 6, value: 0.2, pass: 0 },
    { ppq: 5, value: 0.9, pass: 1 }
  ], { startPpq: 4, endPpq: 8, loopEndPpq: 8 }));
  assert.equal(lane.points.find((point) => point.ppq === 5 && point.value === 0.9) !== undefined, true, 'the second pass is in');
  assert.ok(lane.points.some((point) => point.ppq === 6 && point.value === 0.2), 'and the first pass kept where the second did not touch it');
});

test('a lane is taken off its track, and a lane to no parameter is refused', () => {
  const model = new SequencerModel();
  const track = model.addTrack('audio');
  const lane = model.recordAutomationTake(track.id, laneTake([{ ppq: 1, value: 0.5 }]));
  assert.equal(model.recordAutomationTake(track.id, laneTake([{ ppq: 1, value: 0.5 }], { parameterId: 'gain' })), null);
  assert.equal(model.removeAutomationLane(track.id, lane.id), true);
  assert.deepEqual(track.automation, []);
});

test('a take recorded on a knob reaches the arrangement, and the arrangement draws it', async () => {
  const { controller } = rig('overdub');
  controller.hub.nodes = {
    getControlBindings: () => [{ pluginInstanceId: 'plugin-3', parameterId: '42', parameterName: 'Gain', pluginName: 'Synth' }],
    get: () => null
  };
  const track = controller.model.addTrack('midi');
  controller._acceptAutomationRecording({ trackId: track.id, ...laneTake([{ ppq: 0, value: 1 }, { ppq: 4, value: 0 }]) });
  assert.equal(track.automation[0].name, 'Gain');
  const { automationMarkup } = await import('../src/renderer/js/modules/sequencer/sequencerModule.js');
  assert.match(automationMarkup(track, 10, 100), /<path d="M0 0\.0 L0\.0 0\.0 L40\.0 100\.0 L100 100\.0"\/>/);
});

// D-066: layered takes shown apart.

test('clips that overlap share their track in lanes, a clip alone keeps it whole', async () => {
  const { clipLanes } = await import('../src/renderer/js/modules/sequencer/sequencerModule.js');
  const lanes = clipLanes([
    { id: 'alone', startPpq: 0, lengthPpq: 4 },
    { id: 'first', startPpq: 8, lengthPpq: 8 },
    { id: 'take', startPpq: 10, lengthPpq: 4 },
    { id: 'after', startPpq: 14, lengthPpq: 4 },
    { id: 'third', startPpq: 11, lengthPpq: 1 },
    { id: 'later', startPpq: 18, lengthPpq: 2 }
  ]);
  assert.deepEqual(lanes.get('alone'), { lane: 0, lanes: 1 });
  assert.deepEqual(['first', 'take', 'third', 'after'].map((id) => lanes.get(id)), [
    { lane: 0, lanes: 3 }, { lane: 1, lanes: 3 }, { lane: 2, lanes: 3 }, { lane: 1, lanes: 3 }
  ], 'a lane is taken again once the clip in it has ended');
  assert.deepEqual(lanes.get('later'), { lane: 0, lanes: 1 }, 'touching the end of a group is not overlapping it');
});

// D-067: a clip active or inactive.

test('a clip is made inactive and active again, saved as such, and a copy keeps it', () => {
  const model = new SequencerModel();
  const track = model.addTrack('audio');
  const clip = model.addAudioClip(track.id, { filePath: 'C:/a.wav', lengthPpq: 8, durationSeconds: 4, trimEndSeconds: 4 });
  assert.equal(clip.muted, false);
  assert.equal(model.setClipsMuted([clip.id], true), 1);
  assert.equal(model.setClipsMuted([clip.id], true), 0, 'nothing to change');
  assert.equal(model.snapshot().tracks[0].clips[0].muted, true, 'saved');
  const [, tail] = model.splitClip(clip.id, 4, { bpm: 120 });
  assert.equal(tail.muted, true, 'both halves of a cut stay inactive');
});

