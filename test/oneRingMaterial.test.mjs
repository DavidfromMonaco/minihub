import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from '../src/renderer/js/core/hub.js';
import { setupEditHistory } from '../src/renderer/js/core/editHistory.js';
import { describeMidiNetwork } from '../src/renderer/js/core/engineSync.js';
import { midiThruReach } from '../src/renderer/js/core/midiThru.js';
import { getNodeType } from '../src/renderer/js/core/nodeTypes.js';
import { handleOneRingRequest } from '../src/renderer/js/core/oneRingRequests.js';
import {
  CAPTURE_MODE, MATERIAL_CAPACITY, MEMORY_TARGET, TICKS_PER_BAR, clearMaterial, createSequence, emptyMaterial,
  loadMaterial, noteListFromClip, oneRingTargets, readSequence, revertMaterial, setCaptureSettings, setFrozen,
  toVstState
} from '../src/renderer/js/core/oneRingSequence.js';

/**
 * Contract, part two: a One Ring node keeps the notes it plays from -- its
 * material -- in its content, beside the capture's settings; the engine holds a
 * copy, sent on its own and reported back when the engine changes it. The node
 * has a MIDI IN a track or a controller plays into, and a MIDI OUT.
 */

const settle = () => new Promise((resolve) => setImmediate(resolve));
const note = (start, duration, pitch, velocity = 100, channel = 1) => ({ pitch, velocity, channel, start, duration });

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
  const report = (material, gen = generation) => api.emitEvent({
    type: 'oneRingMaterial', nodeId: ring.id, generation: gen, revision: 1, material
  });
  return { api, hub, ring, announce, sent, content, report };
}

// ---------- the content ----------

test('a new node holds an empty material and captures a bar, replacing', () => {
  const content = createSequence();
  assert.deepEqual(content.capture, { mode: CAPTURE_MODE.replace, bars: 1 });
  assert.deepEqual(content.material, { origin: { length: TICKS_PER_BAR, notes: [] }, current: null, generation: 0, frozen: false });
});

test('a sequence saved before the material opens with the defaults, and the VST state leaves it out', () => {
  const saved = createSequence();
  delete saved.capture;
  delete saved.material;
  const opened = readSequence(saved);
  assert.deepEqual(opened.capture, { mode: CAPTURE_MODE.replace, bars: 1 });
  assert.deepEqual(opened.material, emptyMaterial());
  assert.deepEqual(opened.scenes, saved.scenes, 'the sequence itself is untouched');
  const vst = toVstState(opened);
  assert.equal('material' in vst || 'capture' in vst, false);
  assert.deepEqual(readSequence(vst), opened, 'and it reads back as the same node');
});

test('the material is checked and ordered as the engine keeps it', () => {
  const content = readSequence({
    ...createSequence(),
    capture: { mode: CAPTURE_MODE.add, bars: 0 },
    material: {
      origin: { length: 7680, notes: [note(960, 480, 64), note(0, 240, 67), note(0, 240, 60, 90, 2), note(0, 240, 60)] },
      current: { length: 960, notes: [note(10, 20, 72)] },
      generation: 4,
      frozen: true
    }
  });
  assert.deepEqual(content.material.origin.notes.map((n) => [n.start, n.pitch, n.channel]),
    [[0, 60, 1], [0, 60, 2], [0, 67, 1], [960, 64, 1]]);
  assert.deepEqual(content.capture, { mode: CAPTURE_MODE.add, bars: 0 });
  assert.equal(content.material.generation, 4);
  const broken = [
    [{ origin: { length: 3840, notes: [note(3840, 10, 60)] }, current: null, generation: 0, frozen: false }, /origin\.notes\[0\]\.start/],
    [{ origin: { length: 3840, notes: [note(0, 10, 128)] }, current: null, generation: 0, frozen: false }, /pitch/],
    [{ origin: { length: 3840, notes: [note(0, 0, 60)] }, current: null, generation: 0, frozen: false }, /duration/],
    [{ origin: { length: 3840, notes: [] }, current: null, generation: 0 }, /frozen/],
    [{ origin: { length: 3840, notes: Array.from({ length: 257 }, () => note(0, 1, 60)) }, current: null, generation: 0, frozen: false }, /at most 256/]
  ];
  for (const [material, message] of broken) {
    assert.throws(() => readSequence({ ...createSequence(), material }), message);
  }
  assert.throws(() => readSequence({ ...createSequence(), capture: { mode: 0, bars: 17 } }), /capture\.bars/);
});

test('the material has its own commands among One Ring\'s targets', () => {
  const memory = oneRingTargets(createSequence()).find((target) => target.id === MEMORY_TARGET);
  assert.deepEqual([...memory.commands.keys()],
    ['CAPTURE_REPLACE', 'CAPTURE_ADD', 'CAPTURE_END', 'CLEAR', 'FREEZE', 'UNFREEZE', 'REVERT']);
  assert.equal(memory.commands.get('CAPTURE_REPLACE').releaseCommand, 'CAPTURE_END');
  assert.equal(memory.commands.get('CLEAR').releaseCommand, undefined);
});

test('the page\'s material edits: load, clear, freeze, revert, and the capture\'s settings', () => {
  const start = createSequence();
  const loaded = loadMaterial(start, { length: 1920, notes: [note(480, 240, 62), note(0, 240, 60)] });
  assert.deepEqual(loaded.material.origin.notes.map((n) => n.pitch), [60, 62]);
  assert.equal(loadMaterial(loaded, loaded.material.origin), loaded, 'the same notes change nothing');
  const generated = { ...loaded, material: { ...loaded.material, current: { length: 960, notes: [note(0, 10, 70)] }, generation: 2 } };
  const reverted = revertMaterial(generated);
  assert.equal(reverted.material.current, null);
  assert.equal(reverted.material.generation, 0);
  const frozen = setFrozen(generated, true);
  assert.equal(frozen.material.frozen, true);
  const cleared = clearMaterial(frozen);
  assert.deepEqual(cleared.material, { ...emptyMaterial(), frozen: true }, 'a person clears frozen material too; it stays frozen');
  assert.deepEqual(setCaptureSettings(start, { bars: 4 }).capture, { mode: CAPTURE_MODE.replace, bars: 4 });
  assert.throws(() => setCaptureSettings(start, { bars: 20 }), /capture\.bars/);
});

test('a clip becomes material as it plays: its window, from its start, cut at its end', () => {
  const list = noteListFromClip({
    lengthPpq: 2,
    sourceOffsetPpq: 1,
    notes: [
      { pitch: 50, velocity: 90, channel: 1, startPpq: 0, durationPpq: 0.5 },
      { pitch: 52, velocity: 90, channel: 1, startPpq: 0.5, durationPpq: 1 },
      { pitch: 55, velocity: 80, channel: 2, startPpq: 1.25, durationPpq: 0.25 },
      { pitch: 57, velocity: 70, channel: 1, startPpq: 2.5, durationPpq: 4 },
      { pitch: 59, velocity: 70, channel: 1, startPpq: 3, durationPpq: 1 }
    ]
  });
  assert.equal(list.length, 1920);
  assert.deepEqual(list.notes, [
    { pitch: 52, velocity: 90, channel: 1, start: 0, duration: 480 },
    { pitch: 55, velocity: 80, channel: 2, start: 240, duration: 240 },
    { pitch: 57, velocity: 70, channel: 1, start: 1440, duration: 480 }
  ]);
  assert.throws(() => noteListFromClip({ lengthPpq: 300, sourceOffsetPpq: 0, notes: [] }), /longer than a material/);
  const crowded = Array.from({ length: MATERIAL_CAPACITY + 1 }, (_, i) => ({ pitch: 60, velocity: 100, channel: 1, startPpq: i / 100, durationPpq: 0.01 }));
  assert.throws(() => noteListFromClip({ lengthPpq: 4, sourceOffsetPpq: 0, notes: crowded }), /257 notes/);
});

// ---------- the node and the engine ----------

test('the material goes to the engine on its own, and a change of it sends only it', async () => {
  const { hub, ring, sent, content } = await rig();
  const [sequence] = sent('syncOneRing');
  assert.equal('material' in sequence.state, false, 'the sequence travels without its material');
  assert.deepEqual(sequence.state.capture, content().capture, 'but with the capture\'s settings');
  const [first] = sent('setOneRingMaterial');
  assert.deepEqual(first, { v: 1, type: 'setOneRingMaterial', nodeId: ring.id, material: content().material });
  hub.nodes.setContent(ring.id, loadMaterial(content(), { length: 3840, notes: [note(0, 960, 48)] }));
  assert.equal(sent('syncOneRing').length, 1, 'a material change publishes no new sequence');
  assert.equal(sent('setOneRingMaterial').length, 2);
  assert.deepEqual(sent('setOneRingMaterial').at(-1).material.origin.notes, [note(0, 960, 48)]);
  hub.nodes.setContent(ring.id, setCaptureSettings(content(), { bars: 2 }));
  assert.equal(sent('syncOneRing').length, 2, 'the capture\'s settings are part of the sequence');
  assert.equal(sent('setOneRingMaterial').length, 2);
});

test('what the engine made of the material is an edit, not sent back; undo sends the old one', async () => {
  const { hub, ring, announce, sent, content, report } = await rig();
  announce();
  setupEditHistory(hub, { apply: async (snapshot) => hub.nodes.restoreSnapshot?.(snapshot), quietMs: 5 });
  hub.history.start();
  hub.project.dirty = false;
  const captured = { origin: { length: 3840, notes: [note(960, 480, 60)] }, current: null, generation: 0, frozen: false };
  report(captured);
  assert.deepEqual(content().material, captured);
  assert.equal(sent('setOneRingMaterial').length, 1, 'the engine is not sent what it reported');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(hub.history.canUndo, true, 'a capture is an undo step, as a take is');
  assert.equal(hub.project.dirty, true, 'and a modification of the project');

  report({ ...captured, origin: { length: 3840, notes: [note(0, 10, 99)] } }, 99);
  assert.deepEqual(content().material, captured, 'a report from another runtime is not taken');
  report({ origin: { length: 3840, notes: [note(0, 10, 200)] }, current: null, generation: 0, frozen: false });
  assert.deepEqual(content().material, captured, 'nor an unreadable one');

  hub.nodes.setContent(ring.id, { ...content(), material: emptyMaterial() });
  assert.equal(sent('setOneRingMaterial').length, 2, 'the content going back sends the material back');
  assert.deepEqual(sent('setOneRingMaterial').at(-1).material, emptyMaterial());
});

test('the status says what the capture and the material are doing', async () => {
  const { api, hub, ring, announce } = await rig();
  const generation = announce();
  api.emitEvent({
    type: 'oneRingStatus', nodeId: ring.id, generation, playing: false, beat: 0, bpm: 120, scene: 0, pendingScene: -1,
    playheads: Array(16).fill(-1), active: Array(16).fill(false), rejected: 0, guarded: 0,
    capture: 2, captured: 3, captureRefused: 1, originNotes: 5, currentNotes: 0, hasCurrent: false, frozen: true,
    materialGeneration: 0
  });
  const status = hub.oneRing.statusOf(ring.id);
  assert.equal(status.capture, 'capturing');
  assert.deepEqual([status.captured, status.captureRefused, status.originNotes, status.frozen], [3, 1, 5, true]);
});

test('a capture, its end and the material\'s commands go to the runtime', async () => {
  const { hub, ring, announce, sent } = await rig();
  assert.deepEqual(await hub.oneRing.memory(ring.id, 'CAPTURE_REPLACE'), { ok: false, reason: 'not-running' });
  const generation = announce();
  await hub.oneRing.memory(ring.id, 'CAPTURE_ADD');
  await hub.oneRing.memory(ring.id, 'CAPTURE_END');
  assert.deepEqual(await hub.oneRing.memory(ring.id, 'ERASE'), { ok: false, reason: 'invalid-command' });
  assert.deepEqual(sent('oneRingCommand').map(({ command, name, generation: g }) => ({ command, name, g })), [
    { command: 'memory', name: 'CAPTURE_ADD', g: generation },
    { command: 'memory', name: 'CAPTURE_END', g: generation }
  ]);
});

// ---------- the ports ----------

test('the node has a MIDI IN and a MIDI OUT beside its CTRL OUT', () => {
  const { ports } = getNodeType('one-ring');
  assert.deepEqual(ports.inputs.map((port) => [port.id, port.type]), [['midi-in', 'midi']]);
  assert.deepEqual(ports.outputs.map((port) => [port.id, port.type]), [['ctrl-out', 'control'], ['midi-out', 'midi']]);
});

test('its notes reach VSTs and their series, arpeggiators and hardware, never another One Ring', async () => {
  const { hub, ring } = await rig();
  const vstA = hub.nodes.create('vst');
  const vstB = hub.nodes.create('vst');
  const arp = hub.nodes.create('arpeggiator');
  const other = hub.nodes.create('one-ring');
  await settle();
  hub.network.connect(ring.id, 'midi-out', vstA.id, 'midi-in');
  hub.network.connect(vstA.id, 'midi-out', vstB.id, 'midi-in');
  hub.network.connect(vstA.id, 'midi-out', other.id, 'midi-in');
  hub.network.connect(ring.id, 'midi-out', arp.id, 'midi-in');
  const described = describeMidiNetwork(hub).find((node) => node.id === ring.id);
  assert.equal(described.nodeType, 'one-ring');
  assert.deepEqual(described.destinations, [vstA.id, vstB.id, arp.id]);
  assert.deepEqual(midiThruReach(hub.network, vstA.id).map((hop) => [hop.id, hop.kind]),
    [[vstB.id, 'vst'], [other.id, 'one-ring']], 'a series ends at a One Ring, as at an arpeggiator');
  assert.throws(() => hub.network.connect(other.id, 'midi-out', vstA.id, 'midi-in'), /cycle/,
    'and the Patch Bay still refuses a MIDI cycle');
});

test('a track aimed at One Ring is sent as a processor, and a controller\'s notes reach it', async () => {
  const { api, hub, ring } = await rig();
  hub.nodes.create('sequencer');
  await settle();
  const track = hub.sequencer.addTrack('midi');
  const routed = hub.sequencer.setTrack(track.id, { outputId: ring.id });
  assert.equal(routed.outputId, ring.id);
  await settle();
  const synced = api.sent.filter((msg) => msg.type === 'syncSequencer').at(-1);
  const sentTrack = synced.project.tracks.find((item) => item.id === track.id);
  assert.equal(sentTrack.outputKind, 'one-ring');
  assert.equal(sentTrack.outputId, ring.id);
  assert.ok(hub.network.connectionsFrom('sequencer', 'midi-out').some((c) => c.to.nodeId === ring.id));

  hub.network.getNode(ring.id).onInput('midi-in', { raw: [0x90, 60, 100] });
  await settle();
  const live = api.sent.filter((msg) => msg.type === 'midiNode').at(-1);
  assert.deepEqual([live.nodeId, live.data], [ring.id, [0x90, 60, 100]]);
});

// ---------- requests ----------

test('requests read and edit the material, and start and end a capture', async () => {
  const { hub, ring, announce, sent, content } = await rig();
  const ask = (body) => handleOneRingRequest(hub, ring.id, body);
  const empty = await ask({ kind: 'material' });
  assert.deepEqual(empty, {
    ok: true, capture: { mode: 'replace', bars: 1, state: 'off', taken: 0 },
    origin: { lengthPpq: 4, notes: [] }, current: null, generation: 0, frozen: false, refused: 0
  });
  const set = await ask({
    kind: 'set-material', lengthPpq: 2,
    notes: [{ pitch: 64, startPpq: 0.5, durationPpq: 0.25 }, { pitch: 60, velocity: 80, channel: 3, startPpq: 0, durationPpq: 1 }]
  });
  assert.equal(set.ok, true, set.message);
  assert.deepEqual(set.origin, { lengthPpq: 2, notes: [
    { pitch: 60, velocity: 80, channel: 3, startPpq: 0, durationPpq: 1 },
    { pitch: 64, velocity: 100, channel: 1, startPpq: 0.5, durationPpq: 0.25 }
  ] });
  assert.deepEqual(content().material.origin.notes[0], note(0, 960, 60, 80, 3));
  const refused = await ask({ kind: 'set-material', lengthPpq: 1, notes: [{ pitch: 60, startPpq: 1, durationPpq: 1 }] });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /material\.notes\[0\]\.start/);

  const track = hub.sequencer.addTrack('midi');
  const clip = hub.sequencer.addMidiClip(track.id, 8, 1, [{ pitch: 72, startPpq: 0.25, durationPpq: 0.5, velocity: 110, channel: 1 }]);
  const fromClip = await ask({ kind: 'set-material', clipId: clip.id });
  assert.deepEqual(fromClip.origin, { lengthPpq: 1, notes: [{ pitch: 72, velocity: 110, channel: 1, startPpq: 0.25, durationPpq: 0.5 }] });
  assert.equal((await ask({ kind: 'set-material', clipId: 'nope' })).reason, 'refused');

  assert.equal((await ask({ kind: 'freeze' })).frozen, true);
  assert.equal((await ask({ kind: 'unfreeze' })).frozen, false);
  const generated = { ...content().material, current: { length: 960, notes: [note(0, 10, 70)] }, generation: 3 };
  hub.nodes.setContent(ring.id, { ...content(), material: generated });
  const reverted = await ask({ kind: 'revert' });
  assert.deepEqual([reverted.current, reverted.generation], [null, 0]);
  assert.deepEqual((await ask({ kind: 'clear' })).origin, { lengthPpq: 4, notes: [] });

  assert.deepEqual(await ask({ kind: 'capture' }), { ok: false, reason: 'not-running' });
  const generation = announce();
  const capture = await ask({ kind: 'capture', mode: 'add', bars: 2 });
  assert.deepEqual(capture, { ok: true, capture: { mode: 'add', bars: 2 } });
  assert.deepEqual(content().capture, { mode: CAPTURE_MODE.add, bars: 2 });
  assert.deepEqual(await ask({ kind: 'capture-end' }), { ok: true });
  assert.deepEqual(sent('oneRingCommand').map(({ name, generation: g }) => [name, g]),
    [['CAPTURE_ADD', generation], ['CAPTURE_END', generation]]);
  assert.equal((await ask({ kind: 'capture', bars: 99 })).reason, 'refused');

  const viaSet = await ask({ kind: 'set', capture: { mode: 'replace', bars: 0 } });
  assert.equal(viaSet.ok, true, viaSet.message);
  assert.deepEqual(content().capture, { mode: CAPTURE_MODE.replace, bars: 0 });
  const described = await ask({ kind: 'status' });
  assert.deepEqual(described.material, { originNotes: 0, currentNotes: null, generation: 0, frozen: false });
});
