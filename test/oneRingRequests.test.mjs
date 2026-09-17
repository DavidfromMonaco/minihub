import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from '../src/renderer/js/core/hub.js';
import { setupEditHistory } from '../src/renderer/js/core/editHistory.js';
import { handleAgentRequest } from '../src/renderer/js/core/agentRequests.js';
import { describeSetup } from '../src/renderer/js/core/agentDescribe.js';
import { handleOneRingRequest, REQUEST_KINDS } from '../src/renderer/js/core/oneRingRequests.js';
import { CONDITION, VALUE_MODE, cellAt } from '../src/renderer/js/core/oneRingSequence.js';

/**
 * Contract: a One Ring node answers One Ring's own requests -- the VST's words
 * and shapes -- from its content and its runtime, and edits it only as its page
 * can. A refusal names the field and leaves the sequence as it was.
 */

const settle = () => new Promise((resolve) => setImmediate(resolve));

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
  const mixer = hub.nodes.create('mixer');
  const arp = hub.nodes.create('arpeggiator');
  hub.network.connect(ring.id, 'ctrl-out', mixer.id, 'ctrl-in');
  hub.network.connect(ring.id, 'ctrl-out', arp.id, 'ctrl-in');
  await settle();
  const ask = (body) => handleOneRingRequest(hub, ring.id, body);
  let generation = 0;
  const announce = () => {
    generation += 1;
    api.emitEvent({ type: 'oneRingSynced', nodeId: ring.id, generation, created: true, ok: true, message: '' });
    return generation;
  };
  const content = () => hub.nodes.get(ring.id).content;
  const sent = (type) => api.sent.filter((msg) => msg.type === type);
  return { api, hub, ring, mixer, arp, ask, announce, content, sent };
}

test('describe names the kinds, how values are written, the status and what CTRL OUT reaches', async () => {
  const { ring, mixer, arp, ask } = await rig();
  const answer = await ask({ kind: 'describe' });
  assert.equal(answer.ok, true);
  assert.deepEqual(answer.kinds, [...REQUEST_KINDS]);
  assert.deepEqual(answer.node, { id: ring.id, name: ring.name });
  assert.match(answer.values.conditions, /"every"/);
  assert.equal(answer.status.ready, false);
  assert.equal(answer.status.running, false);
  assert.equal(answer.status.channels.length, 16);
  const ids = answer.targets.map((target) => target.id);
  assert.ok(ids.includes('one-ring:channel:1') && ids.includes('one-ring:scenes'));
  assert.ok(ids.includes(mixer.id) && ids.includes(arp.id));
  const master = answer.targets.find((target) => target.id === mixer.id).commands.find((command) => command.id === 'MASTER');
  assert.deepEqual(master, { id: 'MASTER', label: 'Master', type: 'number', min: 0, max: 2 });
  const start = answer.targets.find((target) => target.id === 'one-ring:channel:1').commands.find((command) => command.id === 'START');
  assert.equal(start.release, 'STOP');
  const only = await ask({ kind: 'targets', target: arp.id });
  assert.deepEqual(only.targets.map((target) => target.id), [arp.id]);
  const rate = only.targets[0].commands.find((command) => command.id === 'RATE');
  assert.deepEqual(rate.choices.map((choice) => choice.label), ['1/4', '1/8', '1/16', '1/32']);
});

test('set programs a channel whole, and get gives it back in the shape set takes', async () => {
  const { hub, mixer, arp, ask, content } = await rig();
  setupEditHistory(hub, { apply: async () => {}, quietMs: 5 });
  hub.history.start();
  const answer = await ask({
    kind: 'set',
    scene: 'B',
    sceneTiming: 'next-bar',
    channels: [
      { channel: 1, target: mixer.id, command: 'MASTER', length: 8, resolution: '1/8', repeats: 4, swing: 20,
        steps: [
          { step: 1, enabled: true, value: 1.5 },
          { step: 3, enabled: true, value: { min: 0.25, max: 0.75 }, probability: 60, conditions: [{ every: 2 }, 'first'] },
          { step: 5, enabled: true, value: { oneOf: [0, 2] }, locked: true, lockedFields: ['value'] }
        ] },
      { channel: 2, target: arp.id, command: 'RATE', repeats: 'loop', mode: 'trigger', offset: -2,
        steps: [{ step: 2, enabled: true, value: '1/16', conditions: [{ ifActive: 1 }] }],
        follow: [{ target: 'one-ring:scenes', command: 'RECALL', value: 'Scene C1' }] }
    ]
  });
  assert.equal(answer.ok, true, answer.message);
  assert.equal(answer.changed, true);
  assert.deepEqual(answer.scene, { index: 1, id: 'B1', name: 'Scene B1' });
  assert.equal(content().sceneTiming, 1);

  const one = content().scenes[1].channels[0];
  assert.deepEqual([one.length, one.numerator, one.denominator, one.repeats, one.swing], [8, 1, 8, 4, 0.2]);
  assert.deepEqual(cellAt(one, 0).value.fixed, { type: 3, value: 1.5 });
  const third = cellAt(one, 2);
  assert.equal(third.value.mode, VALUE_MODE.range);
  assert.deepEqual([third.value.min.value, third.value.max.value, third.probability], [0.25, 0.75, 60]);
  assert.deepEqual(third.conditions, [
    { kind: CONDITION.everyNth, interval: 2, channel: 0 }, { kind: CONDITION.first, interval: 2, channel: 0 }
  ]);
  const two = content().scenes[1].channels[1];
  assert.equal(cellAt(two, 1).value.fixed.value, 2, 'a choice given by its label is kept by its id');
  assert.deepEqual(cellAt(two, 1).conditions, [{ kind: CONDITION.ifActive, interval: 2, channel: 0 }]);
  assert.deepEqual(two.follow[0].value.fixed, { type: 4, value: 2 });

  const got = await ask({ kind: 'get', scene: 1, channel: 1 });
  assert.equal(got.ok, true);
  assert.equal(got.sceneTiming, 'next-bar');
  assert.deepEqual(got.channels, [{
    channel: 1, target: mixer.id, command: 'MASTER', length: 8, resolution: '1/8', repeats: 4, mode: 'trigger',
    enabled: true, offset: 0, swing: 20, humanize: 0, mutable: ['enabled', 'probability', 'value'],
    steps: [
      { step: 1, enabled: true, value: 1.5 },
      { step: 3, enabled: true, value: { min: 0.25, max: 0.75 }, probability: 60, conditions: [{ every: 2 }, 'first'] },
      { step: 5, enabled: true, value: { oneOf: [0, 2] }, locked: true, lockedFields: ['value'] }
    ],
    follow: []
  }]);
  const second = (await ask({ kind: 'get', scene: 'Scene B1', channel: 2 })).channels[0];
  assert.equal(second.repeats, 'loop');
  assert.equal(second.offset, -2);
  assert.deepEqual(second.steps, [{ step: 2, enabled: true, value: '1/16', conditions: [{ ifActive: 1 }] }]);
  assert.deepEqual(second.follow, [{ target: 'one-ring:scenes', command: 'RECALL', value: 'Scene C1' }]);

  const again = await ask({ kind: 'set', scene: 1, channels: got.channels });
  assert.equal(again.ok, true, again.message);
  assert.equal(again.changed, false, 'what get gives, set takes back unchanged');

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(hub.history.canUndo, true, 'a set is an undo step');
});

test('a refusal names the field, and nothing of that set is written', async () => {
  const { mixer, arp, ask, content } = await rig();
  const before = JSON.stringify(content());
  const cases = [
    [{ channels: [{ channel: 1, target: mixer.id, command: 'MASTER', steps: [{ step: 1, value: 3 }] }] },
      /^channels\[0\]\.steps\[0\]\.value: MASTER takes a number from 0 to 2$/],
    [{ channels: [{ channel: 1, target: 'nowhere', command: 'X' }] }, /^channels\[0\]\.target: nowhere is not reachable/],
    [{ channels: [{ channel: 2, target: arp.id, command: 'RATE', mode: 'legato' }] }, /^channels\[0\]\.mode: RATE declares no release/],
    [{ channels: [{ channel: 17 }] }, /^channels\[0\]\.channel: a channel from 1 to 16$/],
    [{ channels: [{ channel: 1, length: 5 }] }, /length/],
    [{ channels: [{ channel: 1, target: arp.id, command: 'RATE', steps: [{ step: 1, value: '1/64' }] }] }, /RATE takes one of "1\/4"/],
    [{ channels: [{ channel: 1, steps: [{ step: 1, conditions: [{ every: 0 }] }] }] }, /every: a whole number of loops/],
    [{ channels: [{ channel: 1, target: mixer.id, command: 'MASTER' }, { channel: 2, swing: 99 }] }, /channels\[1\]\.swing/],
    [{ scene: 'Z' }, /^scene: no scene "Z"/],
    [{ seed: 'abc' }, /^seed:/]
  ];
  for (const [body, message] of cases) {
    const answer = await ask({ kind: 'set', ...body });
    assert.equal(answer.ok, false, JSON.stringify(body));
    assert.equal(answer.reason, 'refused');
    assert.match(answer.message, message);
  }
  assert.equal(JSON.stringify(content()), before, 'no refused set wrote anything');
  assert.equal((await ask({ kind: 'nope' })).reason, 'unknown-request');
  assert.equal((await ask([])).reason, 'invalid-request');
});

test('status reads what the runtime last reported, and the last refusal', async () => {
  const { api, hub, ring, ask, announce } = await rig();
  const generation = announce();
  api.emitEvent({
    type: 'oneRingStatus', nodeId: ring.id, generation, playing: true, beat: 7.5, bpm: 96, scene: 2, pendingScene: 3,
    playheads: [4, -1, ...Array(14).fill(-1)], active: [true, ...Array(15).fill(false)], rejected: 2, guarded: 1
  });
  hub.events.emit('oneRing:refusal', { nodeId: ring.id, message: 'MASTER: not cabled' });
  const status = await ask({ kind: 'status' });
  assert.equal(status.ready, true);
  assert.equal(status.running, true);
  assert.deepEqual([status.beat, status.bpm, status.refused, status.guarded], [7.5, 96, 2, 1]);
  assert.deepEqual(status.scene, { index: 2, id: 'C1', name: 'Scene C1' });
  assert.deepEqual(status.pendingScene, { index: 3, id: 'D1', name: 'Scene D1' });
  assert.deepEqual(status.channels[0], { channel: 1, active: true, step: 5 });
  assert.deepEqual(status.channels[1], { channel: 2, active: false, step: null });
  assert.equal(status.lastRefusal, 'MASTER: not cabled');
  const described = describeSetup(hub).nodes.find((node) => node.id === ring.id);
  assert.equal(described.status.running, true);
  assert.deepEqual(described.status.activeChannels, [1]);
  assert.equal(described.status.lastRefusal, 'MASTER: not cabled');
});

test('run, stop, a channel and a scene go to the runtime; with none, a scene is chosen as performance', async () => {
  const { hub, ask, announce, sent, content } = await rig();
  assert.deepEqual(await ask({ kind: 'run' }), { ok: false, reason: 'not-running' });
  setupEditHistory(hub, { apply: async () => {}, quietMs: 5 });
  hub.history.start();
  hub.project.dirty = false;
  assert.deepEqual(await ask({ kind: 'scene', scene: 'C' }), { ok: true, scene: { index: 2, id: 'C1', name: 'Scene C1' } },
    'a letter alone is its first scene, as the scenes of the VST now read');
  assert.equal(content().selectedScene, 2);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(hub.history.canUndo, false, 'choosing the scene is not an edit');
  assert.equal(hub.project.dirty, false);

  const generation = announce();
  assert.deepEqual(await ask({ kind: 'run' }), { ok: true });
  assert.deepEqual(await ask({ kind: 'channel', channel: 4, command: 'RESTART' }), { ok: true });
  assert.deepEqual(await ask({ kind: 'scene', scene: 1 }), { ok: true });
  assert.deepEqual(await ask({ kind: 'stop' }), { ok: true });
  const refused = await ask({ kind: 'channel', channel: 4, command: 'JUMP' });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /^command: START, STOP/);
  assert.deepEqual(sent('oneRingCommand').map(({ command, channel, name, scene, generation: g }) => ({ command, channel, name, scene, g })), [
    { command: 'run', channel: undefined, name: undefined, scene: undefined, g: generation },
    { command: 'channel', channel: 4, name: 'RESTART', scene: undefined, g: generation },
    { command: 'scene', channel: undefined, name: undefined, scene: 1, g: generation },
    { command: 'stop', channel: undefined, name: undefined, scene: undefined, g: generation }
  ]);
});

test('copy-scene, mutate and new-seed write the sequence as the page does', async () => {
  const { mixer, ask, content } = await rig();
  await ask({ kind: 'set', scene: 0, channels: [{ channel: 1, target: mixer.id, command: 'MASTER',
    steps: Array.from({ length: 16 }, (_, i) => ({ step: i + 1, enabled: true, value: { min: 0, max: 2 } })) }] });
  const copied = await ask({ kind: 'copy-scene', from: 'A', to: 'D' });
  assert.deepEqual(copied, { ok: true, changed: true, scene: { index: 3, id: 'D1', name: 'Scene D1' } });
  assert.deepEqual(content().scenes[3].channels, content().scenes[0].channels);
  assert.equal(content().scenes[3].name, 'Scene D1');

  const seeded = await ask({ kind: 'new-seed', seed: '4815162342' });
  assert.deepEqual(seeded, { ok: true, seed: '4815162342' });
  const mutated = await ask({ kind: 'mutate', scene: 'A', channel: 1 });
  assert.equal(mutated.ok, true);
  assert.equal(mutated.mutation, '1');
  assert.equal(mutated.channels.length, 1);
  assert.notDeepEqual(content().scenes[0].channels[0], content().scenes[3].channels[0], 'the channel varied');
  assert.deepEqual(content().scenes[0].channels[1], content().scenes[3].channels[1], 'only that channel');
  const random = await ask({ kind: 'new-seed' });
  assert.match(random.seed, /^\d+$/);
  assert.equal(content().mutation, '0');
});

test('an agent reaches the node by kind one-ring, gated on the project like plugin', async () => {
  const { hub, ring } = await rig();
  const projectId = hub.project.projectId;
  const stale = await handleAgentRequest(hub, { kind: 'one-ring', nodeId: ring.id, request: { kind: 'status' } });
  assert.equal(stale.reason, 'stale-project');
  const missing = await handleAgentRequest(hub, { kind: 'one-ring', nodeId: 'nope', expectedProjectId: projectId, request: { kind: 'status' } });
  assert.equal(missing.reason, 'node-not-found');
  const status = await handleAgentRequest(hub, { kind: 'one-ring', nodeId: ring.id, expectedProjectId: projectId, request: { kind: 'status' } });
  assert.equal(status.ok, true);
  assert.equal(status.ready, false);
});
