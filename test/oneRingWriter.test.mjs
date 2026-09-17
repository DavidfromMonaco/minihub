import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from '../src/renderer/js/core/hub.js';
import { VALUE_TYPE } from '../src/renderer/js/core/commandRegistry.js';
import { setupEditHistory } from '../src/renderer/js/core/editHistory.js';
import { applyHistorySnapshot } from '../src/renderer/js/core/editHistoryApply.js';
import { handleOneRingRequest } from '../src/renderer/js/core/oneRingRequests.js';
import {
  CAPTURE_MODE, WRITER_TARGET, WRITE_MODE, createSequence, defaultWriter, loadMaterial, oneRingTargets,
  readSequence, setVoiceRule, setWriterSettings, toVstState
} from '../src/renderer/js/core/oneRingSequence.js';
import { SequencerModel, defaultSequencerState } from '../src/renderer/js/core/sequencerModel.js';
import { makeFullHub } from './helpers.mjs';

/**
 * Contract, part two: a WRITE in the engine sends a generation -- what the
 * voices played over the writer's window -- and the renderer writes it into
 * the Sequencer where the node's writer says: a track of its own, or the notes
 * of the one clip it names. Nothing else in the arrangement moves; a write is
 * an edit, as a take is; what could not be written is refused and said.
 */

const settle = () => new Promise((resolve) => setImmediate(resolve));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const note = (start, duration, pitch, velocity = 100, channel = 1) => ({ pitch, velocity, channel, start, duration });
const shape = (clip) => clip.notes.map(({ pitch, startPpq, durationPpq }) => [pitch, startPpq, durationPpq]);

function mockApi() {
  const sent = [];
  const listeners = { event: [], state: [] };
  return {
    sent,
    emitEvent(msg) { listeners.event.forEach((cb) => cb(msg)); },
    loadSettings: async () => ({}),
    saveSettings: async () => true,
    engineCommand: async (msg) => { sent.push(msg); return { ok: true }; },
    engineState: async () => ({ state: 'running', error: null }),
    onEngineEvent: (cb) => { listeners.event.push(cb); return () => {}; },
    onEngineState: (cb) => { listeners.state.push(cb); return () => {}; }
  };
}

async function rig() {
  const api = mockApi();
  const hub = createHub(api);
  await hub.engine.init();
  hub.project._loading = false;
  hub.nodes.create('sequencer');
  const ring = hub.nodes.create('one-ring');
  await settle();
  let generation = 0;
  const announce = () => {
    generation += 1;
    api.emitEvent({ type: 'oneRingSynced', nodeId: ring.id, generation, created: true, ok: true, message: '' });
    return generation;
  };
  const sent = (type) => api.sent.filter((msg) => msg.type === type);
  const content = () => hub.nodes.get(ring.id).content;
  const setWriter = (changes) => hub.nodes.setContent(ring.id, setWriterSettings(content(), changes));
  // Two bars heard: C for an eighth on the first beat, E on channel 2 on the second.
  const writeEvent = (fields = {}) => api.emitEvent({
    type: 'oneRingWrite', nodeId: ring.id, generation, number: 1, beat: 16,
    transportBeat: 16, transportPlaying: true,
    notes: { length: 7680, notes: [note(0, 480, 60), note(960, 240, 64, 90, 2)] },
    ...fields
  });
  return { api, hub, ring, announce, sent, content, setWriter, writeEvent };
}

// ---------- the content ----------

test('a new node writes four bars into a track of its own; a sequence saved before the writer opens with it', () => {
  const content = createSequence();
  assert.deepEqual(content.writer, {
    mode: WRITE_MODE.newTrack, clipId: '', destination: '', bars: 4,
    feedback: false, feedbackMode: CAPTURE_MODE.replace, delayBars: 0, limit: 16, written: 0
  });
  const saved = createSequence();
  delete saved.writer;
  assert.deepEqual(readSequence(saved).writer, defaultWriter());
  assert.equal('writer' in toVstState(content), false, 'the VST never had one');
  for (const [writer, message] of [
    [{ bars: 0 }, /writer\.bars/], [{ bars: 17 }, /writer\.bars/], [{ mode: 3 }, /writer\.mode/],
    [{ limit: 0 }, /writer\.limit/], [{ limit: 1000 }, /writer\.limit/], [{ delayBars: 65 }, /writer\.delayBars/],
    [{ feedback: 1 }, /writer\.feedback/], [{ feedbackMode: 2 }, /writer\.feedbackMode/],
    [{ clipId: 5 }, /writer\.clipId/], [{ written: -1 }, /writer\.written/]
  ]) {
    assert.throws(() => readSequence({ ...createSequence(), writer: { ...defaultWriter(), ...writer } }), message);
  }
  assert.equal(setWriterSettings(content, { bars: 17 }), content, 'a setting that does not fit changes nothing');
  assert.equal(setWriterSettings(content, { bars: 4 }), content, 'nor one already there');
  assert.deepEqual(setWriterSettings(content, { bars: 8, feedback: true }).writer,
    { ...defaultWriter(), bars: 8, feedback: true });
});

test('the writer is One Ring\'s own target, with the engine\'s three commands', () => {
  const writer = oneRingTargets(createSequence()).find((target) => target.id === WRITER_TARGET);
  assert.equal(writer.label, 'One Ring Writer');
  assert.deepEqual([...writer.commands.keys()], ['WRITE', 'FEEDBACK_ON', 'FEEDBACK_OFF']);
  assert.ok([...writer.commands.values()].every((command) => command.type === VALUE_TYPE.none && !command.releaseCommand));
});

test('the engine is sent the window and feedback; where generations go publishes nothing', async () => {
  const { sent, setWriter, announce } = await rig();
  announce();
  const syncs = sent('syncOneRing').length;
  assert.deepEqual(sent('syncOneRing').at(-1).state.writer,
    { bars: 4, feedback: false, feedbackMode: CAPTURE_MODE.replace, delayBars: 0, limit: 16 });
  setWriter({ mode: WRITE_MODE.replace, clipId: 'clip-x', destination: 'vst-001', written: 3 });
  assert.equal(sent('syncOneRing').length, syncs, 'a new plan would release what Legato holds, for nothing');
  setWriter({ bars: 2, feedback: true });
  assert.equal(sent('syncOneRing').length, syncs + 1);
  assert.deepEqual(sent('syncOneRing').at(-1).state.writer,
    { bars: 2, feedback: true, feedbackMode: CAPTURE_MODE.replace, delayBars: 0, limit: 16 });
});

test('a project reopened keeps the material, the voices and the writer', async () => {
  const hub = makeFullHub();
  const ring = hub.nodes.create('one-ring');
  let edited = setWriterSettings(ring.content, {
    mode: WRITE_MODE.add, clipId: 'clip-1', destination: 'vst-001', bars: 2, feedback: true,
    feedbackMode: CAPTURE_MODE.add, delayBars: 3, limit: 5, written: 7
  });
  edited = setVoiceRule(edited, 1, 2, 'transpose', 7);
  edited = loadMaterial(edited, { length: 1920, notes: [note(0, 240, 60)] });
  hub.nodes.setContent(ring.id, edited);
  const reopened = makeFullHub(JSON.parse(JSON.stringify(hub.settings.data)));
  await reopened.nodes.load();
  assert.deepEqual(reopened.nodes.get(ring.id).content, edited);
});

// ---------- writing ----------

test('a generation becomes a track of its own, where it was heard, and nothing else moves', async () => {
  const { hub, ring, announce, content, writeEvent } = await rig();
  const seq = hub.sequencer;
  const track = seq.addTrack('midi');
  const clip = seq.addMidiClip(track.id, 0, 4, [{ pitch: 50, startPpq: 0, durationPpq: 1, velocity: 100, channel: 1 }]);
  seq.selectClip(clip.id);
  const focused = seq.model.state.focusedTrackId;
  const before = structuredClone(seq.model.state.tracks);
  announce();
  // Eight beats heard up to beat 17.5: they began at 9.5.
  writeEvent({ transportBeat: 17.5 });
  const { tracks } = seq.model.state;
  assert.equal(tracks.length, before.length + 1);
  assert.deepEqual(structuredClone(tracks.slice(0, before.length)), before, 'every other track and clip is untouched');
  const written = tracks.at(-1);
  assert.equal(written.type, 'midi');
  assert.equal(written.name, 'One Ring 1 Generation 1');
  assert.equal(written.outputId, '', 'no Destination: the author gives it an instrument');
  assert.equal(written.clips.length, 1);
  const [made] = written.clips;
  assert.equal(made.startPpq, 9.5, 'where it was heard, off the grid');
  assert.equal(made.lengthPpq, 8);
  assert.deepEqual(made.notes.map(({ pitch, velocity, channel, startPpq, durationPpq }) => [pitch, velocity, channel, startPpq, durationPpq]),
    [[60, 100, 1, 0, 0.5], [64, 90, 2, 1, 0.25]]);
  assert.equal(seq.model.state.focusedTrackId, focused, 'the inspector stays where it was');
  assert.deepEqual(seq.model.state.selectedClipIds, [clip.id], 'and so does the selection');
  assert.equal(content().writer.written, 1);
  assert.deepEqual(hub.oneRing.writesOf(ring.id),
    { written: 1, refused: 0, lastRefusal: '', last: { number: 1, trackId: written.id, clipId: made.id } });

  // The transport at rest: at the playhead. The next one is numbered on.
  seq.playheadPpq = 2;
  writeEvent({ transportPlaying: false, transportBeat: 40 });
  assert.equal(seq.model.state.tracks.at(-1).name, 'One Ring 1 Generation 2');
  assert.equal(seq.model.state.tracks.at(-1).clips[0].startPpq, 2);
  writeEvent({ transportBeat: 3 });
  assert.equal(seq.model.state.tracks.at(-1).clips[0].startPpq, 0, 'never before zero');
});

test('a new track plays the node the writer names, cabled from the Sequencer', async () => {
  const { hub, ring, announce, setWriter, writeEvent } = await rig();
  const arp = hub.nodes.create('arpeggiator');
  setWriter({ destination: arp.id });
  announce();
  writeEvent();
  assert.equal(hub.sequencer.model.state.tracks.at(-1).outputId, arp.id);
  assert.ok(hub.network.connectionsFrom('sequencer', 'midi-out').some((cable) => cable.to.nodeId === arp.id));
  hub.nodes.delete(arp.id);
  writeEvent();
  assert.equal(hub.sequencer.model.state.tracks.at(-1).outputId, '', 'the node gone, the generation is written anyway');
  assert.equal(hub.oneRing.writesOf(ring.id).written, 2);
});

test('replace and add write the named clip and no other', async () => {
  const { hub, announce, sent, content, setWriter, writeEvent } = await rig();
  const seq = hub.sequencer;
  const track = seq.addTrack('midi');
  const one = { pitch: 40, startPpq: 0, durationPpq: 1, velocity: 100, channel: 1 };
  const target = seq.addMidiClip(track.id, 4, 4, [one]);
  const other = seq.addMidiClip(track.id, 12, 4, [{ ...one, pitch: 41 }]);
  const otherBefore = structuredClone(other);
  setWriter({ mode: WRITE_MODE.replace, clipId: target.id });
  announce();
  const trackCount = seq.model.state.tracks.length;
  // A note ringing past the clip's end is cut there; one starting past it is left out.
  const heard = { length: 7680, notes: [note(0, 480, 60), note(3360, 1920, 67), note(4800, 240, 69)] };
  writeEvent({ notes: heard });
  assert.equal(seq.model.state.tracks.length, trackCount, 'no track is added');
  assert.deepEqual(shape(seq.model._clip(target.id).clip), [[60, 0, 0.5], [67, 3.5, 0.5]]);
  assert.equal(seq.model._clip(target.id).clip.startPpq, 4, 'the clip keeps its place');
  assert.equal(seq.model._clip(target.id).clip.lengthPpq, 4, 'and its length');
  assert.deepEqual(seq.model._clip(other.id).clip, otherBefore, 'the clip beside it is untouched');

  await settle();
  const syncs = sent('syncSequencer').length;
  const ids = seq.model._clip(target.id).clip.notes.map((item) => item.id);
  writeEvent({ notes: heard });
  await settle();
  assert.deepEqual(seq.model._clip(target.id).clip.notes.map((item) => item.id), ids, 'the same generation changes nothing');
  assert.equal(sent('syncSequencer').length, syncs, 'and publishes nothing');
  assert.equal(content().writer.written, 2, 'it is still a generation written');

  setWriter({ mode: WRITE_MODE.add });
  writeEvent({ notes: { length: 7680, notes: [note(0, 480, 60), note(1920, 480, 72)] } });
  assert.deepEqual(shape(seq.model._clip(target.id).clip), [[60, 0, 0.5], [72, 2, 0.5], [67, 3.5, 0.5]],
    'add skips a note the clip holds');
  assert.deepEqual(seq.model._clip(other.id).clip, otherBefore);
});

test('a clip gone, not MIDI or not named, a full Sequencer and a project changing refuse the write, and say so', async () => {
  const { hub, ring, announce, content, setWriter, writeEvent } = await rig();
  const seq = hub.sequencer;
  const logged = [];
  hub.diagnostics.log = (line) => logged.push(line);
  const refusals = [];
  hub.events.on('oneRing:writeRefused', (msg) => refusals.push(msg.reason));
  announce();
  setWriter({ mode: WRITE_MODE.replace });
  writeEvent();
  setWriter({ clipId: 'gone' });
  writeEvent();
  const audio = seq.addTrack('audio');
  const sound = seq.model.addAudioClip(audio.id, { filePath: 'take.wav', durationSeconds: 2, trimEndSeconds: 2 });
  setWriter({ clipId: sound.id });
  const arrangement = JSON.stringify(seq.model.snapshot());
  writeEvent();
  assert.deepEqual(refusals, ['no-clip', 'clip-not-found', 'clip-type-mismatch']);
  assert.equal(JSON.stringify(seq.model.snapshot()), arrangement, 'nothing was written');
  const writes = hub.oneRing.writesOf(ring.id);
  assert.deepEqual([writes.written, writes.refused], [0, 3]);
  assert.match(writes.lastRefusal, /not MIDI/);
  assert.equal(content().writer.written, 0, 'a refused generation is not counted');
  assert.equal(logged.length, 3);
  assert.match(logged[0], /generation not written -- the writer names no clip/);

  setWriter({ mode: WRITE_MODE.newTrack });
  while (seq.model.state.tracks.length < 64) seq.model.addTrack('midi');
  writeEvent();
  assert.equal(refusals.at(-1), 'track-limit');
  seq.model.removeTrack(seq.model.state.tracks.at(-1).id);

  hub.project._transitionPending = true;
  writeEvent();
  assert.equal(refusals.at(-1), 'project-transition');
  hub.project._transitionPending = false;

  writeEvent({ generation: 99 });
  writeEvent({ nodeId: 'one-ring-404' });
  assert.equal(refusals.length, 5, 'a generation from a runtime the node no longer has is not written, nor refused');
  writeEvent({ notes: { length: 7680, notes: [note(7680, 10, 60)] } });
  assert.equal(refusals.at(-1), 'invalid-generation');
  writeEvent();
  assert.equal(content().writer.written, 1);
  assert.equal(hub.oneRing.writesOf(ring.id).refused, 6);
});

test('a generation written is one undo step, and undo puts the clip and the material back', async () => {
  const { api, hub, ring, announce, sent, content, writeEvent } = await rig();
  setupEditHistory(hub, { apply: applyHistorySnapshot, quietMs: 5 });
  hub.history.start();
  hub.project.dirty = false;
  const generation = announce();
  const trackCount = hub.sequencer.model.state.tracks.length;
  const materialBefore = content().material;
  // With feedback on, the engine sends the generation, then what it made of the material.
  writeEvent();
  api.emitEvent({
    type: 'oneRingMaterial', nodeId: ring.id, generation, revision: 2,
    material: {
      origin: materialBefore.origin, generation: 1, frozen: false,
      current: { length: 7680, notes: [note(0, 480, 60), note(960, 240, 64, 90, 2)] }
    }
  });
  await wait(30);
  assert.equal(hub.project.dirty, true, 'a write modifies the project, as a take does');
  assert.equal(hub.history.canUndo, true);
  assert.equal(hub.sequencer.model.state.tracks.length, trackCount + 1);
  assert.equal(content().material.generation, 1);
  const materials = sent('setOneRingMaterial').length;
  assert.equal(await hub.history.undo(), true);
  assert.equal(hub.sequencer.model.state.tracks.length, trackCount, 'the track goes');
  assert.deepEqual(content().material, materialBefore, 'the material comes back');
  assert.equal(content().writer.written, 0);
  assert.equal(sent('setOneRingMaterial').length, materials + 1, 'and the engine is given it back');
  assert.equal(hub.history.canUndo, false, 'it was one step');
});

// ---------- the status and the requests ----------

test('the status says what the writer did and whether feedback runs', async () => {
  const { api, hub, ring, announce } = await rig();
  const generation = announce();
  api.emitEvent({
    type: 'oneRingStatus', nodeId: ring.id, generation, playing: true, beat: 4, bpm: 120, scene: 0, pendingScene: -1,
    playheads: Array(16).fill(-1), active: Array(16).fill(false), rejected: 0, guarded: 0,
    writes: 5, writesDropped: 1, writesEmpty: 2, feedback: false, feedbackStopped: true
  });
  const status = hub.oneRing.statusOf(ring.id);
  assert.deepEqual([status.writes, status.writesDropped, status.writesEmpty, status.feedback, status.feedbackStopped],
    [5, 1, 2, false, true]);
  const answer = await handleOneRingRequest(hub, ring.id, { kind: 'writer' });
  assert.deepEqual(answer.engine, { writes: 5, dropped: 1, empty: 2, feedback: false, feedbackStopped: true });
});

test('requests read and set the writer, write, and turn feedback on and off', async () => {
  const { hub, ring, announce, sent, content } = await rig();
  const ask = (body) => handleOneRingRequest(hub, ring.id, body);
  assert.deepEqual(await ask({ kind: 'writer' }), {
    ok: true,
    writer: {
      mode: 'new-track', clipId: '', destination: '', bars: 4, feedback: false,
      feedbackMode: 'replace', delayBars: 0, limit: 16, written: 0
    },
    engine: { writes: 0, dropped: 0, empty: 0, feedback: false, feedbackStopped: false },
    written: 0, refused: 0, lastRefusal: '', last: null
  });
  const seq = hub.sequencer;
  const track = seq.addTrack('midi');
  const clip = seq.addMidiClip(track.id, 0, 4);
  const arp = hub.nodes.create('arpeggiator');
  const set = await ask({
    kind: 'set-writer', mode: 'replace', clipId: clip.id, destination: arp.id,
    bars: 8, feedback: true, feedbackMode: 'add', delayBars: 2, limit: 3
  });
  assert.equal(set.ok, true, set.message);
  assert.equal(set.changed, true);
  assert.deepEqual(set.writer, {
    mode: 'replace', clipId: clip.id, destination: arp.id, bars: 8, feedback: true,
    feedbackMode: 'add', delayBars: 2, limit: 3, written: 0
  });
  assert.deepEqual(content().writer, {
    mode: WRITE_MODE.replace, clipId: clip.id, destination: arp.id, bars: 8, feedback: true,
    feedbackMode: CAPTURE_MODE.add, delayBars: 2, limit: 3, written: 0
  });

  const audio = seq.addTrack('audio');
  const sound = seq.model.addAudioClip(audio.id, { filePath: 'take.wav', durationSeconds: 1, trimEndSeconds: 1 });
  for (const [body, message] of [
    [{ clipId: sound.id }, /writer\.clipId: not a MIDI clip/],
    [{ clipId: 'nowhere' }, /writer\.clipId: no clip "nowhere"/],
    [{ destination: 'mixer-404' }, /writer\.destination: no node "mixer-404"/],
    [{ bars: 17 }, /writer\.bars: 1 to 16 bars/],
    [{ limit: 0 }, /writer\.limit: 1 to 999/],
    [{ mode: 'overdub' }, /writer\.mode: "new-track", "replace", "add"/],
    [{ feedback: 'yes' }, /writer\.feedback: true or false/],
    [{ window: 4 }, /writer\.window: not a writer setting/]
  ]) {
    const refused = await ask({ kind: 'set-writer', ...body });
    assert.equal(refused.ok, false, JSON.stringify(body));
    assert.match(refused.message, message);
  }
  assert.equal(content().writer.bars, 8, 'a refused request writes nothing');
  const viaSet = await ask({ kind: 'set', writer: { bars: 2, clipId: '' } });
  assert.equal(viaSet.ok, true, viaSet.message);
  assert.deepEqual([content().writer.bars, content().writer.clipId], [2, '']);

  assert.equal((await ask({ kind: 'write' })).ok, false, 'nothing runs the node yet');
  const generation = announce();
  assert.deepEqual(await ask({ kind: 'write' }), { ok: true });
  assert.deepEqual(await ask({ kind: 'feedback', on: true }), { ok: true });
  assert.deepEqual(await ask({ kind: 'feedback', on: false }), { ok: true });
  assert.equal((await ask({ kind: 'feedback' })).ok, false);
  assert.deepEqual(sent('oneRingCommand').map(({ command, name, generation: g }) => [command, name, g]), [
    ['writer', 'WRITE', generation], ['writer', 'FEEDBACK_ON', generation], ['writer', 'FEEDBACK_OFF', generation]
  ]);
  assert.deepEqual(await hub.oneRing.writer(ring.id, 'ERASE'), { ok: false, reason: 'invalid-command' });
  const status = await ask({ kind: 'status' });
  assert.deepEqual(status.writer, {
    mode: 'replace', feedback: false, feedbackStopped: false, writes: 0, written: 0, refused: 0, lastRefusal: ''
  });
  assert.ok((await ask({ kind: 'describe' })).kinds.includes('set-writer'));
});

// ---------- the Sequencer's own operations ----------

test('written notes land from the clip\'s first visible quarter; one past its end is left out', () => {
  const model = new SequencerModel({
    ...defaultSequencerState(),
    tracks: [{ id: 't', type: 'midi', clips: [{ id: 'c', startPpq: 4, lengthPpq: 2, sourceOffsetPpq: 1, sourceLengthPpq: 4, notes: [] }] }]
  });
  const at = (pitch, startPpq, durationPpq) => ({ pitch, startPpq, durationPpq, velocity: 100, channel: 1 });
  assert.equal(model.replaceMidiNotes('c', [at(60, 0, 0.5), at(61, 1.5, 2), at(62, 2, 1), at(63, -1, 1)]), 2);
  assert.deepEqual(shape(model._clip('c').clip), [[60, 1, 0.5], [61, 2.5, 0.5]]);
  assert.equal(model.replaceMidiNotes('nope', []), -1);
  assert.equal(model.addMidiNotes('c', 'not a list'), -1);
});

test('the Clip Editor can replace a clip\'s notes or add to them', async () => {
  const { hub } = await rig();
  const seq = hub.sequencer;
  const track = seq.addTrack('midi');
  const clip = seq.addMidiClip(track.id, 0, 2, [{ pitch: 50, startPpq: 0, durationPpq: 1, velocity: 100, channel: 1 }]);
  const request = (operation, notes) => seq.handleClipEditorRequest({
    kind: 'update', clipId: clip.id, expectedProjectId: hub.project?.projectId || '', operation, payload: { notes }
  });
  const long = { pitch: 62, startPpq: 0.5, durationPpq: 4, velocity: 90, channel: 1 };
  const replaced = request('replace-notes', [long]);
  assert.equal(replaced.ok, true);
  assert.equal(replaced.applied, 1);
  assert.deepEqual(shape(seq.model._clip(clip.id).clip), [[62, 0.5, 1.5]]);
  assert.equal(request('replace-notes', [long]).applied, 0, 'the same notes change nothing');
  const added = request('add-notes', [{ ...long, durationPpq: 1 }, { ...long, pitch: 64, startPpq: 1 }]);
  assert.equal(added.applied, 1, 'a note the clip holds is not added twice');
  assert.equal(request('replace-notes', []).applied, 1, 'replacing with nothing empties the clip');
  assert.deepEqual(seq.model._clip(clip.id).clip.notes, []);
});
