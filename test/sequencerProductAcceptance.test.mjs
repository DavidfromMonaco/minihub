import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createHub } from '../src/renderer/js/core/hub.js';
import { getNodeType } from '../src/renderer/js/core/nodeTypes.js';
import { describeAudioGraph, describeMidiGraph } from '../src/renderer/js/core/engineSync.js';
import { setupMidiRouting } from '../src/renderer/js/core/midiRouting.js';
import { createConnection } from '../src/renderer/js/modules/routing/routingCore.js';
import { createMiniLabModule } from '../src/renderer/js/modules/minilab/minilabModule.js';
import { createAudioOutputModule } from '../src/renderer/js/modules/audioOutput/audioOutputModule.js';
import projectFiles from '../src/main/projectFiles.js';
import { makeEl, installDom, fire } from './domShim.mjs';

installDom();
const { createRoutingModule } = await import('../src/renderer/js/modules/routing/routingModule.js');
const { readProject, writeProjectAtomic } = projectFiles;

test('Sequencer dynamic layout remains compatible with the strict renderer CSP', () => {
  const moduleSource = fs.readFileSync(new URL('../src/renderer/js/modules/sequencer/sequencerModule.js', import.meta.url), 'utf8');
  assert.doesNotMatch(moduleSource, /style="/,
    'inline style attributes are rejected by style-src self and make timeline rows overlap');
  assert.match(moduleSource, /applyDynamicStyles\(container\)/,
    'timeline geometry must be applied through the CSSOM after rendering');
});

test('Sequencer toolbar exposes shared Play, actionable Record, distinct Stop, and no Piano Roll UI', () => {
  const controllerSource = fs.readFileSync(new URL('../src/renderer/js/core/sequencerController.js', import.meta.url), 'utf8');
  const moduleSource = fs.readFileSync(new URL('../src/renderer/js/modules/sequencer/sequencerModule.js', import.meta.url), 'utf8');
  assert.match(controllerSource, /recordBlockReason\(\)/);
  assert.match(controllerSource, /No MIDI input is detected or selected/);
  assert.match(moduleSource, /data-action="start-record"/);
  assert.match(moduleSource, /startRecording\(\{ notify: true \}\)/);
  assert.match(moduleSource, /data-action="play"/);
  assert.match(moduleSource, /playTransport\(\)/);
  assert.match(moduleSource, /data-action="stop"/);
  assert.match(moduleSource, /stopTransport\(\)/);
  assert.match(moduleSource, /seq-record-status/);
  assert.match(moduleSource, /Each track has its own <strong>Input<\/strong> and <strong>Destination<\/strong>/);
  const idleRecord = /<button class="btn seq-record[\s\S]*?data-action="start-record"([\s\S]*?)>Record<\/button>/.exec(moduleSource)?.[1] || '';
  assert.doesNotMatch(idleRecord, /recordBlockReason[^\n]*disabled/,
    'missing setup is reported by an actionable Record control instead of a silent grey button');
  assert.doesNotMatch(moduleSource, /Piano Roll|piano-(?:scroll|keyboard|grid|note)|pianoZoom|data-note-control/);
  const cssSource = fs.readFileSync(new URL('../src/renderer/styles/base.css', import.meta.url), 'utf8');
  assert.doesNotMatch(cssSource, /\.piano-(?:scroll|keyboard|grid|note)/);
});

function mockApi(initialSettings = {}) {
  const data = structuredClone(initialSettings);
  const sent = [];
  const engineEvents = [];
  const engineStates = [];
  return {
    data,
    sent,
    loadSettings: async () => structuredClone(data),
    saveSettings: async (next) => { Object.assign(data, structuredClone(next)); return true; },
    diagnosticsLog: () => true,
    engineCommand: async (message) => { sent.push(message); return { ok: true }; },
    engineState: async () => ({ state: 'running', error: null }),
    onEngineEvent(callback) { engineEvents.push(callback); return () => {}; },
    onEngineState(callback) { engineStates.push(callback); return () => {}; },
    capturePluginStates: async () => true,
    audioPickOpen: async () => null,
    audioPickSave: async () => null,
    audioCommitTake: async (filePath) => ({ ok: true, filePath }),
    projectPickOpen: async () => null,
    projectPickSave: async () => null,
    projectRead: async () => ({ ok: false }),
    projectWrite: async () => ({ ok: true })
  };
}

const sentOf = (api, type) => api.sent.filter((message) => message.type === type);
const flush = () => new Promise((resolve) => setImmediate(resolve));

async function makeRuntime(initialSettings = {}, loadSequencer = true) {
  const api = mockApi(initialSettings);
  const hub = createHub(api);
  await hub.settings.load();
  if (loadSequencer) hub.sequencer.load();
  await flush();
  return { api, hub };
}

function registerSystemNodes(hub) {
  hub.modules.register(createMiniLabModule(hub));
  hub.modules.register(createAudioOutputModule(hub));
}

function exactSequencerPorts(node) {
  assert.deepEqual(node.inputs, [
    { id: 'midi-in', type: 'midi', label: 'MIDI IN' },
    { id: 'audio-in', type: 'audio', label: 'AUDIO IN' }
  ], 'Sequencer inputs are exactly MIDI IN then AUDIO IN');
  assert.deepEqual(node.outputs, [
    { id: 'midi-out', type: 'midi', label: 'MIDI OUT' },
    { id: 'audio-out', type: 'audio', label: 'AUDIO OUT' }
  ], 'Sequencer outputs are exactly MIDI OUT then AUDIO OUT');
}

function routingContainer() {
  const container = makeEl('div');
  const svg = makeEl('svg');
  svg.setAttribute('id', 'routing-svg');
  const newButton = makeEl('button');
  newButton.setAttribute('id', 'routing-new-node');
  const newType = makeEl('select');
  newType.setAttribute('id', 'routing-new-type');
  Object.defineProperty(container, 'innerHTML', {
    get: () => '',
    set: () => {
      container.children.length = 0;
      container.appendChild(svg);
      container.appendChild(newButton);
      container.appendChild(newType);
    },
    configurable: true
  });
  return { container, svg, newButton, newType };
}

test('Sequencer node type declares the exact four-port Patch Bay contract', () => {
  const type = getNodeType('sequencer');
  assert.ok(type, 'Sequencer is a registered user-creatable node type');
  assert.equal(type.singleton, true);
  assert.equal(type.deletable, true, 'the routing node can be removed explicitly');
  assert.equal(type.copyable, false, 'the project singleton cannot be duplicated');
  exactSequencerPorts(type.ports);
});

test('MiniLab hardware MIDI input is a real graph sink, not a hidden route', () => {
  const delivered = [];
  const module = createMiniLabModule({
    midi: { send: (raw) => { delivered.push([...raw]); return true; } }
  });
  const sink = module.routingNode.inputs.find((port) => port.id === 'midi-in');
  assert.deepEqual(sink, { id: 'midi-in', type: 'midi', label: 'Hardware MIDI In' });
  module.routingNode.onInput('midi-in', { raw: [0x90, 60, 100] });
  module.routingNode.onInput('other', { raw: [0x80, 60, 0] });
  assert.deepEqual(delivered, [[0x90, 60, 100]], 'only a graph delivery to MIDI IN reaches hardware');
});

test('Patch Bay + New Node explicitly creates and persists a routable Sequencer', async () => {
  const { hub } = await makeRuntime({ graphViewport: { x: 0, y: 0, zoom: 1 } });
  registerSystemNodes(hub);
  const { container, newButton, newType } = routingContainer();
  const routing = createRoutingModule(hub);
  routing.mount(container);
  try {
    assert.equal(hub.nodes.list().some((node) => node.type === 'sequencer'), false,
      'opening Patch Bay does not create a Sequencer');
    newType.value = 'sequencer';
    fire(newButton, 'click');

    const created = hub.nodes.list().filter((node) => node.type === 'sequencer');
    assert.equal(created.length, 1, 'one explicit click creates the requested Sequencer');
    const graphNode = hub.graph.getNode(created[0].id);
    assert.ok(graphNode, 'the created instance is a real routing node');
    exactSequencerPorts(graphNode);
    assert.ok(hub.settings.get('nodeInstances').instances.some((node) => node.id === created[0].id),
      'the existing node-instance persistence owns the Sequencer');
    assert.ok(hub.settings.get('graphLayout')[created[0].id],
      'the existing Patch Bay creation path persists its position');
  } finally {
    routing.unmount();
  }
});

test('fresh project has only MiniLab and Audio Output; Audio Input is explicit, routable, and persistent', async () => {
  const { hub } = await makeRuntime({ graphViewport: { x: 0, y: 0, zoom: 1 } });
  registerSystemNodes(hub);
  assert.deepEqual(hub.graph.listNodes().map((node) => node.id).sort(), ['audio-output', 'minilab-3']);
  assert.equal(hub.nodes.list().some((node) => node.type === 'audio-input'), false);

  const { container, newButton, newType } = routingContainer();
  const routing = createRoutingModule(hub);
  routing.mount(container);
  try {
    newType.value = 'audio-input';
    fire(newButton, 'click');
  } finally {
    routing.unmount();
  }
  const input = hub.nodes.list().find((node) => node.type === 'audio-input');
  assert.equal(input?.id, 'audio-input');
  assert.deepEqual(hub.graph.getNode(input.id).outputs, [
    { id: 'audio-out', type: 'audio', label: 'AUDIO OUT' }
  ]);
  const sequencer = hub.nodes.create('sequencer');
  assert.equal(hub.graph.connect(input.id, 'audio-out', sequencer.id, 'audio-in'), true);

  const saved = hub.project.snapshot();
  const { hub: restored } = await makeRuntime({}, false);
  restored.project.applySnapshot(saved, 'Audio Input.minihub');
  registerSystemNodes(restored);
  restored.sequencer.load();
  await restored.nodes.load();
  restored.graph.restore(restored.settings.get('graphConnections'));
  assert.equal(restored.nodes.list().filter((node) => node.type === 'audio-input').length, 1);
  assert.ok(restored.graph.connectionsFrom('audio-input', 'audio-out')
    .some((connection) => connection.to.nodeId === 'sequencer' && connection.to.portId === 'audio-in'));
});

test('deleting and re-adding the singleton removes only routing and preserves one arrangement', async () => {
  const { hub } = await makeRuntime();
  registerSystemNodes(hub);
  const fixedPage = { id: 'sequencer', name: 'Sequencer', navEntry: { label: 'Sequencer' } };
  hub.modules.register(fixedPage);
  const sequencer = hub.nodes.create('sequencer');
  const vst = hub.nodes.create('vst');
  hub.graph.connect('minilab-3', 'midi-out', sequencer.id, 'midi-in');
  hub.graph.connect(sequencer.id, 'midi-out', vst.id, 'midi-in');

  const track = hub.sequencer.model.addTrack('midi');
  hub.sequencer.model.addMidiClip(track.id, 2, 4, [{
    pitch: 72, startPpq: 0.25, durationPpq: 1.5, velocity: 117, channel: 3
  }]);
  hub.sequencer.changed();
  const arrangement = structuredClone(hub.sequencer.model.snapshot());

  assert.equal(hub.nodes.delete(sequencer.id), true);
  assert.equal(hub.nodes.list().some((node) => node.type === 'sequencer'), false);
  assert.equal(hub.graph.getNode(sequencer.id), undefined);
  assert.equal(hub.graph.connections().some((connection) =>
    connection.from.nodeId === sequencer.id || connection.to.nodeId === sequencer.id), false,
  'deletion removes all active Sequencer routing');
  assert.equal(hub.modules.get('sequencer'), fixedPage,
    'deleting the Patch Bay node does not delete the fixed Sequencer page');
  assert.deepEqual(hub.sequencer.model.snapshot(), arrangement,
    'tracks, clips and notes remain project-owned after node deletion');
  assert.deepEqual(hub.project.snapshot().sequencer, arrangement,
    'a project save still contains the arrangement while the routing node is absent');

  const readded = hub.nodes.create('sequencer');
  assert.equal(readded.id, 'sequencer', 're-add restores the same stable singleton identity');
  assert.equal(hub.nodes.create('sequencer'), null, 'a second Sequencer is rejected');
  assert.equal(hub.nodes.duplicate(readded.id), null, 'the Sequencer cannot be duplicated');
  assert.equal(hub.nodes.list().filter((node) => node.type === 'sequencer').length, 1);
  assert.equal(hub.graph.connectionsTo(readded.id).length + hub.graph.connectionsFrom(readded.id).length, 0,
    'deleted cables are not restored implicitly');
  assert.deepEqual(hub.sequencer.model.snapshot(), arrangement,
    're-add binds the node to the existing arrangement instead of creating another');
});

test('MiniLab -> Sequencer cable alone gates one MIDI capture and one playthrough', async () => {
  const { api, hub } = await makeRuntime();
  registerSystemNodes(hub);
  const sequencer = hub.nodes.create('sequencer');
  const vst = hub.nodes.create('vst');
  assert.deepEqual(createConnection(hub.graph,
    { nodeId: sequencer.id, portId: 'midi-out' },
    { nodeId: vst.id, portId: 'midi-in' }), { ok: true });
  assert.deepEqual(createConnection(hub.graph,
    { nodeId: 'minilab-3', portId: 'midi-out' },
    { nodeId: sequencer.id, portId: 'midi-in' }), { ok: true },
  'MiniLab MIDI OUT can connect to Sequencer MIDI IN');

  const track = hub.sequencer.model.addTrack('midi');
  hub.midi.inputs.set('web-midi-port-7', { id: 'web-midi-port-7', name: 'MiniLab 3 MIDI', type: 'input' });
  hub.midi.selectedInputId = 'web-midi-port-7';
  hub.engine.state = 'running';
  hub.sequencer.model.updateTrack(track.id, { armed: true, inputId: 'web-midi-port-7', outputId: vst.id });
  hub.sequencer.changed();
  assert.equal(hub.sequencer.startRecording(), true);
  const disposeMidiRouting = setupMidiRouting(hub);
  const sendPhysicalInput = (raw) => {
    const message = {
      type: raw[0] < 0xa0 ? 'noteon' : 'noteoff', channel: 1, note: raw[1], velocity: raw[2],
      sourceId: 'web-midi-port-7', offsetMs: -4, raw
    };
    // MidiManager emits both events for the selected physical input. The first
    // is diagnostic only; the second is the authoritative graph feed.
    hub.events.emit('midi:inputMessage', message);
    hub.events.emit('midi:message', message);
  };

  try {
    hub.graph.disconnect('minilab-3', 'midi-out', sequencer.id, 'midi-in');
    sendPhysicalInput([0x90, 60, 100]);
    assert.equal(sentOf(api, 'sequencerMidiInput').length, 0,
      'without the input cable there is no recording capture');
    assert.equal(sentOf(api, 'midi').length, 0,
      'without the input cable there is no VST playthrough');

    hub.graph.connect('minilab-3', 'midi-out', sequencer.id, 'midi-in');
    sendPhysicalInput([0x90, 61, 101]);
    assert.equal(sentOf(api, 'sequencerMidiInput').length, 1,
      'one physical message is captured exactly once');
    assert.equal(sentOf(api, 'midi').length, 1,
      'one physical message plays through to the connected VST exactly once');
    assert.equal(sentOf(api, 'midi')[0].chainId, vst.id);

    hub.events.emit('engine:sequencerMidiRecorded', {
      trackId: track.id, startPpq: 0, endPpq: 1,
      events: [{ pitch: 61, startPpq: 0, durationPpq: 0.5, velocity: 101, channel: 1 }]
    });
    assert.equal(track.clips.length, 1, 'the one routed native capture becomes one editable clip');
    assert.equal(track.clips[0].notes.length, 1);

    hub.graph.disconnect('minilab-3', 'midi-out', sequencer.id, 'midi-in');
    assert.equal(sentOf(api, 'sequencerPanic').length, 1,
      'removing a cable with a held note triggers one native panic');
    const cleanup = sentOf(api, 'midi').slice(1);
    assert.equal(cleanup.some((message) => (message.data[0] & 0xf0) === 0x80 && message.data[1] === 61), true,
      'the held note receives an exact Note Off before its route disappears');
    assert.equal(cleanup.some((message) => (message.data[0] & 0xf0) === 0xb0 && message.data[1] === 123), true,
      'route cleanup also includes All Notes Off');
    const midiCountAfterCleanup = sentOf(api, 'midi').length;
    sendPhysicalInput([0x80, 61, 0]);
    assert.equal(sentOf(api, 'sequencerMidiInput').length, 1,
      'removing the input cable immediately cuts capture');
    assert.equal(sentOf(api, 'midi').length, midiCountAfterCleanup,
      'after deterministic cleanup, the disconnected input cannot play through');
    assert.equal(sentOf(api, 'sequencerPanic').length, 1,
      'cable removal does not inject a synthetic MIDI note');
  } finally {
    disposeMidiRouting();
    hub.sequencer.stopRecording();
  }
});

test('Sequencer MIDI OUT remains routable directly to VST and through Arpeggiator', async () => {
  const { hub } = await makeRuntime();
  const sequencer = hub.nodes.create('sequencer');
  const directVst = hub.nodes.create('vst');
  const arp = hub.nodes.create('arpeggiator');
  const arpeggiatedVst = hub.nodes.create('vst');

  assert.deepEqual(createConnection(hub.graph,
    { nodeId: sequencer.id, portId: 'midi-out' },
    { nodeId: directVst.id, portId: 'midi-in' }), { ok: true });
  assert.deepEqual(createConnection(hub.graph,
    { nodeId: sequencer.id, portId: 'midi-out' },
    { nodeId: arp.id, portId: 'midi-in' }), { ok: true });
  assert.deepEqual(createConnection(hub.graph,
    { nodeId: arp.id, portId: 'midi-out' },
    { nodeId: arpeggiatedVst.id, portId: 'midi-in' }), { ok: true });

  assert.ok(hub.graph.connectionsFrom(sequencer.id, 'midi-out')
    .some((c) => c.to.nodeId === directVst.id && c.to.portId === 'midi-in'));
  const nativeArp = describeMidiGraph(hub).find((node) => node.id === arp.id);
  assert.deepEqual(nativeArp.inputs, [
    { sourceNodeId: sequencer.id, sourcePortId: 'midi-out' }
  ]);
  assert.deepEqual(nativeArp.destinations, [arpeggiatedVst.id]);
});

test('audio capture input and Sequencer playback output are both cable-authoritative', async () => {
  const { api, hub } = await makeRuntime();
  registerSystemNodes(hub);
  const source = hub.nodes.create('vst');
  const sequencer = hub.nodes.create('sequencer');
  const mixer = hub.nodes.create('mixer');
  const track = hub.sequencer.model.addTrack('audio');
  hub.sequencer.model.updateTrack(track.id, {
    armed: true, inputId: source.id, outputId: mixer.id
  });
  hub.sequencer.changed();
  await flush();

  let nativeTrack = sentOf(api, 'syncSequencer').at(-1).project.tracks
    .find((candidate) => candidate.id === track.id);
  assert.equal(nativeTrack.inputId, '',
    'a selected audio source without a Patch Bay cable cannot feed recording');
  assert.equal(nativeTrack.outputId, '',
    'a selected audio destination without a Patch Bay cable cannot receive clips');

  assert.deepEqual(createConnection(hub.graph,
    { nodeId: source.id, portId: 'audio-out' },
    { nodeId: sequencer.id, portId: 'audio-in' }), { ok: true });
  assert.deepEqual(createConnection(hub.graph,
    { nodeId: sequencer.id, portId: 'audio-out' },
    { nodeId: mixer.id, portId: 'audio-in-1' }), { ok: true });
  assert.deepEqual(createConnection(hub.graph,
    { nodeId: mixer.id, portId: 'audio-out' },
    { nodeId: 'audio-output', portId: 'audio-in' }), { ok: true });
  hub.sequencer.changed();
  await flush();

  nativeTrack = sentOf(api, 'syncSequencer').at(-1).project.tracks
    .find((candidate) => candidate.id === track.id);
  assert.equal(nativeTrack.inputId, source.id,
    'the visible source -> Sequencer AUDIO IN cable enables capture');
  assert.equal(nativeTrack.outputId, mixer.id,
    'the visible Sequencer AUDIO OUT -> Mixer cable enables playback');

  const audioGraph = describeAudioGraph(hub);
  assert.deepEqual(audioGraph.find((node) => node.id === sequencer.id).inputs, [{
    portId: 'audio-in', sourceNodeId: source.id, sourcePortId: 'audio-out', level: 1, muted: false
  }]);
  assert.equal(audioGraph.find((node) => node.id === mixer.id).inputs[0].sourceNodeId, sequencer.id);
  assert.equal(audioGraph.find((node) => node.id === 'audio-output').inputs[0].sourceNodeId, mixer.id);

  hub.graph.disconnect(source.id, 'audio-out', sequencer.id, 'audio-in');
  hub.sequencer.changed();
  await flush();
  nativeTrack = sentOf(api, 'syncSequencer').at(-1).project.tracks
    .find((candidate) => candidate.id === track.id);
  assert.equal(nativeTrack.inputId, '', 'removing the audio cable disables capture again');
});

test('project disk round-trip preserves Sequencer presence, ports, cables and clips; fresh New does not resurrect it', async (t) => {
  const { hub } = await makeRuntime({ transportBpm: 132 });
  registerSystemNodes(hub);
  const sequencer = hub.nodes.create('sequencer');
  const vst = hub.nodes.create('vst');
  const mixer = hub.nodes.create('mixer');

  hub.graph.connect('minilab-3', 'midi-out', sequencer.id, 'midi-in');
  hub.graph.connect(sequencer.id, 'midi-out', vst.id, 'midi-in');
  hub.graph.connect(vst.id, 'audio-out', sequencer.id, 'audio-in');
  hub.graph.connect(sequencer.id, 'audio-out', mixer.id, 'audio-in-1');
  hub.graph.connect(mixer.id, 'audio-out', 'audio-output', 'audio-in');

  const midiTrack = hub.sequencer.model.addTrack('midi');
  hub.sequencer.model.updateTrack(midiTrack.id, {
    armed: true, inputId: 'web-midi-port-7', outputId: vst.id
  });
  hub.sequencer.model.addMidiClip(midiTrack.id, 4, 4, [{
    pitch: 67, startPpq: 0.5, durationPpq: 1.25, velocity: 93, channel: 4
  }]);
  const audioTrack = hub.sequencer.model.addTrack('audio');
  hub.sequencer.model.updateTrack(audioTrack.id, {
    armed: true, inputId: vst.id, outputId: mixer.id
  });
  hub.sequencer.model.addAudioClip(audioTrack.id, {
    name: 'Recorded take', filePath: 'D:\\Audio\\take.wav', startPpq: 8,
    lengthPpq: 2, durationSeconds: 1, trimStartSeconds: 0, trimEndSeconds: 1, gain: 0.8
  });
  hub.sequencer.changed();
  await flush();

  const saved = hub.project.snapshot();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minihub-sequencer-acceptance-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'Sequencer round trip.minihub');
  writeProjectAtomic(filePath, saved);
  const reopened = readProject(filePath);

  const { hub: restored } = await makeRuntime({}, false);
  restored.project.applySnapshot(reopened, filePath);
  registerSystemNodes(restored);
  restored.sequencer.load();
  await restored.nodes.load();
  restored.graph.restore(restored.settings.get('graphConnections'));
  await flush();

  const restoredSequencer = restored.nodes.list().find((node) => node.type === 'sequencer');
  assert.ok(restoredSequencer, 'the explicitly-created Sequencer survives reload');
  exactSequencerPorts(restored.graph.getNode(restoredSequencer.id));
  assert.deepEqual(restored.graph.serialize(), reopened.graph.connections,
    'all visible cables survive reload unchanged');
  assert.deepEqual(restored.sequencer.model.snapshot(), reopened.sequencer,
    'tracks, MIDI notes and audio clips survive reload unchanged');

  const retainedArrangement = structuredClone(restored.sequencer.model.snapshot());
  assert.equal(restored.nodes.delete(restoredSequencer.id), true);
  assert.deepEqual(restored.sequencer.model.snapshot(), retainedArrangement,
    'deleting after reload preserves every arrangement datum');
  const removedFile = path.join(dir, 'Sequencer node removed.minihub');
  writeProjectAtomic(removedFile, restored.project.snapshot());
  const removedProject = readProject(removedFile);
  assert.equal(removedProject.nodeInstances.instances.some((node) => node.type === 'sequencer'), false);
  assert.deepEqual(removedProject.sequencer, retainedArrangement);

  const { hub: removedReload } = await makeRuntime({}, false);
  removedReload.project.applySnapshot(removedProject, removedFile);
  registerSystemNodes(removedReload);
  removedReload.sequencer.load();
  await removedReload.nodes.load();
  removedReload.graph.restore(removedReload.settings.get('graphConnections'));
  assert.equal(removedReload.nodes.list().some((node) => node.type === 'sequencer'), false,
    'save/reload keeps the routing node absent');
  assert.deepEqual(removedReload.sequencer.model.snapshot(), retainedArrangement,
    'save/reload while absent keeps the arrangement');

  const readded = removedReload.nodes.create('sequencer');
  assert.equal(readded.id, 'sequencer');
  assert.deepEqual(removedReload.sequencer.model.snapshot(), retainedArrangement);
  const readdedFile = path.join(dir, 'Sequencer node readded.minihub');
  writeProjectAtomic(readdedFile, removedReload.project.snapshot());
  const readdedProject = readProject(readdedFile);
  const { hub: readdedReload } = await makeRuntime({}, false);
  readdedReload.project.applySnapshot(readdedProject, readdedFile);
  registerSystemNodes(readdedReload);
  readdedReload.sequencer.load();
  await readdedReload.nodes.load();
  readdedReload.graph.restore(readdedReload.settings.get('graphConnections'));
  assert.equal(readdedReload.nodes.list().filter((node) => node.type === 'sequencer').length, 1,
    'save/reload after re-add restores exactly one node');
  assert.deepEqual(readdedReload.sequencer.model.snapshot(), retainedArrangement,
    'save/reload after re-add still uses the original arrangement');

  const now = new Date().toISOString();
  const freshProject = {
    format: 'minihub-project', version: 1, projectId: 'fresh-new', name: 'Untitled',
    createdAt: now, modifiedAt: now,
    graph: { connections: [], layout: {}, viewport: null },
    nodeInstances: { instances: [], idSeq: {} }, transport: { bpm: 120 }
  };
  const { hub: fresh } = await makeRuntime({}, false);
  fresh.project.applySnapshot(freshProject, null);
  registerSystemNodes(fresh);
  fresh.sequencer.load();
  await fresh.nodes.load();
  fresh.graph.restore(fresh.settings.get('graphConnections'));
  assert.equal(fresh.nodes.list().some((node) => node.type === 'sequencer'), false);
  assert.equal(fresh.nodes.list().some((node) => node.type === 'audio-input'), false);
  assert.equal(fresh.graph.listNodes().some((node) => node.type === 'sequencer'), false,
    'a fresh New project does not inherit or inject the previous Sequencer');
  assert.deepEqual(fresh.graph.listNodes().map((node) => node.id).sort(), ['audio-output', 'minilab-3']);
});

test('real renderer bootstrap of a staged New project does not inject a Sequencer', async () => {
  installDom();
  const api = mockApi();
  const { container: content } = routingContainer();
  const elements = new Map([
    ['sidebar', makeEl('nav')], ['content', content], ['device-status', makeEl('span')],
    ['modal-root', makeEl('div')], ['settings-button', makeEl('button')],
    ['project-identity', makeEl('span')], ['project-save', makeEl('button')],
    ['project-save-as', makeEl('button')], ['transport-play', makeEl('button')],
    ['transport-stop', makeEl('button')],
    ['transport-bpm', makeEl('input')]
  ]);
  document.getElementById = (id) => elements.get(id) || null;
  window.hubAPI = api;

  const now = new Date().toISOString();
  const freshProject = {
    format: 'minihub-project', version: 1, projectId: 'staged-new', name: 'Untitled',
    createdAt: now, modifiedAt: now,
    graph: { connections: [], layout: {}, viewport: null },
    nodeInstances: { instances: [], idSeq: {} }, transport: { bpm: 120 }
  };
  const session = new Map([['minihub.stagedProject', JSON.stringify({
    project: freshProject, filePath: null, unsaved: true, targetModule: 'routing'
  })]]);
  globalThis.sessionStorage = {
    getItem: (key) => session.get(key) ?? null,
    setItem: (key, value) => session.set(key, String(value)),
    removeItem: (key) => session.delete(key)
  };
  globalThis.location = { reload() {} };
  const originalGetEntriesByType = globalThis.performance.getEntriesByType;
  Object.defineProperty(globalThis.performance, 'getEntriesByType', {
    configurable: true, value: () => [{ type: 'reload' }]
  });

  try {
    await import(`../src/renderer/js/app.js?sequencer-new-project=${Date.now()}`);
    const listeners = [...(window._listeners.DOMContentLoaded || [])];
    assert.equal(listeners.length, 1, 'the real renderer entrypoint registered its bootstrap');
    listeners[0]();
    for (let i = 0; i < 20 && sentOf(api, 'syncAudioGraph').length === 0; i += 1) await flush();
    const published = sentOf(api, 'syncAudioGraph').at(-1);
    assert.ok(published, 'renderer bootstrap published the real audio graph');
    assert.equal(published.nodes.some((node) => node.nodeType === 'sequencer'), false,
      'New reaches Patch Bay without an automatically injected Sequencer node');
    assert.equal(published.nodes.some((node) => node.nodeType === 'audio-input'), false,
      'New does not publish an automatic Audio Input node');
  } finally {
    Object.defineProperty(globalThis.performance, 'getEntriesByType', {
      configurable: true, value: originalGetEntriesByType
    });
  }
});
