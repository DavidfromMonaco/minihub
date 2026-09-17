import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from '../src/renderer/js/core/hub.js';
import { setupEditHistory } from '../src/renderer/js/core/editHistory.js';
import { VALUE_TYPE } from '../src/renderer/js/core/commandRegistry.js';
import { CHANNEL_COUNT, cellAt, setCell } from '../src/renderer/js/core/oneRingSequence.js';
import { listOmniBoxCategories } from '../src/renderer/js/core/nodeTypes.js';

/**
 * Contract: a One Ring node runs its sequence in the engine and commands what
 * its CTRL OUT is cabled to, through CommandBus, exactly as a plugin does.
 *
 * The rig is the real hub with the engine played by `api`: `oneRingSynced`
 * announces a runtime generation, and packets arrive as `controlEvents`
 * carrying the node -- which is how native one_ring/runtime.h delivers them.
 */

const settle = () => new Promise((resolve) => setImmediate(resolve));

function mockApi() {
  const data = {};
  const sent = [];
  const listeners = { event: [], state: [] };
  return {
    data,
    sent,
    emitEvent(msg) { listeners.event.forEach((cb) => cb(msg)); },
    emitState(state) { listeners.state.forEach((cb) => cb(state)); },
    loadSettings: async () => ({ ...data }),
    saveSettings: async (settings) => { Object.assign(data, settings); return true; },
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
  await settle();
  const sent = (type) => api.sent.filter((msg) => msg.type === type);
  let generation = 0;
  const announce = () => {
    generation += 1;
    api.emitEvent({ type: 'oneRingSynced', nodeId: ring.id, generation, created: true, ok: true, message: '' });
    return generation;
  };
  const source = () => hub.commands.sources.get(`native${ring.id}`);
  const packet = (fields) => ({ sequence: 1, registryRevision: 1, beat: 0, valueType: VALUE_TYPE.none, number: 0, ...fields });
  const play = (events, overrides = {}) => api.emitEvent({
    type: 'controlEvents', nodeId: ring.id, generation, events, ...overrides
  });
  return { api, hub, ring, mixer, sent, announce, source, packet, play, generation: () => generation };
}

test('a One Ring node is a MIDI OmniBox whose CTRL OUT is always drawn', async () => {
  const { hub, ring } = await rig();
  const midi = listOmniBoxCategories().find((category) => category.label === 'MIDI');
  assert.ok(midi.types.some((type) => type.id === 'one-ring'));
  assert.equal(hub.commands.sendsCommands(ring.id), true);
  assert.equal(ring.name, 'One Ring 1');
  assert.equal(ring.content.scenes.length, 4);
});

test('the engine is given the sequence when the node appears, and a source exists once it runs it', async () => {
  const { hub, ring, sent, announce, source } = await rig();
  const [first] = sent('syncOneRing');
  assert.equal(first.nodeId, ring.id);
  assert.equal(first.restore, true);
  assert.deepEqual(first.state, ring.content);
  assert.equal(hub.oneRing.generationOf(ring.id), null);
  assert.equal(source(), undefined, 'no source before the engine says it runs the sequence');
  const generation = announce();
  assert.equal(hub.oneRing.generationOf(ring.id), generation);
  assert.equal(source()?.kind, 'native');
  assert.equal(source().generation, generation);
});

test('cabled, it is told its targets, and its packets move what it is cabled to, as performance', async () => {
  const { api, hub, ring, mixer, sent, announce, packet, play } = await rig();
  announce();
  hub.network.connect(ring.id, 'ctrl-out', mixer.id, 'ctrl-in');
  await settle();
  setupEditHistory(hub, { apply: async () => {}, quietMs: 5 });
  hub.history.start();
  hub.project.dirty = false;
  await new Promise((resolve) => setTimeout(resolve, 20));
  const [targets] = sent('setOneRingTargets');
  assert.equal(targets.nodeId, ring.id);
  assert.equal(targets.registry.version, 1);
  assert.equal(targets.registry.revision, 1);
  const master = targets.registry.modules.find((module) => module.id === mixer.id)
    ?.commands.find((command) => command.id === 'MASTER');
  assert.equal(master?.type, VALUE_TYPE.number);

  const results = [];
  hub.events.on('commands:result', (result) => results.push(result));
  play([packet({ target: mixer.id, command: 'MASTER', valueType: VALUE_TYPE.number, number: 0.25 })]);
  assert.equal(hub.nodes.get(mixer.id).content.masterLevel, 0.25);
  assert.deepEqual(results.map((result) => result.ok), [true]);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(hub.history.canUndo, false, 'a played command is not an undo step');
  assert.equal(hub.project.dirty, false, 'nor a modification of the project');

  const refusals = [];
  hub.events.on('oneRing:refusal', (msg) => refusals.push(msg));
  hub.network.disconnect(ring.id, 'ctrl-out', mixer.id, 'ctrl-in');
  await settle();
  play([packet({ sequence: 2, target: mixer.id, command: 'MASTER', valueType: VALUE_TYPE.number, number: 0.75 })]);
  assert.equal(hub.nodes.get(mixer.id).content.masterLevel, 0.25, 'a pulled cable stops it');
  assert.equal(results.at(-1).reason, 'target-not-connected');
  assert.deepEqual(refusals.map((msg) => msg.nodeId), [ring.id]);
  assert.match(refusals[0].message, /^MASTER: not cabled/);
  assert.equal(api.sent.filter((msg) => msg.type === 'setControlStatus').length, 0,
    'a native source has no plugin window to write to');
});

test('a packet from another runtime generation, or before the targets, is not carried out', async () => {
  const { hub, ring, mixer, announce, packet, play, generation } = await rig();
  announce();
  hub.network.connect(ring.id, 'ctrl-out', mixer.id, 'ctrl-in');
  await settle();
  play([packet({ target: mixer.id, command: 'MASTER', valueType: VALUE_TYPE.number, number: 0.5 })],
    { generation: generation() + 1 });
  assert.equal(hub.nodes.get(mixer.id).content.masterLevel, 1);
  play([packet({ registryRevision: 0, target: mixer.id, command: 'MASTER', valueType: VALUE_TYPE.number, number: 0.5 })]);
  assert.equal(hub.nodes.get(mixer.id).content.masterLevel, 1);
  play([packet({ target: mixer.id, command: 'MASTER', valueType: VALUE_TYPE.number, number: 0.5 })],
    { nodeId: undefined, chainId: ring.id, instanceId: 'plugin-1', pluginId: 'x' });
  assert.equal(hub.nodes.get(mixer.id).content.masterLevel, 1, 'a plugin-shaped message does not reach a native source');
  // The refused packet used sequence 1: a packet is never replayed, refused or not.
  play([packet({ target: mixer.id, command: 'MASTER', valueType: VALUE_TYPE.number, number: 0.5 })]);
  assert.equal(hub.nodes.get(mixer.id).content.masterLevel, 1);
  play([packet({ sequence: 2, target: mixer.id, command: 'MASTER', valueType: VALUE_TYPE.number, number: 0.5 })]);
  assert.equal(hub.nodes.get(mixer.id).content.masterLevel, 0.5);
});

test('a renderer that opens while the engine runs sends the sequences once the engine answers', async () => {
  const api = mockApi();
  api.data.nodeInstances = undefined;
  const hub = createHub(api);
  const ring = hub.nodes.create('one-ring');
  assert.equal(api.sent.filter((msg) => msg.type === 'syncOneRing').length, 0, 'no engine known yet');
  await hub.engine.init();
  assert.equal(api.sent.filter((msg) => msg.type === 'syncOneRing').length, 0,
    'the engine client learns it runs without saying so');
  api.emitEvent({ type: 'deviceState', ok: true });
  api.emitEvent({ type: 'deviceState', ok: true });
  const syncs = api.sent.filter((msg) => msg.type === 'syncOneRing');
  assert.deepEqual(syncs.map((msg) => [msg.nodeId, msg.restore]), [[ring.id, true]], 'once, as saved');
});

test('an edit is sent as an edit; a scene the engine reports is kept without being sent back', async () => {
  const { api, hub, ring, sent, announce } = await rig();
  setupEditHistory(hub);
  hub.history.start();
  const generation = announce();
  const channel = ring.content.scenes[0].channels[2];
  const edited = structuredClone(ring.content);
  edited.scenes[0].channels[2] = setCell(channel, 5, { ...cellAt(channel, 5), enabled: true });
  hub.nodes.setContent(ring.id, edited);
  const syncs = sent('syncOneRing');
  assert.equal(syncs.length, 2);
  assert.equal(syncs[1].restore, false);
  assert.equal(syncs[1].state.scenes[0].channels[2].steps[0].index, 5);

  const statuses = [];
  hub.events.on('oneRing:status', (msg) => statuses.push(msg.status));
  api.emitEvent({
    type: 'oneRingStatus', nodeId: ring.id, generation, playing: true, beat: 3.5, bpm: 120, scene: 2,
    playheads: Array(CHANNEL_COUNT).fill(1), active: Array(CHANNEL_COUNT).fill(true), rejected: 0, guarded: 0
  });
  assert.equal(statuses.length, 1);
  assert.equal(hub.oneRing.statusOf(ring.id).scene, 2);
  assert.equal(hub.oneRing.statusOf(ring.id).pendingScene, -1, 'no recall waiting for a bar');
  assert.equal(hub.oneRing.anyPlaying(), true);
  assert.equal(hub.nodes.get(ring.id).content.selectedScene, 2, 'the scene that plays is what the project saves');
  assert.equal(sent('syncOneRing').length, 2, 'a new plan would release what Legato holds');
  api.emitEvent({ type: 'oneRingStatus', nodeId: ring.id, generation: generation + 1, playing: false, scene: 0 });
  assert.equal(statuses.length, 1, 'a status from another runtime is not this node\'s');
});

test('deleting the node takes its runtime away and releases what it held', async () => {
  const { hub, ring, mixer, sent, announce, source } = await rig();
  announce();
  hub.network.connect(ring.id, 'ctrl-out', mixer.id, 'ctrl-in');
  await settle();
  source().held.set('fake', { targetId: 'nowhere', routeNodeId: mixer.id, lifetime: 'null', release: 'STOP' });
  hub.nodes.delete(ring.id);
  await settle();
  assert.deepEqual(sent('removeOneRing').map((msg) => msg.nodeId), [ring.id]);
  assert.equal(source(), undefined);
  assert.equal(hub.oneRing.generationOf(ring.id), null);
});

test('an engine that restarts is given every sequence again, as saved', async () => {
  const { api, hub, ring, sent, announce, source } = await rig();
  announce();
  api.emitState({ state: 'stopped', error: null });
  assert.equal(hub.oneRing.generationOf(ring.id), null);
  assert.equal(source(), undefined);
  const before = sent('syncOneRing').length;
  api.emitState({ state: 'running', error: null });
  api.emitState({ state: 'running', error: null });
  const again = sent('syncOneRing').slice(before);
  assert.equal(again.length, 1, 'once per restart, not once per repeated state');
  assert.equal(again[0].restore, true);
});

test('RUN, STOP, a channel and a scene go to the runtime the node has, and nothing without one', async () => {
  const { hub, ring, sent, announce } = await rig();
  assert.deepEqual(await hub.oneRing.command(ring.id, 'run'), { ok: false, reason: 'not-running' });
  const generation = announce();
  await hub.oneRing.command(ring.id, 'run');
  await hub.oneRing.command(ring.id, 'channel', { channel: 3, name: 'RESTART' });
  await hub.oneRing.command(ring.id, 'scene', { scene: 1 });
  assert.deepEqual(await hub.oneRing.command(ring.id, 'scene', { scene: 4 }), { ok: false, reason: 'invalid-command' });
  assert.deepEqual(await hub.oneRing.command(ring.id, 'channel', { channel: 17, name: 'START' }),
    { ok: false, reason: 'invalid-command' });
  assert.deepEqual(await hub.oneRing.command(ring.id, 'mutate'), { ok: false, reason: 'invalid-command' });
  assert.deepEqual(sent('oneRingCommand').map(({ command, channel, name, scene, generation: g }) => ({ command, channel, name, scene, g })), [
    { command: 'run', channel: undefined, name: undefined, scene: undefined, g: generation },
    { command: 'channel', channel: 3, name: 'RESTART', scene: undefined, g: generation },
    { command: 'scene', channel: undefined, name: undefined, scene: 1, g: generation }
  ]);
});

test('a refused sequence is said on the node, and sent again at the next change', async () => {
  const { api, hub, ring, sent } = await rig();
  const refused = [];
  hub.events.on('oneRing:refused', (msg) => refused.push(msg));
  api.emitEvent({ type: 'oneRingSynced', nodeId: ring.id, generation: 0, ok: false, message: 'Invalid timing parameters' });
  assert.deepEqual(refused, [{ nodeId: ring.id, message: 'Invalid timing parameters' }]);
  const before = sent('syncOneRing').length;
  hub.oneRing.sync(ring.id);
  assert.equal(sent('syncOneRing').length, before + 1);
});
