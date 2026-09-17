import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from '../src/renderer/js/core/hub.js';
import { VALUE_TYPE } from '../src/renderer/js/core/commandRegistry.js';
import { ARP_SCALES } from '../src/renderer/js/core/arpeggiatorState.js';
import { handleOneRingRequest } from '../src/renderer/js/core/oneRingRequests.js';
import { commandLabel, targetLabel } from '../src/renderer/js/modules/oneRing/oneRingFaceplate.js';
import {
  NOTE_ORDER, VOICE_COUNT, VOICE_TARGET_PREFIX, cellAt, createSequence, defaultVoice, oneRingTargets, readSequence,
  sequenceErrors, setVoice, setVoiceRule, storeScene, targetFinder, toVstState
} from '../src/renderer/js/core/oneRingSequence.js';

/**
 * Contract, part two: each scene holds four voices' rules, and a channel aimed
 * at a voice plays notes from the material through it. The engine plays them
 * (native one_ring/voices.h); here, what the node keeps, the targets it offers
 * the sequence -- the same as the engine's -- and the requests.
 */

const settle = () => new Promise((resolve) => setImmediate(resolve));

function mockApi() {
  const sent = [];
  const listeners = { event: [] };
  return {
    sent,
    emitEvent(msg) { listeners.event.forEach((cb) => cb(msg)); },
    loadSettings: async () => ({}),
    saveSettings: async () => true,
    engineCommand: async (msg) => { sent.push(msg); return { ok: true }; },
    engineState: async () => ({ state: 'running', error: null }),
    onEngineEvent: (cb) => { listeners.event.push(cb); return () => {}; },
    onEngineState: () => () => {}
  };
}

async function rig() {
  const api = mockApi();
  const hub = createHub(api);
  await hub.engine.init();
  hub.project._loading = false;
  const ring = hub.nodes.create('one-ring');
  await settle();
  const ask = (body) => handleOneRingRequest(hub, ring.id, body);
  const content = () => hub.nodes.get(ring.id).content;
  return { api, hub, ring, ask, content };
}

test('every scene holds four voices that change nothing, and the VST state leaves them out', () => {
  const content = createSequence();
  for (const scene of content.scenes) {
    assert.equal(scene.voices.length, VOICE_COUNT);
    assert.deepEqual(scene.voices[0], {
      channel: 0, root: 0, scale: 0, transpose: 0, octave: 0, octaveSpread: 0, octaveChance: 0, low: 0, high: 127,
      velocityScale: 100, velocitySpread: 0, velocityLow: 1, velocityHigh: 127, gateScale: 100, gateSpread: 0,
      shortest: 60, longest: 61440, order: NOTE_ORDER.asPlayed, density: 100
    });
  }
  const vst = toVstState(content);
  assert.equal('voices' in vst.scenes[0], false);
  assert.deepEqual(readSequence(vst), content, 'a scene saved without voices opens with neutral ones');
});

test('a voice is read with its limits, and a scene is stored with its voices', () => {
  const saved = createSequence();
  saved.scenes[1].voices[2] = { transpose: -12, scale: 10, order: NOTE_ORDER.shuffled };
  const opened = readSequence(saved);
  assert.deepEqual(opened.scenes[1].voices[2], { ...defaultVoice(), transpose: -12, scale: 10, order: NOTE_ORDER.shuffled },
    'a rule left out is the neutral one');
  const broken = [
    [{ transpose: 49 }, /voices\[0\]\.transpose/],
    [{ low: 90, high: 80 }, /lowest above its highest/],
    [{ shortest: 10 }, /shortest/],
    [{ order: 4 }, /order/]
  ];
  for (const [voice, message] of broken) {
    const content = createSequence();
    content.scenes[0].voices[0] = voice;
    assert.throws(() => readSequence(content), message);
  }
  assert.throws(() => readSequence({ ...createSequence(), scenes: createSequence().scenes.map((s) => ({ ...s, voices: [] })) }),
    /four voices/);
  const stored = storeScene(opened, 1, 3);
  assert.deepEqual(stored.scenes[3].voices, opened.scenes[1].voices, 'STORE SCENE copies the voices too');
  const bad = { ...opened, scenes: opened.scenes.map((s, i) => (i ? s : { ...s, voices: [{ ...defaultVoice(), low: 100, high: 10 }, ...s.voices.slice(1)] })) };
  assert.ok(sequenceErrors(bad, targetFinder(bad)).includes('Invalid voice rules'));
});

test('a rule is set as the page turns it, and refused when it does not fit', () => {
  const content = createSequence();
  const up = setVoiceRule(content, 0, 1, 'transpose', 7);
  assert.equal(up.scenes[0].voices[1].transpose, 7);
  assert.equal(setVoiceRule(up, 0, 1, 'transpose', 7), up, 'the same value changes nothing');
  assert.equal(setVoiceRule(content, 0, 1, 'transpose', 60), content);
  assert.equal(setVoiceRule(content, 0, 1, 'low', 128), content);
  assert.equal(setVoiceRule(content, 0, 1, 'nope', 1), content);
  const narrow = setVoice(content, 0, 0, { ...defaultVoice(), low: 48, high: 60 });
  assert.equal(setVoiceRule(narrow, 0, 0, 'high', 40), narrow, 'a highest under the lowest is refused');
});

test('four voices are One Ring\'s own targets, with the engine\'s commands and ranges', () => {
  const targets = oneRingTargets(createSequence()).filter((target) => target.id.startsWith(VOICE_TARGET_PREFIX));
  assert.deepEqual(targets.map((target) => target.id), [1, 2, 3, 4].map((n) => `${VOICE_TARGET_PREFIX}${n}`));
  const commands = targets[0].commands;
  assert.deepEqual([...commands.keys()],
    ['PLAY', 'NOTE', 'NOTE_OFF', 'TRANSPOSE', 'OCTAVE', 'ROOT', 'SCALE', 'VELOCITY', 'GATE', 'DENSITY']);
  assert.deepEqual([commands.get('PLAY').minimum, commands.get('PLAY').maximum], [-1, 63]);
  assert.equal(commands.get('NOTE').releaseCommand, 'NOTE_OFF');
  assert.equal(commands.get('NOTE_OFF').type, VALUE_TYPE.none);
  assert.deepEqual(commands.get('SCALE').choices.map((choice) => choice.label), Object.keys(ARP_SCALES));
  assert.equal(commands.get('ROOT').choices[3].label, 'D#');
  assert.equal(targetLabel(targets[2]), 'One Ring · Voice 3');
  assert.equal(commandLabel(targets[2], commands.get('NOTE_OFF')), 'Note off');
});

test('a channel is aimed at a voice by request, plays notes, and ties them in Legato', async () => {
  const { ask, content } = await rig();
  const played = await ask({ kind: 'set', scene: 0, channels: [
    { channel: 1, target: 'one-ring:voice:1', command: 'PLAY', length: 16, clearSteps: true,
      steps: Array.from({ length: 16 }, (_, i) => ({ step: i + 1, enabled: true, value: -1 })) },
    { channel: 2, target: 'one-ring:voice:2', command: 'NOTE', mode: 'legato', length: 4, resolution: '1/4',
      steps: [{ step: 1, enabled: true, value: { oneOf: [0, 2, 4] } }] },
    { channel: 3, target: 'one-ring:voice:2', command: 'SCALE', steps: [{ step: 1, enabled: true, value: 'Dorian' }] }
  ] });
  assert.equal(played.ok, true, played.message);
  const [one, two, three] = content().scenes[0].channels;
  assert.equal(cellAt(one, 15).value.fixed.value, -1);
  assert.equal(cellAt(one, 16).value.fixed.value, -1, 'every cell takes the command\'s default, which is its own slot');
  assert.equal(two.mode, 1);
  assert.deepEqual(cellAt(two, 0).value.choices.map((value) => value.value), [0, 2, 4]);
  assert.equal(cellAt(three, 0).value.fixed.value, Object.keys(ARP_SCALES).indexOf('Dorian'));
  const refused = await ask({ kind: 'set', channels: [{ channel: 1, target: 'one-ring:voice:1', command: 'PLAY', steps: [{ step: 1, value: 64 }] }] });
  assert.match(refused.message, /PLAY takes a whole number from -1 to 63/);
  const legatoPlay = await ask({ kind: 'set', channels: [{ channel: 4, target: 'one-ring:voice:1', command: 'PLAY', mode: 'legato' }] });
  assert.match(legatoPlay.message, /PLAY declares no release/);
});

test('voices are read and set by request, in the page\'s names', async () => {
  const { api, hub, ring, ask, content } = await rig();
  const set = await ask({
    kind: 'set-voice', scene: 'B', voice: 2, root: 'D', scale: 'minor pentatonic', transpose: -12, channel: 3,
    shortestPpq: 0.25, longestPpq: 8, order: 'rising', density: 60
  });
  assert.equal(set.ok, true, set.message);
  assert.deepEqual(set.voice, {
    channel: 3, root: 'D', scale: 'Minor Pentatonic', transpose: -12, octave: 0, octaveSpread: 0, octaveChance: 0,
    low: 0, high: 127, velocityScale: 100, velocitySpread: 0, velocityLow: 1, velocityHigh: 127, gateScale: 100,
    gateSpread: 0, shortestPpq: 0.25, longestPpq: 8, order: 'rising', density: 60
  });
  assert.deepEqual(content().scenes[1].voices[1], {
    ...defaultVoice(), channel: 3, root: 2, scale: 10, transpose: -12, shortest: 240, longest: 7680,
    order: NOTE_ORDER.rising, density: 60
  });
  for (const [body, message] of [
    [{ voice: 5 }, /^voice: a voice from 1 to 4$/],
    [{ voice: 1, root: 'H' }, /^voice\.root: one of "C"/],
    [{ voice: 1, velocityLow: 100, velocityHigh: 50 }, /lowest above its highest/],
    [{ voice: 1, shortestPpq: 100 }, /^voice\.shortestPpq: from 0\.0625 to 64$/],
    [{ voice: 1, colour: 3 }, /^voice\.colour: not a voice rule/]
  ]) {
    const answer = await ask({ kind: 'set-voice', ...body });
    assert.equal(answer.ok, false, JSON.stringify(body));
    assert.match(answer.message, message);
  }

  const idle = await ask({ kind: 'voices', scene: 1 });
  assert.equal(idle.voices[1].root, 'D');
  assert.equal(idle.playing, null, 'nothing plays: no live rules');
  api.emitEvent({ type: 'oneRingSynced', nodeId: ring.id, generation: 1, created: true, ok: true, message: '' });
  const live = content().scenes[0].voices.map((voice, v) => (v === 0 ? { ...voice, transpose: 5 } : voice));
  const status = (extra) => api.emitEvent({
    type: 'oneRingStatus', nodeId: ring.id, generation: 1, playing: true, beat: 1, bpm: 120, scene: 0, pendingScene: -1,
    playheads: Array(16).fill(-1), active: Array(16).fill(false), rejected: 0, guarded: 0, ...extra
  });
  status({ sounding: [3, 0, 1, 0], notesRefused: 2, voices: live });
  status({ sounding: [2, 0, 0, 0], notesRefused: 2 });
  assert.deepEqual(hub.oneRing.statusOf(ring.id).voices, live, 'live rules sent once hold until they move');
  const playing = await ask({ kind: 'voices' });
  assert.equal(playing.playing[0].transpose, 5);
  assert.deepEqual([playing.sounding, playing.refused], [[2, 0, 0, 0], 2]);
});
