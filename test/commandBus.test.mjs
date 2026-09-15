import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from '../src/renderer/js/core/hub.js';
import { createSequencerModule } from '../src/renderer/js/modules/sequencer/sequencerModule.js';
import { createAudioOutputModule } from '../src/renderer/js/modules/audioOutput/audioOutputModule.js';
import {
  VALUE_TYPE, acceptsValue, action, choice, compileTargets, integer, number, packetValue, toggle
} from '../src/renderer/js/core/commandRegistry.js';
import { COMMAND_INPUT } from '../src/renderer/js/core/nodeTypes.js';
import { CONTROLLER_NODE_IDS } from '../src/renderer/js/core/systemNodes.js';
import { setupEditHistory } from '../src/renderer/js/core/editHistory.js';

/**
 * Contract: a plugin on a CTRL OUT cable commands exactly what it is cabled to,
 * through the module that owns each target, as performance rather than edits.
 *
 * The rig is the real hub -- network, node instances, sequencer controller,
 * settings store, edit history -- with the engine played by `api`: a chain
 * report says a plugin sends commands, and packets arrive as `controlEvents`,
 * which is exactly how the native engine delivers them.
 */

const ONE_RING = 'C:\\VST3\\ONE RING.vst3';
const settle = () => new Promise((resolve) => setImmediate(resolve));

function mockApi() {
  const data = {};
  const sent = [];
  const saves = [];
  const listeners = { event: [], state: [] };
  return {
    data,
    sent,
    saves,
    emitEvent(msg) { listeners.event.forEach((cb) => cb(msg)); },
    emitState(state) { listeners.state.forEach((cb) => cb(state)); },
    loadSettings: async () => ({ ...data }),
    saveSettings: async (settings) => { saves.push(settings); Object.assign(data, settings); return true; },
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
  hub.modules.register(createAudioOutputModule(hub));
  hub.sequencer.load();
  hub.modules.register(createSequencerModule(hub));
  hub.nodes.create('sequencer');

  const ring = hub.nodes.create('vst');
  const plugin = hub.nodes.getChain(ring.id).append({ pluginId: ONE_RING, name: 'ONE RING', role: 'audio-effect' });
  let generation = 1;
  const report = (instances) => api.emitEvent({ type: 'chainChanged', chainId: ring.id, instances });
  const instance = (overrides = {}) => ({
    instanceId: plugin.id, pluginId: ONE_RING, name: 'ONE RING', role: 'audio-effect',
    bypassed: false, generation, controlSource: true, status: 'ready', ...overrides
  });
  report([instance()]);
  // What the engine sends next, and what chainSync restores the saved state on.
  api.emitEvent({ type: 'instanceStatus', chainId: ring.id, instanceId: plugin.id, pluginId: ONE_RING, generation, status: 'ready' });
  await settle();

  const source = () => hub.commands.sources.get(`${ring.id}\u001f${plugin.id}`);
  const registries = () => api.sent.filter((msg) => msg.type === 'setControlRegistry');
  const statuses = () => api.sent.filter((msg) => msg.type === 'setControlStatus').map((msg) => msg.message);
  const results = [];
  hub.events.on('commands:result', (result) => results.push(result));

  async function cable(nodeId) {
    hub.network.connect(ring.id, 'ctrl-out', nodeId, 'ctrl-in');
    await settle();
  }

  /** A packet as the engine forwards it, stamped with the latest published revision. */
  function send(target, command, valueType = VALUE_TYPE.none, value = 0, overrides = {}) {
    const live = source();
    api.emitEvent({
      type: 'controlEvents', chainId: ring.id, instanceId: plugin.id, pluginId: ONE_RING, generation,
      events: [{
        sequence: (live?.sequence ?? 0) + 1, registryRevision: live?.revision ?? 0, beat: 0,
        target, command, valueType, number: value, ...overrides
      }]
    });
    return results.at(-1);
  }

  function readyToRecord() {
    const track = hub.sequencer.addTrack('midi');
    hub.midi.selectedInputId = 'selected-midi';
    hub.network.addNode({
      id: CONTROLLER_NODE_IDS[0], name: 'Keyboard', type: 'midi-output',
      inputs: [{ id: 'midi-in', type: 'midi', label: 'MIDI IN' }],
      outputs: [{ id: 'midi-out', type: 'midi', label: 'MIDI OUT' }, { id: 'control-k1', type: 'control', label: 'K1' }]
    });
    hub.sequencer.setTrack(track.id, { armed: true, inputId: 'selected-midi' });
    hub.network.connect(CONTROLLER_NODE_IDS[0], 'midi-out', 'sequencer', 'midi-in');
    assert.equal(hub.sequencer.recordBlockReason(), '');
    return track;
  }

  const setGeneration = (next) => { generation = next; };
  return { api, hub, ring, plugin, report, instance, source, registries, statuses, results, cable, send, readyToRecord, setGeneration };
}

// ---- the registry ----------------------------------------------------------------

test('a provider mistake fails at compile time, where the plugin would refuse the whole list', () => {
  const run = () => true;
  const target = (commands, id = 'node') => [{ id, label: 'Node', commands }];
  assert.throws(() => compileTargets(target([action('', 'Empty', run)])), /invalid command/);
  assert.throws(() => compileTargets(target([action('X'.repeat(128), 'Long', run)])), /invalid command/,
    'a command id must fit the plugin buffer with its terminator');
  assert.throws(() => compileTargets(target([], 'T'.repeat(256))), /invalid or duplicate/);
  assert.throws(() => compileTargets([...target([]), ...target([])]), /invalid or duplicate/);
  assert.throws(() => compileTargets(target([toggle('A', 'A', run), toggle('A', 'Again', run)])), /duplicate command/);
  assert.throws(() => compileTargets(target([number('N', 'N', 1, 0, run)])), /invalid range/);
  assert.throws(() => compileTargets(target([integer('I', 'I', 0, 1.5, run)])), /invalid integer range/);
  assert.throws(() => compileTargets(target([choice('C', 'C', [], run)])), /offers no choice/);
  assert.throws(() => compileTargets(target([{ ...choice('C', 'C', ['a'], run), choices: [{ id: 0, label: 'a' }, { id: 0, label: 'b' }] }])), /invalid choice/);
  assert.throws(() => compileTargets(target([action('ON', 'On', run, 'OFF')])), /lacks/,
    'a release must name a command the target has');
  assert.throws(() => compileTargets(target([{ ...toggle('T', 'T', run), release: 'OFF' }])), /invalid release/);

  const [compiled] = compileTargets(target([action('GO', '', run, 'HALT'), action('HALT', 'Halt', run)]));
  assert.deepEqual(compiled.descriptor, {
    id: 'node', label: 'Node', commands: [
      { id: 'GO', label: 'GO', type: 0, releaseCommand: 'HALT', releaseValue: { type: 0 } },
      { id: 'HALT', label: 'Halt', type: 0 }
    ]
  }, 'an empty label falls back to the id, since the plugin refuses empty labels');
  assert.equal(typeof compiled.commands.get('GO').execute, 'function');
  assert.equal('execute' in compiled.descriptor.commands[0], false, 'nothing executable is sent to the plugin');
});

test('values are checked against what the command declared', () => {
  const [target] = compileTargets([{ id: 't', label: 't', commands: [
    toggle('B', 'B', () => true), integer('I', 'I', 1, 8, () => true),
    number('F', 'F', 0, 1, () => true), choice('C', 'C', ['x', 'y'], () => true)
  ] }]);
  const get = (id) => target.commands.get(id);
  assert.equal(acceptsValue(get('B'), true), true);
  assert.equal(acceptsValue(get('B'), 1), false);
  assert.equal(acceptsValue(get('I'), 8), true);
  assert.equal(acceptsValue(get('I'), 2.5), false);
  assert.equal(acceptsValue(get('I'), 9), false);
  assert.equal(acceptsValue(get('F'), 0.5), true);
  assert.equal(acceptsValue(get('F'), Number.NaN), false);
  assert.equal(acceptsValue(get('C'), 1), true);
  assert.equal(acceptsValue(get('C'), 2), false);
  assert.deepEqual(packetValue(VALUE_TYPE.boolean, 1), { ok: true, value: true });
  assert.deepEqual(packetValue(VALUE_TYPE.boolean, 0.5), { ok: false });
  assert.deepEqual(packetValue(VALUE_TYPE.none, 42), { ok: true, value: undefined });
  assert.deepEqual(packetValue(VALUE_TYPE.number, Number.POSITIVE_INFINITY), { ok: false });
});

// ---- the cable is the authority -------------------------------------------------------

test("a plugin's saved state goes in before its first list of targets", async () => {
  const api = mockApi();
  const hub = createHub(api);
  await hub.engine.init();
  const node = hub.nodes.create('vst');
  const entry = hub.nodes.getChain(node.id).append({ pluginId: ONE_RING, name: 'ONE RING', role: 'audio-effect' });
  // chainSync's part, registered after the hub as in app.js: the state goes out on READY.
  hub.events.on('engine:instanceStatus', (msg) => {
    if (msg.status === 'ready') hub.engine.setState(node.id, entry.id, 'saved-state', ONE_RING, msg.generation);
  });
  api.emitEvent({ type: 'chainChanged', chainId: node.id, instances: [{
    instanceId: entry.id, pluginId: ONE_RING, bypassed: false, generation: 1, controlSource: true, status: 'ready'
  }] });
  await settle();
  assert.equal(api.sent.some((msg) => msg.type === 'setControlRegistry'), false,
    'the instance exists, but its saved sequence has not been handed back yet');

  api.emitEvent({ type: 'instanceStatus', chainId: node.id, instanceId: entry.id, pluginId: ONE_RING, generation: 1, status: 'ready' });
  await settle();
  const order = api.sent.map((msg) => msg.type).filter((type) => type === 'setState' || type === 'setControlRegistry');
  assert.deepEqual(order, ['setState', 'setControlRegistry']);
});

test('a plugin is told only what its CTRL OUT is cabled to, and each cable changes the list', async () => {
  const { hub, ring, registries, cable } = await rig();
  assert.equal(hub.commands.sendsCommands(ring.id), true, 'its CTRL OUT has something to send');
  assert.equal(hub.commands.sendsCommands('sequencer'), false);
  assert.deepEqual(registries().at(-1).registry.modules, [], 'no cable, no target -- but the plugin hears that it is connected');

  const arp = hub.nodes.create('arpeggiator');
  hub.nodes.create('mixer');
  await settle();
  assert.deepEqual(registries().at(-1).registry.modules, [], 'a node that exists is not a target');

  await cable(arp.id);
  const modules = registries().at(-1).registry.modules;
  assert.deepEqual(modules.map((module) => module.id), [arp.id]);
  const rate = modules[0].commands.find((command) => command.id === 'RATE');
  assert.deepEqual(rate.choices.map((item) => item.label), ['1/4', '1/8', '1/16', '1/32']);
  assert.equal(registries().at(-1).registry.version, 1);

  hub.network.disconnect(ring.id, 'ctrl-out', arp.id, 'ctrl-in');
  await settle();
  assert.deepEqual(registries().at(-1).registry.modules, []);
});

test('a knob cannot be cabled into a CTRL IN that only takes commands; a plugin can', async () => {
  const { hub, ring } = await rig();
  const arp = hub.nodes.create('arpeggiator');
  hub.network.addNode({
    id: CONTROLLER_NODE_IDS[0], name: 'Keyboard', type: 'midi-output', inputs: [],
    outputs: [{ id: 'midi-out', type: 'midi', label: 'MIDI OUT' }, { id: 'control-k1', type: 'control', label: 'K1' }]
  });
  assert.throws(() => hub.network.connect(CONTROLLER_NODE_IDS[0], 'control-k1', arp.id, 'ctrl-in'), /takes commands/);
  assert.throws(() => hub.network.connect(CONTROLLER_NODE_IDS[0], 'control-k1', 'sequencer', 'ctrl-in'), /takes commands/);
  assert.equal(hub.network.connect(ring.id, 'ctrl-out', arp.id, 'ctrl-in'), true);
  const other = hub.nodes.create('vst');
  assert.equal(hub.network.connect(CONTROLLER_NODE_IDS[0], 'control-k1', other.id, 'ctrl-in'), true,
    "a VST node's CTRL IN still takes a knob, for its bindings");
  assert.equal(hub.network.connect(ring.id, 'ctrl-out', other.id, 'ctrl-in'), true, '...and commands, for its plugins');
});

test('a command reaches the module through its cable, and a pulled cable stops the next one', async () => {
  const { hub, ring, cable, send, statuses } = await rig();
  const arp = hub.nodes.create('arpeggiator');
  await cable(arp.id);

  assert.equal(send(arp.id, 'RATE', VALUE_TYPE.choice, 3).ok, true);
  assert.equal(hub.nodes.get(arp.id).content.rate, '1/32');
  assert.equal(send(arp.id, 'STEP_1_VELOCITY', VALUE_TYPE.integer, 72).ok, true);
  assert.equal(hub.nodes.get(arp.id).content.customPattern[0].velocity, 72);
  assert.equal(send(arp.id, 'RATE', VALUE_TYPE.choice, 3).ok, true, 'a value already in place is not a refusal');

  assert.equal(send(arp.id, 'RATE', VALUE_TYPE.integer, 3).reason, 'wrong-type');
  assert.equal(send(arp.id, 'RATE', VALUE_TYPE.choice, 9).reason, 'invalid-value');
  assert.equal(send(arp.id, 'HOLD').reason, 'unknown-command', 'the arpeggiator has no hold, and none is invented');
  assert.match(statuses().at(-1), /^HOLD: /, "the refusal is shown in the plugin's window");

  hub.network.disconnect(ring.id, 'ctrl-out', arp.id, 'ctrl-in');
  assert.equal(send(arp.id, 'RATE', VALUE_TYPE.choice, 0).reason, 'target-not-connected');
  assert.equal(hub.nodes.get(arp.id).content.rate, '1/32');
});

test('a replayed packet, a replaced instance and an unpublished revision do nothing', async () => {
  const { api, hub, ring, plugin, cable, send, source, results } = await rig();
  const arp = hub.nodes.create('arpeggiator');
  await cable(arp.id);

  assert.equal(send(arp.id, 'RATE', VALUE_TYPE.choice, 0).ok, true);
  const count = results.length;
  api.emitEvent({ type: 'controlEvents', chainId: ring.id, instanceId: plugin.id, pluginId: ONE_RING, generation: 1,
    events: [{ sequence: source().sequence, registryRevision: source().revision, beat: 0, target: arp.id, command: 'RATE', valueType: 4, number: 3 }] });
  assert.equal(results.length, count, 'an old sequence number is dropped');

  assert.equal(send(arp.id, 'RATE', VALUE_TYPE.choice, 3, { registryRevision: source().revision + 1 }).reason, 'unknown-registry');
  api.emitEvent({ type: 'controlEvents', chainId: ring.id, instanceId: plugin.id, pluginId: ONE_RING, generation: 2,
    events: [{ sequence: 999, registryRevision: 1, beat: 0, target: arp.id, command: 'RATE', valueType: 4, number: 3 }] });
  assert.equal(hub.nodes.get(arp.id).content.rate, '1/4', 'packets from another runtime instance are ignored');
});

test('a module registered later is commandable with no change to the bus', async () => {
  const { hub, ring, cable, send, registries } = await rig();
  let fired = 0;
  hub.modules.register({
    id: 'future-module',
    routingNode: { id: 'future-module', name: 'Future', inputs: [COMMAND_INPUT], outputs: [] },
    controlCommands: () => [{ id: 'future-module', label: 'Future', commands: [action('FIRE', 'Fire', () => { fired += 1; return true; })] }]
  });
  await cable('future-module');
  assert.deepEqual(registries().at(-1).registry.modules.map((module) => module.id), ['future-module']);
  assert.equal(send('future-module', 'FIRE').ok, true);
  assert.equal(fired, 1);

  hub.modules.unregister('future-module');
  await settle();
  assert.equal(hub.network.connectionsFrom(ring.id, 'ctrl-out').length, 0);
  assert.equal(send('future-module', 'FIRE').ok, false);
  assert.equal(fired, 1);
});

// ---- performance, not authorship ---------------------------------------------------------

test('what a plugin commands is not an undo step, does not mark the project modified, and saves once', async () => {
  const { api, hub, cable, send } = await rig();
  const mixer = hub.nodes.create('mixer');
  await cable(mixer.id);
  setupEditHistory(hub, { apply: async () => {}, quietMs: 5 });
  hub.history.start();
  hub.project.dirty = false;
  await new Promise((resolve) => setTimeout(resolve, 20));
  const savesBefore = api.saves.length;

  for (let step = 0; step < 20; step += 1) {
    assert.equal(send(mixer.id, 'MASTER', VALUE_TYPE.number, step / 20).ok, true);
  }
  assert.equal(hub.nodes.get(mixer.id).content.masterLevel, 19 / 20, 'the value is in place at once');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(hub.history.canUndo, false, 'Ctrl+Z does not rewind the performance');
  assert.equal(hub.project.dirty, false, 'the project is not marked modified by playing it');
  assert.equal(api.saves.length, savesBefore, 'no save per step');
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(api.saves.length, savesBefore + 1, 'one save for the whole burst');

  // The write that used to turn the performance into a step: a plugin's state
  // captured after a knob moved -- recorded like any write, stepped on by nothing.
  const ring = hub.nodes.list().find((node) => node.type === 'vst');
  const plugin = ring.content.plugins[0];
  assert.equal(hub.nodes.setPluginState(ring.id, plugin.id, plugin.pluginId, 'captured-after-a-knob'), true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(hub.history.canUndo, false, 'what was performed before it is part of the present, not of a step');

  hub.nodes.create('morpher');
  assert.equal(hub.project.dirty, true, 'an edit by hand still marks it');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(hub.history.canUndo, true, 'and is still a step');
  const undone = hub.history.history.undo();
  assert.equal(undone.nodeInstances.instances.find((entry) => entry.id === mixer.id).content.masterLevel, 19 / 20,
    'undoing the edit does not rewind what was played before it');
});

// ---- the Sequencer and Record -------------------------------------------------------------------

test('Record through a cable keeps the guards of the Record button, and says why it refuses', async () => {
  const { api, hub, cable, send, statuses, readyToRecord } = await rig();
  await cable('sequencer');
  const records = () => api.sent.filter((msg) => msg.type === 'sequencerRecord').map((msg) => msg.enabled);

  const reason = hub.sequencer.recordBlockReason();
  assert.ok(reason, 'a fresh project is not ready to record');
  const refused = send('sequencer', 'RECORD_ON');
  assert.equal(refused.ok, false);
  assert.equal(statuses().at(-1), `RECORD_ON: ${reason}`, 'the sentence the Sequencer page would show');
  assert.equal(hub.sequencer.recording, false);

  readyToRecord();
  await settle();
  assert.equal(send('sequencer', 'RECORD_ON').ok, true);
  assert.equal(send('sequencer', 'RECORD_ON').ok, true, 'a repeated RECORD_ON is not a second take');
  assert.deepEqual(records(), [true]);
  assert.equal(statuses().at(-1), '', 'the success of the refused command clears the message');

  assert.equal(send('sequencer', 'RECORD_OFF').ok, true);
  assert.equal(hub.sequencer.recording, false);
  assert.equal(hub.sequencer.playing, true, 'ending the take leaves the transport running');
  assert.deepEqual(records(), [true, false]);

  assert.equal(send('sequencer', 'STOP').ok, true);
  assert.equal(hub.sequencer.playing, false);
  assert.equal(send('sequencer', 'TEMPO', VALUE_TYPE.integer, 140).ok, true);
  assert.equal(hub.sequencer.tempo, 140);
  assert.equal(send('sequencer', 'TEMPO', VALUE_TYPE.number, 140.5).reason, 'wrong-type', 'the tempo is a whole number');
});

test('a track is a target of its own, and disappears from the list with the track', async () => {
  const { hub, cable, send, registries } = await rig();
  const track = hub.sequencer.addTrack('midi');
  await cable('sequencer');
  const trackTarget = `sequencer:track:${track.id}`;
  assert.ok(registries().at(-1).registry.modules.some((module) => module.id === trackTarget));

  assert.equal(send(trackTarget, 'MUTE', VALUE_TYPE.boolean, 1).ok, true);
  assert.equal(hub.sequencer.model.state.tracks.find((item) => item.id === track.id).muted, true);
  const position = hub.sequencer.model.state.tracks.findIndex((item) => item.id === track.id) + 1;
  assert.equal(send('sequencer', 'TRACK_SELECT', VALUE_TYPE.integer, position).ok, true);
  assert.equal(hub.sequencer.model.state.focusedTrackId, track.id);

  hub.sequencer.removeTrack(track.id);
  await settle();
  assert.equal(registries().at(-1).registry.modules.some((module) => module.id === trackTarget), false);
  assert.equal(send(trackTarget, 'MUTE', VALUE_TYPE.boolean, 0).reason, 'target-not-connected');
});

// ---- what is held is released once ------------------------------------------------------------------

test('a PLAY is stopped when its cable is pulled, and a RECORD_ON when its plugin leaves', async () => {
  const { hub, ring, report, instance, cable, send, readyToRecord } = await rig();
  await cable('sequencer');
  assert.equal(send('sequencer', 'PLAY').ok, true);
  assert.equal(hub.sequencer.playing, true);
  hub.network.disconnect(ring.id, 'ctrl-out', 'sequencer', 'ctrl-in');
  assert.equal(hub.sequencer.playing, false, 'the plugin can no longer send the STOP it declared, so the bus does');

  readyToRecord();
  await cable('sequencer');
  assert.equal(send('sequencer', 'RECORD_ON').ok, true);
  report([instance({ bypassed: true })]);
  assert.equal(hub.sequencer.recording, false, 'bypassing the plugin releases what it held');

  report([instance()]);
  await settle();
  assert.equal(send('sequencer', 'PLAY').ok, true);
  assert.equal(send('sequencer', 'STOP').ok, true);
  assert.equal(send('sequencer', 'PLAY').ok, true);
  hub.sequencer.stopTransport();
  hub.sequencer.playTransport();
  hub.network.disconnect(ring.id, 'ctrl-out', 'sequencer', 'ctrl-in');
  assert.equal(hub.sequencer.playing, false, 'the last PLAY was still held');
});

test('a project being replaced forgets what was held without sending anything into the next one', async () => {
  const { api, hub, ring, cable, send, readyToRecord } = await rig();
  readyToRecord();
  await cable('sequencer');
  assert.equal(send('sequencer', 'RECORD_ON').ok, true);
  hub.project._transitionPending = true;
  assert.equal(send('sequencer', 'RECORD_OFF').reason, 'project-transition');
  hub.network.disconnect(ring.id, 'ctrl-out', 'sequencer', 'ctrl-in');
  assert.deepEqual(api.sent.filter((msg) => msg.type === 'sequencerRecord').map((msg) => msg.enabled), [true]);
  assert.equal(hub.commands.sources.values().next().value.held.size, 0);
});

// ---- the other built-in targets ------------------------------------------------------------------------

test('Mixer, Morpher and Audio Output values follow their commands', async () => {
  const { hub, cable, send } = await rig();
  const mixer = hub.nodes.create('mixer');
  const morpher = hub.nodes.create('morpher');
  await cable(mixer.id);
  await cable(morpher.id);
  await cable('audio-output');

  assert.equal(send(mixer.id, 'audio-in-1:MUTE', VALUE_TYPE.boolean, 1).ok, true);
  assert.equal(hub.nodes.get(mixer.id).content.inputs[0].muted, true);
  assert.equal(send(morpher.id, 'STEPS', VALUE_TYPE.choice, 2).ok, true);
  assert.equal(hub.nodes.get(morpher.id).content.stepCount, 16);
  assert.equal(send(morpher.id, 'STEP_3', VALUE_TYPE.number, 0.75).ok, true);
  assert.equal(hub.nodes.get(morpher.id).content.steps[2], 0.75);
  assert.equal(send('audio-output', 'GAIN_DB', VALUE_TYPE.number, -6).ok, true);
  assert.equal(hub.settings.get('masterOutput').gainDb, -6);
  assert.equal(send('audio-output', 'GAIN_DB', VALUE_TYPE.number, 20).reason, 'invalid-value');
});

test("a mixer's CTRL IN stays below its audio inputs as they grow", async () => {
  const { hub, ring } = await rig();
  const mixer = hub.nodes.create('mixer');
  const other = hub.nodes.create('vst');
  hub.network.connect(ring.id, 'ctrl-out', mixer.id, 'ctrl-in');
  hub.network.connect(other.id, 'audio-out', mixer.id, 'audio-in-1');
  assert.deepEqual(hub.network.getNode(mixer.id).inputs.map((port) => port.id), ['audio-in-1', 'audio-in-2', 'ctrl-in']);
  assert.equal(hub.network.connectionsTo(mixer.id, 'ctrl-in').length, 1, 'the command cable follows its port');
});

test("a VST node's parameters are asked for only once something is cabled to it, and read-only or non-automatable ones are left out", async () => {
  const { api, hub, cable, send } = await rig();
  const synth = hub.nodes.create('vst');
  const entry = hub.nodes.getChain(synth.id).append({ pluginId: 'C:\\VST3\\Synth.vst3', name: 'Synth', role: 'instrument' });
  api.emitEvent({ type: 'chainChanged', chainId: synth.id, instances: [{
    instanceId: entry.id, pluginId: 'C:\\VST3\\Synth.vst3', name: 'Synth', bypassed: false, generation: 4, status: 'ready'
  }] });
  await settle();
  assert.equal(api.sent.some((msg) => msg.type === 'getVstParameters'), false, 'nothing is cabled: nothing is asked');

  await cable(synth.id);
  const request = api.sent.find((msg) => msg.type === 'getVstParameters');
  assert.ok(request, 'the cable is what asks');
  api.emitEvent({ type: 'vstParameters', requestId: request.requestId, chainId: synth.id, instanceId: entry.id, status: 'ok',
    pluginId: 'C:\\VST3\\Synth.vst3', parameters: [
      { parameterId: '7', name: 'Cutoff', stepCount: 0, readOnly: false },
      { parameterId: '8', name: 'Meter', stepCount: 0, readOnly: true },
      { parameterId: '9', name: 'Wave', stepCount: 3, readOnly: false },
      // What a JUCE plugin declares 2,080 of, for its host's MIDI mapping.
      { parameterId: '1835232512', name: 'MIDI CC 0|0', stepCount: 0, readOnly: false, automatable: false }
    ] });
  await settle();
  const target = `${synth.id}:${entry.id}`;
  assert.equal(send(target, 'PARAM:7', VALUE_TYPE.number, 0.42).ok, true);
  assert.equal(send(target, 'PARAM:8', VALUE_TYPE.number, 0.42).reason, 'unknown-command');
  assert.equal(send(target, 'PARAM:1835232512', VALUE_TYPE.number, 0.42).reason, 'unknown-command');
  assert.equal(send(target, 'PARAM:9', VALUE_TYPE.integer, 3).ok, true);
  const writes = api.sent.filter((msg) => msg.type === 'setVstParameter');
  assert.deepEqual(writes.map((msg) => [msg.parameterId, msg.normalizedValue]), [['7', 0.42], ['9', 1]]);
});
