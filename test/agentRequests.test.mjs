import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockSettings } from './helpers.mjs';
import { EventBus } from '../src/renderer/js/core/eventBus.js';
import { Network } from '../src/renderer/js/core/network.js';
import { ModuleSystem } from '../src/renderer/js/core/moduleSystem.js';
import { NodeInstanceManager } from '../src/renderer/js/core/nodeInstances.js';
import { handleAgentRequest } from '../src/renderer/js/core/agentRequests.js';
import { SequencerModel } from '../src/renderer/js/core/sequencerModel.js';

/**
 * Contract: what an outside agent may ask for, and how it is refused.
 *
 * The bound under test is INTENT §8 sexies -- an operation an agent can ask for
 * is one the interface can already perform. So most of what is checked here is
 * that a refusal ARRIVES: the network's guard rails are what keep an agent from
 * building an illegal patch, and a guard rail that throws through the channel
 * instead of answering it reads to the agent as a broken connection rather than
 * as "no, and here is why".
 */

const DEXED = { pluginId: 'C:/Dexed.vst3', name: 'Dexed', role: 'instrument' };

function fakeEngine(catalogue = [DEXED]) {
  const registry = new Map(catalogue.map((plugin) => [plugin.pluginId, plugin]));
  return {
    created: [], removed: [], parameters: [],
    getPlugin: (pluginId) => registry.get(pluginId) || null,
    createInstance(chainId, pluginId, instanceId, index) {
      this.created.push({ chainId, pluginId, instanceId, index });
    },
    removeInstance(chainId, instanceId) { this.removed.push({ chainId, instanceId }); },
    reordered: [], bypassed: [], editors: [], devices: [{ name: 'Speakers' }], deviceState: { running: true },
    reorderChain(chainId, instanceId, toIndex) { this.reordered.push({ chainId, instanceId, toIndex }); },
    setBypass(chainId, instanceId, value) { this.bypassed.push({ chainId, instanceId, value }); },
    openEditor(chainId, instanceId) { this.editors.push({ chainId, instanceId, open: true }); },
    closeEditor(chainId, instanceId) { this.editors.push({ chainId, instanceId, open: false }); },
    selectDevice(...args) { this.selected = args; },
    scanVst3() { this.scanned = true; },
    sequencerCancelExport() { this.cancelled = true; },
    setVstParameter(...args) { this.parameters.push(args); return { ok: true }; },
    status: 'ready',
    getInstanceStatus() { return this.status; }
  };
}

function rig() {
  const settings = mockSettings({
    nodeInstances: { instances: [], idSeq: {} },
    networkConnections: [], networkLayout: {}, sequencerState: null, transportBpm: 120
  });
  const events = new EventBus();
  const hub = { events, settings };
  hub.network = new Network(events, settings);
  hub.modules = new ModuleSystem(hub);
  hub.engine = fakeEngine();
  hub.control = { invalidated: [], targetInvalidated(...args) { this.invalidated.push(args); } };
  hub.nodes = new NodeInstanceManager(hub);
  hub.project = { projectId: 'project-1', _transitionPending: false };
  return hub;
}

const ask = (hub, request) => handleAgentRequest(hub, { expectedProjectId: 'project-1', ...request });

// ---- the staleness gate ---------------------------------------------------------

test('a mutating request carrying the wrong project id is refused', async () => {
  const hub = rig();
  const answer = await handleAgentRequest(hub, { kind: 'create-node', typeId: 'vst', expectedProjectId: 'gone' });
  assert.deepEqual(answer, { ok: false, reason: 'stale-project' });
  assert.equal(hub.nodes.list().length, 0, 'nothing was built against a project that left');
});

test('a request arriving mid-transition is refused rather than half-applied', async () => {
  const hub = rig();
  hub.project._transitionPending = true;
  assert.deepEqual(await ask(hub, { kind: 'create-node', typeId: 'vst' }),
    { ok: false, reason: 'project-transition' });
});

test('describe needs no project id, because it is how the id is learned', async () => {
  const hub = rig();
  const answer = await handleAgentRequest(hub, { kind: 'describe' });
  assert.equal(answer.ok, true);
  assert.equal(answer.projectId, 'project-1');
  assert.deepEqual(answer.setup.nodes, []);
});

// ---- the guard rails answer instead of throwing ---------------------------------

test('an incompatible cable is refused with the reason, not thrown', async () => {
  const hub = rig();
  const source = (await ask(hub, { kind: 'create-node', typeId: 'vst' })).node;
  const target = (await ask(hub, { kind: 'create-node', typeId: 'vst' })).node;

  const answer = await ask(hub, {
    kind: 'connect',
    from: { nodeId: source.id, portId: 'audio-out' },
    to: { nodeId: target.id, portId: 'midi-in' }
  });
  assert.equal(answer.ok, false);
  assert.equal(answer.reason, 'refused');
  assert.match(answer.message, /Incompatible port types/);
});

test('a cable that would feed back is refused with the reason', async () => {
  const hub = rig();
  const vst = (await ask(hub, { kind: 'create-node', typeId: 'vst' })).node;
  const mixer = (await ask(hub, { kind: 'create-node', typeId: 'mixer' })).node;
  await ask(hub, {
    kind: 'connect',
    from: { nodeId: vst.id, portId: 'audio-out' },
    to: { nodeId: mixer.id, portId: 'audio-in-1' }
  });

  const answer = await ask(hub, {
    kind: 'connect',
    from: { nodeId: mixer.id, portId: 'audio-out' },
    to: { nodeId: vst.id, portId: 'audio-in' }
  });
  assert.equal(answer.ok, false);
  assert.match(answer.message, /feedback cycle/);
});

test('an unknown node type is named as such rather than refused generically', async () => {
  const hub = rig();
  const answer = await ask(hub, { kind: 'create-node', typeId: 'theremin' });
  assert.equal(answer.reason, 'unknown-node-type');
});

test('an unknown kind is refused in the shape everything else answers in', async () => {
  assert.deepEqual(await ask(rig(), { kind: 'teleport' }), { ok: false, reason: 'unsupported-request' });
});

// ---- the chain -------------------------------------------------------------------

test('a plugin added through the channel reaches the model and the engine together', async () => {
  const hub = rig();
  const node = (await ask(hub, { kind: 'create-node', typeId: 'vst' })).node;

  const answer = await ask(hub, { kind: 'add-plugin', nodeId: node.id, pluginId: DEXED.pluginId });
  assert.equal(answer.ok, true);
  assert.equal(answer.plugin.name, 'Dexed');
  assert.deepEqual(hub.nodes.get(node.id).content.plugins.map((plugin) => plugin.pluginId), [DEXED.pluginId]);
  assert.equal(hub.engine.created.length, 1, 'the engine was told, not only the model');
  assert.equal(hub.engine.created[0].index, 0);
});

test('a wrong plugin name and a wrong target are told apart', async () => {
  const hub = rig();
  const vst = (await ask(hub, { kind: 'create-node', typeId: 'vst' })).node;
  const mixer = (await ask(hub, { kind: 'create-node', typeId: 'mixer' })).node;

  assert.equal((await ask(hub, { kind: 'add-plugin', nodeId: vst.id, pluginId: 'C:/Nope.vst3' })).reason,
    'unknown-plugin');
  assert.equal((await ask(hub, { kind: 'add-plugin', nodeId: mixer.id, pluginId: DEXED.pluginId })).reason,
    'not-a-vst-node');
});

test('removing a plugin through the channel invalidates the bindings that aimed at it', async () => {
  const hub = rig();
  const node = (await ask(hub, { kind: 'create-node', typeId: 'vst' })).node;
  const { plugin } = await ask(hub, { kind: 'add-plugin', nodeId: node.id, pluginId: DEXED.pluginId });

  assert.deepEqual(await ask(hub, { kind: 'remove-plugin', nodeId: node.id, pluginInstanceId: plugin.instanceId }),
    { ok: true });
  assert.deepEqual(hub.nodes.get(node.id).content.plugins, []);
  assert.deepEqual(hub.engine.removed, [{ chainId: node.id, instanceId: plugin.instanceId }]);
  // The line a second copy of this operation would have forgotten.
  assert.deepEqual(hub.control.invalidated, [[node.id, plugin.instanceId, 'target-removed']]);
});

test('removing a plugin that is not there says so instead of reporting success', async () => {
  const hub = rig();
  const node = (await ask(hub, { kind: 'create-node', typeId: 'vst' })).node;
  assert.deepEqual(await ask(hub, { kind: 'remove-plugin', nodeId: node.id, pluginInstanceId: 'plugin-9' }),
    { ok: false, reason: 'plugin-not-found' });
});

// ---- the sequencer is handed through, not restated ------------------------------

test('a sequencer request reaches the Clip Editor own handler unchanged', async () => {
  const hub = rig();
  const seen = [];
  hub.sequencer = {
    handleClipEditorRequest(request) { seen.push(request); return { ok: true, sounded: true }; }
  };
  const payload = { kind: 'audition', clipId: 'clip-1', expectedProjectId: 'project-1', payload: { pitch: 60 } };

  assert.deepEqual(await ask(hub, { kind: 'sequencer', request: payload }), { ok: true, sounded: true });
  assert.deepEqual(seen, [payload], 'the payload is passed through whole');
});

test('a sequencer request with no sequencer is refused rather than crashing', async () => {
  assert.deepEqual(await ask(rig(), { kind: 'sequencer', request: { kind: 'get' } }),
    { ok: false, reason: 'unsupported-request' });
});

// ---- tracks and clips -------------------------------------------------------------

/**
 * A stand-in for `SequencerController` over a real `SequencerModel`.
 *
 * Real model, counted publications: what the router must get right is that it
 * calls the CONTROLLER and not the model, because the controller is what calls
 * `changed()` -- and a track the native plan never heard of is a track that
 * exists on screen and is silent.
 */
function fakeSequencer() {
  const model = new SequencerModel({ tracks: [] });
  return {
    model, published: 0,
    addTrack(type) { const track = model.addTrack(type); if (track) this.published += 1; return track; },
    addMidiClip(trackId, startPpq, lengthPpq, notes) {
      const clip = model.addMidiClip(trackId, startPpq, lengthPpq, notes);
      if (clip) this.published += 1;
      return clip;
    },
    setTrack(trackId, changes) { return model.updateTrack(trackId, changes); },
    removeTrack(trackId) { return model.removeTrack(trackId); }
  };
}

test('a track is added through the controller, so the native plan is told', async () => {
  const hub = rig();
  hub.sequencer = fakeSequencer();

  const answer = await ask(hub, { kind: 'add-track', type: 'midi' });
  assert.equal(answer.ok, true);
  assert.equal(answer.track.type, 'midi');
  assert.equal(hub.sequencer.published, 1, 'the controller published the change');
});

test('a clip carries its notes in, in one request', async () => {
  const hub = rig();
  hub.sequencer = fakeSequencer();
  const { track } = await ask(hub, { kind: 'add-track', type: 'midi' });

  const notes = Array.from({ length: 16 }, (_, step) => ({
    startPpq: step * 0.25, durationPpq: 0.125, pitch: 36 + (step % 3), velocity: 100
  }));
  const answer = await ask(hub, {
    kind: 'add-clip', trackId: track.id, startPpq: 0, lengthPpq: 4, notes
  });

  assert.equal(answer.ok, true);
  assert.equal(answer.clip.noteCount, 16, 'sixteen notes placed by one request, not sixteen');
});

test("a track's output is set like any other field", async () => {
  const hub = rig();
  hub.sequencer = fakeSequencer();
  const { track } = await ask(hub, { kind: 'add-track', type: 'midi' });

  const answer = await ask(hub, { kind: 'set-track', trackId: track.id, changes: { outputId: 'vst-001' } });
  assert.equal(answer.ok, true);
  assert.equal(answer.track.outputId, 'vst-001');
  assert.equal(hub.sequencer.model.state.tracks[0].outputId, 'vst-001');
});

test('a route the controller could not make is named, not reported as success', async () => {
  const hub = rig();
  hub.sequencer = fakeSequencer();
  const { track } = await ask(hub, { kind: 'add-track', type: 'midi' });
  // What the real controller does when `ensureRoute` fails: put the field back
  // and return the track anyway. Reading `ok` off that is how an agent ends up
  // building on a track that plays into nothing.
  hub.sequencer.setTrack = (trackId, changes) => {
    if ('outputId' in changes) return hub.sequencer.model.updateTrack(trackId, { outputId: '' });
    return hub.sequencer.model.updateTrack(trackId, changes);
  };

  const answer = await ask(hub, { kind: 'set-track', trackId: track.id, changes: { outputId: 'vst-001' } });
  assert.equal(answer.ok, false);
  assert.equal(answer.reason, 'route-refused');
  assert.equal(answer.track.outputId, '', 'the answer says what the track actually is');
});

test('a track that is not there is named as missing rather than refused generically', async () => {
  const hub = rig();
  hub.sequencer = fakeSequencer();
  assert.equal((await ask(hub, { kind: 'remove-track', trackId: 'track-9' })).reason, 'track-not-found');
  assert.equal((await ask(hub, { kind: 'set-track', trackId: 'track-9', changes: {} })).reason, 'track-not-found');
});

test('a clip on a stale project is refused before anything is built', async () => {
  const hub = rig();
  hub.sequencer = fakeSequencer();
  const answer = await handleAgentRequest(hub, { kind: 'add-track', type: 'midi', expectedProjectId: 'gone' });
  assert.equal(answer.reason, 'stale-project');
  assert.equal(hub.sequencer.published, 0);
});

// ---- inside a node ----------------------------------------------------------------

test('content arriving from outside is normalised before it reaches the model', async () => {
  const hub = rig();
  const mixer = (await ask(hub, { kind: 'create-node', typeId: 'mixer' })).node;

  const answer = await ask(hub, {
    kind: 'set-node-content', nodeId: mixer.id,
    content: { inputs: [{ id: 'audio-in-1', level: 'loud', muted: 'yes' }], masterLevel: 999 }
  });

  assert.equal(answer.ok, true);
  const content = hub.nodes.get(mixer.id).content;
  // A level of "loud" reaching the engine is a NaN gain, which is silence with
  // no error anywhere. The normaliser is what stands between the two.
  assert.equal(content.inputs[0].level, 1);
  // Not `true`: only a real boolean mutes. A truthy string is a caller that did
  // not mean to mute, and guessing that it did would silence a track for a
  // reason nobody could find.
  assert.equal(content.inputs[0].muted, false);
  assert.equal(content.masterLevel, 2, 'clamped to the model ceiling, not written raw');
});

test("a node's plugin list cannot be rewritten as content", async () => {
  const hub = rig();
  const node = (await ask(hub, { kind: 'create-node', typeId: 'vst' })).node;
  await ask(hub, { kind: 'add-plugin', nodeId: node.id, pluginId: DEXED.pluginId });

  await ask(hub, { kind: 'set-node-content', nodeId: node.id, content: { plugins: [], controlBindings: [] } });

  assert.equal(hub.nodes.get(node.id).content.plugins.length, 1,
    'a plugin is a running native instance, not a list entry');
});

// ---- the chain ---------------------------------------------------------------------

test('moving a plugin tells the engine the new index', async () => {
  const hub = rig();
  const node = (await ask(hub, { kind: 'create-node', typeId: 'vst' })).node;
  const first = (await ask(hub, { kind: 'add-plugin', nodeId: node.id, pluginId: DEXED.pluginId })).plugin;
  await ask(hub, { kind: 'add-plugin', nodeId: node.id, pluginId: DEXED.pluginId });

  assert.deepEqual(await ask(hub, { kind: 'move-plugin', nodeId: node.id, pluginInstanceId: first.instanceId, toIndex: 1 }),
    { ok: true });
  assert.deepEqual(hub.engine.reordered, [{ chainId: node.id, instanceId: first.instanceId, toIndex: 1 }]);
  assert.equal(hub.nodes.get(node.id).content.plugins[1].id, first.instanceId);
});

test('bypass reaches the model and the engine together', async () => {
  const hub = rig();
  const node = (await ask(hub, { kind: 'create-node', typeId: 'vst' })).node;
  const { plugin } = await ask(hub, { kind: 'add-plugin', nodeId: node.id, pluginId: DEXED.pluginId });

  await ask(hub, { kind: 'set-plugin-bypass', nodeId: node.id, pluginInstanceId: plugin.instanceId, bypassed: true });
  assert.equal(hub.nodes.get(node.id).content.plugins[0].bypassed, true);
  assert.deepEqual(hub.engine.bypassed, [{ chainId: node.id, instanceId: plugin.instanceId, value: true }]);
});

test('an editor is not opened for a plugin the engine is not ready to show', async () => {
  const hub = rig();
  const node = (await ask(hub, { kind: 'create-node', typeId: 'vst' })).node;
  const { plugin } = await ask(hub, { kind: 'add-plugin', nodeId: node.id, pluginId: DEXED.pluginId });
  hub.engine.status = 'loading';

  assert.equal((await ask(hub, { kind: 'open-editor', nodeId: node.id, pluginInstanceId: plugin.instanceId })).reason,
    'plugin-not-ready');
  assert.deepEqual(hub.engine.editors, [], 'nothing was fired at the engine to come back as "Unknown instance"');

  hub.engine.status = 'ready';
  assert.equal((await ask(hub, { kind: 'open-editor', nodeId: node.id, pluginInstanceId: plugin.instanceId })).ok, true);
  assert.equal(hub.engine.editors.length, 1);
});

// ---- the instrument, which is not gated on the project id --------------------------

test('the transport and the tempo answer even against a stale project id', async () => {
  const hub = rig();
  const calls = [];
  hub.sequencer = {
    playheadPpq: 0, tempo: 120,
    playTransport() { calls.push('play'); }, stopTransport() { calls.push('stop'); },
    goToStart() { calls.push('start'); }, seek(ppq) { calls.push(`seek:${ppq}`); },
    setTempo(bpm) { this.tempo = bpm; calls.push(`tempo:${bpm}`); }
  };

  // Deliberately no expectedProjectId: stopping a sound is not an edit, and
  // refusing it because the project moved would be refusing to stop the sound.
  assert.equal((await handleAgentRequest(hub, { kind: 'transport', operation: 'stop' })).ok, true);
  assert.equal((await handleAgentRequest(hub, { kind: 'set-tempo', bpm: 96 })).bpm, 96);
  assert.deepEqual(calls, ['stop', 'tempo:96']);
});

test('an unknown transport operation is refused rather than ignored', async () => {
  const hub = rig();
  hub.sequencer = { playTransport() {}, stopTransport() {} };
  assert.equal((await handleAgentRequest(hub, { kind: 'transport', operation: 'rewind' })).reason,
    'unsupported-request');
});

// ---- the project, and the modals it must never open --------------------------------

function fakeProject({ dirty = false, path = null } = {}) {
  return {
    projectId: 'project-1', _transitionPending: false, dirty,
    currentProjectPath: path, currentProjectName: 'Untitled',
    saved: [], replaced: [],
    async _save() { this.saved.push(this.currentProjectPath); return { ok: true }; },
    async saveTo(filePath) { this.saved.push(filePath); this.currentProjectPath = filePath; return { ok: true }; },
    async load(filePath) { this.replaced.push({ load: filePath }); return true; },
    async newProject() { this.replaced.push({ new: true }); return true; }
  };
}

test('saving a project that has never been saved asks for a path instead of a picker', async () => {
  const hub = rig();
  hub.project = fakeProject();
  const answer = await handleAgentRequest(hub, { kind: 'project', operation: 'save' });
  assert.equal(answer.reason, 'no-path');
  assert.deepEqual(hub.project.saved, [], 'no dialog, and nothing written');
});

test('saving to a named path writes there with no dialog', async () => {
  const hub = rig();
  hub.project = fakeProject();
  const answer = await handleAgentRequest(hub, {
    kind: 'project', operation: 'save', filePath: 'C:/Projects/Tribal.minihub'
  });
  assert.equal(answer.ok, true);
  assert.deepEqual(hub.project.saved, ['C:/Projects/Tribal.minihub']);
});

test('unsaved work is refused rather than confirmed through a modal', async () => {
  const hub = rig();
  hub.project = fakeProject({ dirty: true });
  const answer = await handleAgentRequest(hub, { kind: 'project', operation: 'new' });
  assert.equal(answer.reason, 'unsaved-changes');
  assert.deepEqual(hub.project.replaced, [], 'nothing was discarded on its own');
});

test('discarding on purpose is allowed, and the answer comes before the reload', async () => {
  const hub = rig();
  hub.project = fakeProject({ dirty: true });

  const answer = await handleAgentRequest(hub, { kind: 'project', operation: 'new', discardUnsaved: true });
  assert.deepEqual(answer, { ok: true, reloading: true });
  // The renderer that would send this answer is the one about to be torn down,
  // so the answer has to be out before the replacement starts.
  assert.deepEqual(hub.project.replaced, [], 'not yet: the answer goes first');

  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(hub.project.replaced, [{ new: true }], 'and the reload follows');
});

test('loading without a path is refused rather than opening the file picker', async () => {
  const hub = rig();
  hub.project = fakeProject();
  assert.equal((await handleAgentRequest(hub, { kind: 'project', operation: 'load' })).reason, 'no-path');
});

test('a project change is refused while a take is running', async () => {
  const hub = rig();
  hub.project = fakeProject();
  hub.sequencer = { recording: true };
  assert.equal((await handleAgentRequest(hub, { kind: 'project', operation: 'new' })).reason, 'recording-active');
});

// ---- export, devices, catalogue ----------------------------------------------------

test('an export without a destination is refused rather than opening a dialog', async () => {
  const hub = rig();
  const calls = [];
  hub.sequencer = { exportMaster(range, options) { calls.push({ range, options }); return true; } };

  assert.equal((await handleAgentRequest(hub, { kind: 'export' })).reason, 'no-path');
  assert.deepEqual(calls, []);

  const answer = await handleAgentRequest(hub, { kind: 'export', filePath: 'C:/Mixes/take.wav', format: 'wav' });
  assert.equal(answer.started, true);
  assert.equal(calls[0].options.filePath, 'C:/Mixes/take.wav');
});

test('the devices are listed from what the engine last reported', async () => {
  const hub = rig();
  const answer = await handleAgentRequest(hub, { kind: 'devices', operation: 'list' });
  assert.deepEqual(answer.devices, [{ name: 'Speakers' }]);
  assert.deepEqual(answer.state, { running: true });
});

test('a rescan is started, and says so rather than pretending to have finished', async () => {
  const hub = rig();
  assert.deepEqual(await handleAgentRequest(hub, { kind: 'scan-plugins' }), { ok: true, started: true });
  assert.equal(hub.engine.scanned, true);
});

// ---- the windows an agent works in ------------------------------------------------

test('show-window brings the page on screen first, then the window, and says where it landed', async () => {
  const hub = rig();
  const order = [];
  const content = { innerHTML: '' };
  hub.modules.register({ id: 'home', navEntry: { label: 'Home' }, mount() { order.push('mount:home'); } });
  hub.modules.register({ id: 'routing', navEntry: { label: 'Routing' }, mount() { order.push('mount:routing'); } });
  hub.modules.activate('home', content);
  hub.api = {
    focusMainWindow: async () => { order.push('focus-that-steals-the-keyboard'); return true; },
    showMainWindow: async () => { order.push('show'); return true; }
  };

  const answer = await handleAgentRequest(hub, { kind: 'show-window', page: 'routing' });
  assert.deepEqual(answer, { ok: true, page: 'routing', shown: true });
  assert.deepEqual(order, ['mount:home', 'mount:routing', 'show'],
    'the window is put in front without taking the keyboard from what the person is typing in');

  const unknown = await handleAgentRequest(hub, { kind: 'show-window', page: 'mixer-page' });
  assert.equal(unknown.reason, 'unknown-page');
  assert.match(unknown.message, /routing/, 'the refusal lists the pages that do exist');

  assert.deepEqual(await handleAgentRequest(hub, { kind: 'show-window' }), { ok: true, page: 'routing', shown: true },
    'with no page the window alone is shown, on whatever page it holds');
});

test('open-clip-editor opens the window a double-click would, and refuses a clip that is not there', async () => {
  const hub = rig();
  const opened = [];
  hub.sequencer = { openClipEditor: (clipId) => { opened.push(clipId); return clipId === 'clip-1'; } };
  assert.deepEqual(await handleAgentRequest(hub, { kind: 'open-clip-editor', clipId: 'clip-1' }), { ok: true, clipId: 'clip-1' });
  assert.equal((await handleAgentRequest(hub, { kind: 'open-clip-editor', clipId: 'nope' })).reason, 'clip-not-found');
  assert.deepEqual(opened, ['clip-1', 'nope']);
});

test('describe says which windows are open and whether MiniHub runs inside another app', async () => {
  const hub = rig();
  hub.modules.register({ id: 'routing', navEntry: { label: 'Routing' }, mount() {} });
  hub.api = {
    windowState: async () => ({
      main: { visible: false, minimized: false, focused: false },
      clipEditors: ['clip-9'],
      launchedInsidePackage: 'OpenAI.Codex_2p2nqsd0c76g0'
    })
  };
  const { setup } = await handleAgentRequest(hub, { kind: 'describe' });
  assert.deepEqual(setup.windows.main, { visible: false, minimized: false, focused: false },
    'a window launched hidden is reported hidden, which nothing else would reveal');
  assert.deepEqual(setup.windows.clipEditors, ['clip-9']);
  assert.equal(setup.windows.launchedInsidePackage, 'OpenAI.Codex_2p2nqsd0c76g0');
  assert.deepEqual(setup.windows.pages, [{ id: 'routing', label: 'Routing' }]);
});

// ---- a plugin's web page ----------------------------------------------------------

test('a browser request names a plugin this project holds, and carries only its own fields to main', async () => {
  const hub = rig();
  const node = (await ask(hub, { kind: 'create-node', typeId: 'vst' })).node;
  const { plugin } = await ask(hub, { kind: 'add-plugin', nodeId: node.id, pluginId: DEXED.pluginId });
  const sent = [];
  hub.api = { pluginBrowser: async (payload) => { sent.push(payload); return { ok: true, operation: payload.operation }; } };

  assert.equal((await handleAgentRequest(hub, { kind: 'browser', operation: 'read', nodeId: node.id, pluginInstanceId: 'plugin-99' })).reason,
    'plugin-not-found');
  assert.deepEqual(sent, [], 'a plugin the project does not hold is never looked for');

  const answer = await handleAgentRequest(hub, {
    kind: 'browser', operation: 'click', nodeId: node.id, pluginInstanceId: plugin.instanceId,
    ref: 12, expectedProjectId: 'stale-on-purpose', script: 'alert(1)'
  });
  assert.deepEqual(answer, { ok: true, operation: 'click' },
    'acting in a plugin window is not gated on the project: it is not an edit of it');
  assert.deepEqual(sent, [{ nodeId: node.id, pluginInstanceId: plugin.instanceId, operation: 'click', ref: 12 }]);
});
