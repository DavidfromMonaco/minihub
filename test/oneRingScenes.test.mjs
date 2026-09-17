import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from '../src/renderer/js/core/hub.js';
import { VALUE_TYPE } from '../src/renderer/js/core/commandRegistry.js';
import { handleOneRingRequest } from '../src/renderer/js/core/oneRingRequests.js';
import {
  MAX_SCENES, SCENES_TARGET, SCENE_PLACES, addScene, createSequence, emptySource, oneRingTargets, readSequence,
  sceneIndex, scenePlace, sequenceErrors, storeSceneAt, targetFinder, toVstState
} from '../src/renderer/js/core/oneRingSequence.js';

/**
 * Contract: a One Ring node's scenes are four letters of eight, A1 to D8. A
 * scene exists once it is made; the list only grows, so a scene's index -- what
 * a RECALL holds -- never moves. The VST's four scenes read as A1 to D1.
 */

const settle = () => new Promise((resolve) => setImmediate(resolve));
const recallOf = (content) => oneRingTargets(content).find((target) => target.id === SCENES_TARGET).commands.get('RECALL');

test('thirty-two places, A1 to D8, in the deck\'s order', () => {
  assert.equal(MAX_SCENES, 32);
  assert.deepEqual(SCENE_PLACES.slice(0, 9), ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'B1']);
  assert.equal(SCENE_PLACES.at(-1), 'D8');
  assert.deepEqual(scenePlace('C3'), { bank: 'C', number: 3, order: 18 });
  for (const none of ['A', 'A0', 'A9', 'E1', 'a1', '', null]) assert.equal(scenePlace(none), null, String(none));
  assert.deepEqual(createSequence().scenes.map((scene) => scene.id), ['A1', 'B1', 'C1', 'D1']);
});

test('the VST\'s four scenes read as A1 to D1, and what recalls them still does', () => {
  const vst = toVstState(createSequence());
  assert.deepEqual(vst.scenes.map((scene) => [scene.id, scene.name]),
    [['A', 'Scene A'], ['B', 'Scene B'], ['C', 'Scene C'], ['D', 'Scene D']], 'written as the VST wrote them');
  vst.scenes[0].name = 'Intro';
  const channel = vst.scenes[0].channels[0];
  channel.target = { target: SCENES_TARGET, command: 'RECALL', value: emptySource() };
  // Every cell holds a scene, as choosing RECALL gives them; the first plays D.
  channel.steps = channel.steps.map((cell, k) => ({
    ...cell, enabled: k === 0, value: { ...emptySource(), fixed: { type: VALUE_TYPE.choice, value: k === 0 ? 3 : 0 } }
  }));
  const content = readSequence(vst);
  assert.deepEqual(content.scenes.map((scene) => [scene.id, scene.name]),
    [['A1', 'Intro'], ['B1', 'Scene B1'], ['C1', 'Scene C1'], ['D1', 'Scene D1']], 'a name of its own is kept');
  assert.deepEqual(content.scenes[0].channels[0].steps[0].value.fixed, { type: VALUE_TYPE.choice, value: 3 });
  assert.equal(recallOf(content).choices.find((choice) => choice.id === 3).label, 'Scene D1', 'value 3 is still D');
  assert.deepEqual(sequenceErrors(content, targetFinder(content)), []);
});

test('scenes are made at a place, only once, and never past thirty-two', () => {
  let content = createSequence();
  content = addScene(content, 'B3');
  content = storeSceneAt(content, 0, 'A2');
  assert.deepEqual(content.scenes.map((scene) => scene.id), ['A1', 'B1', 'C1', 'D1', 'B3', 'A2'], 'the list only grows');
  assert.equal(addScene(content, 'B3'), content, 'a place holds one scene');
  assert.equal(addScene(content, 'E1'), content, 'there is no E');
  assert.equal(sceneIndex(content, 'A2'), 5);
  assert.deepEqual(recallOf(content).choices.map((choice) => `${choice.id}:${choice.label}`),
    ['0:Scene A1', '5:Scene A2', '1:Scene B1', '4:Scene B3', '2:Scene C1', '3:Scene D1'],
    'a recall lists scenes in the deck\'s order, each by its index');
  for (const place of SCENE_PLACES) content = addScene(content, place);
  assert.equal(content.scenes.length, 32);
  assert.deepEqual(sequenceErrors(content, targetFinder(content)), []);
  assert.throws(() => readSequence({ ...content, scenes: [...content.scenes, { ...content.scenes[0], id: 'Z9' }] }),
    /at most 32 scenes/);
});

test('a scene with no place, or a place taken twice, is given the first place free', () => {
  const base = createSequence();
  const content = readSequence({
    ...base,
    scenes: [{ ...base.scenes[0], id: 'Verse', name: 'Scene Verse' }, { ...base.scenes[1], id: 'A1' }, { ...base.scenes[2], id: 'A1', name: 'Mine' }]
  });
  assert.deepEqual(content.scenes.map((scene) => [scene.id, scene.name]),
    [['A2', 'Scene A2'], ['A1', 'Scene B1'], ['A3', 'Mine']]);
  assert.deepEqual(sequenceErrors({ ...content, scenes: [{ ...content.scenes[0], id: 'Verse' }] }, targetFinder(content)),
    ['Missing or duplicate scene ID']);
});

// ---------- requests ----------

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

test('requests name scenes by place, make them, and copy into a free place', async () => {
  const api = mockApi();
  const hub = createHub(api);
  await hub.engine.init();
  hub.project._loading = false;
  const ring = hub.nodes.create('one-ring');
  await settle();
  const ask = (body) => handleOneRingRequest(hub, ring.id, body);
  const content = () => hub.nodes.get(ring.id).content;

  const described = await ask({ kind: 'describe' });
  assert.deepEqual(described.scenes.map((scene) => scene.id), ['A1', 'B1', 'C1', 'D1']);
  assert.ok(described.kinds.includes('new-scene'));

  const missing = await ask({ kind: 'scene', scene: 'A3' });
  assert.deepEqual(missing, { ok: false, reason: 'refused', message: 'scene: no scene at A3 yet: new-scene makes one' });
  const made = await ask({ kind: 'new-scene', scene: 'a3' });
  assert.deepEqual(made, { ok: true, changed: true, scene: { index: 4, id: 'A3', name: 'Scene A3' } });
  assert.equal((await ask({ kind: 'new-scene', scene: 'A3' })).message, 'scene: A3 already has a scene: copy-scene writes over it');
  assert.equal((await ask({ kind: 'new-scene', scene: 'E1' })).message, 'scene: a place from "A1" to "D8"');

  await ask({ kind: 'set', scene: 'A1', channels: [{ channel: 1, target: 'one-ring:channel:2', command: 'START',
    steps: [{ step: 1, enabled: true }] }] });
  const copied = await ask({ kind: 'new-scene', scene: 'C4', from: 'A' });
  assert.deepEqual(copied.scene, { index: 5, id: 'C4', name: 'Scene C4' });
  assert.deepEqual(content().scenes[5].channels, content().scenes[0].channels, 'made as a copy of A1');
  const into = await ask({ kind: 'copy-scene', from: 'C4', to: 'D2' });
  assert.deepEqual(into, { ok: true, changed: true, scene: { index: 6, id: 'D2', name: 'Scene D2' } });
  const over = await ask({ kind: 'copy-scene', from: 'A3', to: 'D2' });
  assert.deepEqual(over.scene, { index: 6, id: 'D2', name: 'Scene D2' });
  assert.deepEqual(content().scenes[6].channels, content().scenes[4].channels, 'an existing place is written over');

  const got = await ask({ kind: 'get', scene: 'D2', channel: 1 });
  assert.deepEqual(got.scene, { index: 6, id: 'D2', name: 'Scene D2' });
  assert.deepEqual(got.scenes.map((scene) => scene.id), ['A1', 'A3', 'B1', 'C1', 'C4', 'D1', 'D2']);
  assert.deepEqual(await ask({ kind: 'scene', scene: 'Scene C4' }), { ok: true, scene: { index: 5, id: 'C4', name: 'Scene C4' } });
  assert.equal(content().selectedScene, 5);
});
