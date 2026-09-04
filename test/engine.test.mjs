import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from '../src/renderer/js/core/hub.js';
import { describeMidiNetwork, setupEngineSync } from '../src/renderer/js/core/engineSync.js';
import { createAudioOutputModule } from '../src/renderer/js/modules/audioOutput/audioOutputModule.js';
import { getNodeType } from '../src/renderer/js/core/nodeTypes.js';
import { setupMidiRouting } from '../src/renderer/js/core/midiRouting.js';

/** In-memory API that mirrors the preload `hubAPI` surface. */
function mockApi(initialSettings = {}) {
  const data = { ...initialSettings };
  const sent = [];
  const listeners = { event: [], state: [] };
  return {
    data,
    sent,
    emitEvent(msg) { listeners.event.forEach((cb) => cb(msg)); },
    emitState(s) { listeners.state.forEach((cb) => cb(s)); },
    loadSettings: async () => ({ ...data }),
    saveSettings: async (s) => { Object.assign(data, s); return true; },
    engineCommand: async (msg) => { sent.push(msg); return { ok: true }; },
    engineState: async () => ({ state: 'running', error: null }),
    onEngineEvent: (cb) => { listeners.event.push(cb); return () => {}; },
    onEngineState: (cb) => { listeners.state.push(cb); return () => {}; }
  };
}

function sentOf(api, type) {
  return api.sent.filter((m) => m.type === type);
}

test('sample-clocked native metronome ticks cross the engine client unchanged', async () => {
  const api = mockApi();
  const hub = createHub(api);
  await hub.engine.init();
  const seen = [];
  hub.events.on('engine:metronomeTick', (event) => seen.push(event));
  const tick = {
    type: 'metronomeTick', sequence: 9, timeInSamples: 48000,
    ppqPosition: 2, beat: 2, beatInBar: 2, accent: false, preCount: true
  };
  api.emitEvent(tick);
  assert.deepEqual(seen, [tick]);
});

// ---- VST catalog -----------------------------------------------------------
test('an automatic scan never shrinks the VST catalog; an explicit rescan does', async () => {
  const full = Array.from({ length: 48 }, (_, i) => ({ pluginId: `p${i}`, name: `Plugin ${i}`, role: 'instrument' }));
  const api = mockApi();
  const hub = createHub(api);
  await hub.engine.init();

  api.emitEvent({ type: 'plugins', plugins: full });
  assert.equal(hub.engine.plugins.length, 48);
  assert.equal(hub.settings.get('vstCatalog').length, 48);

  // A degraded or interrupted scan reporting a single plugin must not replace
  // a known-good catalog - this is what emptied the picker in practice.
  api.emitEvent({ type: 'plugins', plugins: [full[0]] });
  assert.equal(hub.engine.plugins.length, 48);
  assert.equal(hub.settings.get('vstCatalog').length, 48, 'the persisted catalog is untouched');

  // An empty result proves nothing either.
  api.emitEvent({ type: 'plugins', plugins: [] });
  assert.equal(hub.engine.plugins.length, 48);

  // A bigger automatic result is accepted.
  api.emitEvent({ type: 'plugins', plugins: [...full, { pluginId: 'new', name: 'New', role: 'instrument' }] });
  assert.equal(hub.engine.plugins.length, 49);

  // A rescan the user asked for is authoritative, including when it shrinks.
  hub.engine.scanVst3(true);
  api.emitEvent({ type: 'plugins', plugins: [full[0], full[1]] });
  assert.equal(hub.engine.plugins.length, 2);
  assert.equal(hub.settings.get('vstCatalog').length, 2);

  // That override applies to one result only.
  api.emitEvent({ type: 'plugins', plugins: [full[0]] });
  assert.equal(hub.engine.plugins.length, 2);
});

test('a catalog persisted before class UIDs existed survives and upgrades in place', async () => {
  // Exactly what sits in settings.json on a machine that last scanned before
  // `classId` was a field. Losing these entries on upgrade would be invariant
  // 12 broken by the very change meant to enrich them.
  const legacy = [
    { pluginId: 'C:/VST3/Massive X.vst3', name: 'Massive X', manufacturer: 'Native Instruments', role: 'instrument' },
    { pluginId: 'C:/VST3/Dexed.vst3', name: 'Dexed', manufacturer: 'Digital Suburban', role: 'instrument' }
  ];
  const api = mockApi({ vstCatalog: legacy });
  const hub = createHub(api);
  await hub.settings.load();
  await hub.engine.init();

  assert.equal(hub.engine.plugins.length, 2, 'a UID-less catalog still loads');
  assert.equal(hub.engine.getPlugin('C:/VST3/Massive X.vst3').name, 'Massive X');
  assert.equal(hub.engine.getPlugin('C:/VST3/Massive X.vst3').classId, undefined);

  // A rescan of the same size carries the UIDs. `_acceptsCatalog` compares
  // lengths, so an equal-sized result is accepted and the upgrade lands
  // without the user having to ask for a rescan.
  api.emitEvent({
    type: 'plugins',
    plugins: [
      { ...legacy[0], classId: '565354FF4D61737369766558000000' + '00' },
      { ...legacy[1], classId: '5653544465786564446578656400' + '0000' }
    ]
  });
  assert.equal(hub.engine.plugins.length, 2);
  assert.equal(hub.engine.getPlugin('C:/VST3/Dexed.vst3').classId.length, 32);
  assert.equal(hub.settings.get('vstCatalog')[0].classId.length, 32);
});

test('a plugin whose class UID could not be read stays in the catalog', async () => {
  // Reading a UID opens the module a second time; a plugin that refuses gives
  // an empty classId. It must remain fully usable: manufacturer + name still
  // identify it, and only the portable identity is missing.
  const api = mockApi();
  const hub = createHub(api);
  await hub.engine.init();

  api.emitEvent({
    type: 'plugins',
    plugins: [
      { pluginId: 'C:/VST3/Old.vst3', name: 'Old', manufacturer: 'Acme', role: 'audio-effect', classId: '' },
      { pluginId: 'C:/VST3/New.vst3', name: 'New', manufacturer: 'Acme', role: 'instrument', classId: 'A'.repeat(32) }
    ]
  });

  assert.equal(hub.engine.plugins.length, 2);
  const old = hub.engine.getPlugin('C:/VST3/Old.vst3');
  assert.equal(old.classId, '');
  assert.equal(old.name, 'Old', 'an unreadable UID must not cost the entry');
});

test('a running scan is visible: scanning state flips on request and on the result', async () => {
  const api = mockApi();
  const hub = createHub(api);
  await hub.engine.init();
  // Startup already scans when no catalog is cached; settle that first.
  api.emitEvent({ type: 'plugins', plugins: [{ pluginId: 'X', name: 'Dexed', role: 'instrument' }] });
  assert.equal(hub.engine.scanning, false);
  const seen = [];
  hub.events.on('engine:scanning', (scanning) => seen.push(scanning));

  hub.engine.scanVst3(true);
  assert.equal(hub.engine.scanning, true, 'the click alone marks the scan as running');

  // The engine confirms, then answers minutes later with the catalog.
  api.emitEvent({ type: 'status', engine: 'running', scanning: true });
  assert.equal(hub.engine.scanning, true);
  api.emitEvent({ type: 'plugins', plugins: [{ pluginId: 'X', name: 'Dexed', role: 'instrument' }] });
  assert.equal(hub.engine.scanning, false, 'the result always clears the scanning state');
  assert.equal(hub.engine.plugins.length, 1);
  assert.deepEqual(seen, [true, false], 'the UI is notified once per transition');
});

test('a rejected or failed scan rolls back the optimistic UI latch', async () => {
  const api = mockApi();
  const hub = createHub(api);
  await hub.engine.init();
  api.emitEvent({ type: 'plugins', plugins: [{ pluginId: 'X', name: 'Dexed', role: 'instrument' }] });
  const seen = [];
  hub.events.on('engine:scanning', (scanning) => seen.push(scanning));

  api.engineCommand = async (msg) => {
    api.sent.push(msg);
    return { ok: false, reason: 'engine-not-started' };
  };
  assert.deepEqual(await hub.engine.scanVst3(true), { ok: false, reason: 'engine-not-started' });
  assert.equal(hub.engine.scanning, false);
  assert.equal(hub.engine._userScanPending, false);

  api.engineCommand = async (msg) => {
    api.sent.push(msg);
    throw new Error('ipc-closed');
  };
  await assert.rejects(hub.engine.scanVst3(true), /ipc-closed/);
  assert.equal(hub.engine.scanning, false);
  assert.equal(hub.engine._userScanPending, false);
  assert.deepEqual(seen, [true, false, true, false]);
});

// ---- engine protocol serialization -----------------------------------------
test('engine client serializes commands with the versioned protocol', async () => {
  const api = mockApi();
  const hub = createHub(api);
  hub.engine.init();
  await hub.engine.midi('vst-001', [0x90, 60, 100]);
  await hub.engine.setBypass('vst-001', 'plugin-1', true);
  await hub.engine.createInstance('vst-001', 'X', 'plugin-2', 1);
  assert.deepEqual(sentOf(api, 'midi')[0], { v: 1, type: 'midi', chainId: 'vst-001', data: [0x90, 60, 100] });
  assert.deepEqual(sentOf(api, 'setBypass')[0], { v: 1, type: 'setBypass', chainId: 'vst-001', instanceId: 'plugin-1', bypassed: true });
  const create = sentOf(api, 'createInstance')[0];
  assert.match(create.requestId, /^create-/);
  assert.deepEqual(
    { ...create, requestId: '<opaque>' },
    { v: 1, type: 'createInstance', requestId: '<opaque>', chainId: 'vst-001', pluginId: 'X', instanceId: 'plugin-2', index: 1 }
  );
});

test('Master Export clones its snapshot while live network, MIDI and transport stay immediate', async () => {
  const api = mockApi();
  const hub = createHub(api);
  await hub.engine.init();
  await new Promise((resolve) => setImmediate(resolve));
  api.sent.length = 0;

  await hub.engine.sequencerExport({
    filePath: 'C:/frozen.wav', bits: 24, startPpq: 0, endPpq: 8, tailSeconds: 1
  });
  api.emitEvent({ type: 'sequencerExport', state: 'started', filePath: 'C:/frozen.wav' });
  api.emitEvent({ type: 'sequencerExport', state: 'progress', progress: 0.5, filePath: 'C:/frozen.wav' });

  await hub.engine.syncAudioNetwork([{ id: 'new-mixer', masterLevel: 0.25 }]);
  await hub.engine.syncMidiNetwork([{ id: 'new-arp', nodeType: 'arpeggiator' }]);
  await hub.engine.syncSequencer({ tracks: [{ id: 'edited-track', muted: true }] });
  await hub.engine.setChainMidiEnabled('vst-001', false);
  await hub.engine.setChainOutputEnabled('vst-001', false);
  await hub.engine.setTransport({ bpm: 96, playing: false });
  await hub.engine.setBypass('vst-001', 'plugin-1', true);
  await hub.engine.setState('vst-001', 'plugin-1', 'later-state');
  await hub.engine.selectMidiOutput({ identifier: 'later-output', name: 'Later Output' });
  await hub.engine.midi('vst-001', [0x90, 67, 100]);
  await hub.engine.midi('vst-001', [0x80, 67, 0]);
  await hub.engine.sequencerPanic();
  await hub.engine.selectDevice('later-device', 48000, 256);

  assert.deepEqual(api.sent.map((message) => message.type), [
    'sequencerExport', 'syncAudioNetwork', 'syncMidiNetwork', 'syncSequencer',
    'setChainMidiEnabled', 'setChainOutputEnabled', 'setTransport',
    'setBypass', 'setState', 'selectMidiOutput', 'midi', 'midi', 'sequencerPanic'
  ], 'all live state, including the held Note Off, addresses processors disjoint from the clones');

  api.emitEvent({ type: 'sequencerExport', state: 'finalizing', filePath: 'C:/frozen.wav' });
  api.emitEvent({ type: 'sequencerExport', state: 'complete', filePath: 'C:/frozen.wav' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(api.sent.map((message) => message.type), [
    'sequencerExport', 'syncAudioNetwork', 'syncMidiNetwork', 'syncSequencer',
    'setChainMidiEnabled', 'setChainOutputEnabled', 'setTransport',
    'setBypass', 'setState', 'selectMidiOutput', 'midi', 'midi', 'sequencerPanic',
    'selectDevice'
  ], 'only the audio-device restart waits until the private writer is terminal');

  await hub.engine.sequencerExport({
    filePath: 'C:/next.wav', bits: 24, startPpq: 0, endPpq: 8, tailSeconds: 1
  });
  assert.equal(api.sent.at(-1).type, 'sequencerExport',
    'the next export starts after the newly published state');
});

test('project quiesce remains an exact native barrier during an export', async () => {
  const api = mockApi();
  const hub = createHub(api);
  await hub.engine.init();
  await new Promise((resolve) => setImmediate(resolve));
  api.sent.length = 0;

  await hub.engine.sequencerExport({
    filePath: 'C:/cancelled.wav', bits: 24, startPpq: 0, endPpq: 8, tailSeconds: 0
  });
  await hub.engine.syncAudioNetwork([{ id: 'old-project-route' }]);
  let settled = false;
  const quiesce = hub.engine.sequencerQuiesce().then((value) => { settled = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));
  const requestId = api.sent.at(-1).requestId;
  assert.match(requestId, /^quiesce-/);
  assert.equal(settled, false, 'the IPC write acknowledgement is not the native quiesce barrier');
  api.emitEvent({ type: 'sequencerQuiesced', requestId: 'quiesce-stale', wasRecording: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'an unrelated native acknowledgement cannot release the barrier');
  api.emitEvent({ type: 'sequencerQuiesced', requestId, wasRecording: false });
  assert.equal((await quiesce).requestId, requestId);
  api.emitEvent({ type: 'sequencerExport', state: 'complete', filePath: 'C:/cancelled.wav' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(api.sent.map((message) => message.type), ['sequencerExport', 'syncAudioNetwork', 'sequencerQuiesce'],
    'the old live command is immediate and no delayed command can replay after the barrier');
});

test('native MIDI network commands use the versioned engine boundary', async () => {
  const api = mockApi();
  const hub = createHub(api);
  await hub.engine.syncMidiNetwork([{ id: 'arpeggiator-001', nodeType: 'arpeggiator' }]);
  await hub.engine.midiNode('arpeggiator-001', [0x90, 60, 100]);
  assert.deepEqual(sentOf(api, 'syncMidiNetwork')[0], {
    v: 1, type: 'syncMidiNetwork', nodes: [{ id: 'arpeggiator-001', nodeType: 'arpeggiator' }]
  });
  assert.deepEqual(sentOf(api, 'midiNode')[0], {
    v: 1, type: 'midiNode', nodeId: 'arpeggiator-001', data: [0x90, 60, 100]
  });
});

test('physical MIDI output discovery, state and selection cross the versioned engine boundary', async () => {
  const api = mockApi();
  const hub = createHub(api);
  await hub.engine.init();
  const states = [];
  hub.events.on('engine:midiOutputState', (state) => states.push(state));

  api.emitEvent({ type: 'devices', midiOutputs: [{ identifier: 'system-midi-out', name: 'System MIDI Out' }] });
  api.emitEvent({ type: 'midiOutputState', available: true, identifier: 'system-midi-out', name: 'System MIDI Out' });
  await hub.engine.selectMidiOutput({ identifier: 'system-midi-out', name: 'System MIDI Out' });

  assert.deepEqual(hub.engine.midiOutputs, [{ identifier: 'system-midi-out', name: 'System MIDI Out' }]);
  assert.equal(hub.engine.midiOutputState.available, true);
  assert.equal(states.length, 1);
  assert.deepEqual(sentOf(api, 'selectMidiOutput')[0], {
    v: 1, type: 'selectMidiOutput', identifier: 'system-midi-out', name: 'System MIDI Out'
  });
});

test('MIDI network describes the existing Arpeggiator route to VST and hardware destinations', () => {
  const api = mockApi();
  const hub = createHub(api);
  hub.network.addNode({ id: 'sequencer', name: 'Sequencer', type: 'sequencer', inputs: [], outputs: [{ id: 'midi-out', type: 'midi' }] });
  hub.network.addNode({ id: 'arp-001', name: 'Arpeggiator', type: 'arpeggiator', inputs: [{ id: 'midi-in', type: 'midi' }], outputs: [{ id: 'midi-out', type: 'midi' }] });
  hub.network.addNode({ id: 'vst-001', name: 'VST', type: 'vst', inputs: [{ id: 'midi-in', type: 'midi' }], outputs: [] });
  hub.network.addNode({ id: 'minilab-3', name: 'MIDI Output', type: 'midi-output', inputs: [{ id: 'midi-in', type: 'midi' }], outputs: [] });
  hub.network.connect('sequencer', 'midi-out', 'arp-001', 'midi-in');
  hub.network.connect('arp-001', 'midi-out', 'vst-001', 'midi-in');
  hub.network.connect('arp-001', 'midi-out', 'minilab-3', 'midi-in');

  const arp = describeMidiNetwork(hub).find((node) => node.id === 'arp-001');
  assert.deepEqual(arp.incoming ?? arp.inputs, [{ sourceNodeId: 'sequencer', sourcePortId: 'midi-out' }]);
  assert.deepEqual(arp.destinations, ['vst-001', 'minilab-3']);
});

test('tracked plugin creates receive distinct opaque operation identities', async () => {
  const api = mockApi();
  const hub = createHub(api);
  const first = hub.engine.createInstanceTracked('vst-001', 'X', 'plugin-1', 0);
  const second = hub.engine.createInstanceTracked('vst-001', 'X', 'plugin-1', 0);
  await Promise.all([first.accepted, second.accepted]);
  assert.notEqual(first.requestId, second.requestId);
  assert.deepEqual(sentOf(api, 'createInstance').map((m) => m.requestId), [first.requestId, second.requestId]);
});

test('engine client parses real plugin registry events', () => {
  const api = mockApi();
  const hub = createHub(api);
  hub.engine.init();
  api.emitEvent({
    type: 'plugins',
    plugins: [{ pluginId: 'X', name: 'Dexed', manufacturer: 'Digital Suburban', role: 'instrument' }]
  });
  assert.equal(hub.engine.plugins.length, 1);
  assert.equal(hub.engine.getPlugin('X').name, 'Dexed');
  assert.equal(hub.engine.getPlugin('missing'), null);
});

// ---- engine lifecycle state ------------------------------------------------
test('engine client reflects lifecycle state from the main process', async () => {
  const api = mockApi();
  const hub = createHub(api);
  hub.engine.init();
  await hub.engine.init(); // ensure engineState resolved
  assert.equal(hub.engine.state, 'running');
  api.emitState({ state: 'error', error: 'engine crashed' });
  assert.equal(hub.engine.state, 'error');
  assert.equal(hub.engine.error, 'engine crashed');
  api.emitState({ state: 'running', error: null });
  assert.equal(hub.engine.state, 'running');
});

// ---- Audio Output node protection ------------------------------------------
test('Audio Output is a native/system node: non-deletable, non-copyable, AUDIO IN only', () => {
  const api = mockApi();
  const hub = createHub(api);
  hub.modules.register(createAudioOutputModule(hub));

  // It is NOT a user instance, so it cannot be deleted or copied.
  assert.equal(hub.nodes.get('audio-output'), null);
  assert.equal(hub.nodes.delete('audio-output'), false);

  const node = hub.network.getNode('audio-output');
  assert.ok(node, 'audio-output must exist in the network');
  assert.deepEqual(node.inputs.map((p) => p.id), ['audio-in']);
  assert.equal(node.inputs[0].type, 'audio');
  assert.equal(node.outputs.length, 0);
});

// ---- network MIDI connection controls MIDI forwarding ------------------------
test('MIDI is forwarded to the engine only while MiniLab is connected to the VST node', async () => {
  const api = mockApi();
  const hub = createHub(api);
  hub.engine.init();
  hub.network.addNode({ id: 'minilab-3', name: 'MiniLab', outputs: [{ id: 'midi-out', type: 'midi' }] });
  const inst = hub.nodes.create('vst');

  // Not connected yet -> no MIDI reaches the engine.
  hub.network.emitData('minilab-3', 'midi-out', { raw: [0x90, 60, 100] });
  assert.equal(sentOf(api, 'midi').length, 0);

  // Connect MiniLab MIDI OUT -> VST MIDI IN.
  hub.network.connect('minilab-3', 'midi-out', inst.id, 'midi-in');
  hub.network.emitData('minilab-3', 'midi-out', { raw: [0x90, 60, 100] });
  assert.equal(sentOf(api, 'midi').length, 1);
  assert.equal(sentOf(api, 'midi')[0].chainId, inst.id);
  assert.deepEqual(sentOf(api, 'midi')[0].data, [0x90, 60, 100]);

  // Disconnect -> new MIDI no longer reaches the engine.
  hub.network.disconnect('minilab-3', 'midi-out', inst.id, 'midi-in');
  hub.network.emitData('minilab-3', 'midi-out', { raw: [0x91, 60, 0] });
  assert.equal(sentOf(api, 'midi').length, 1);
});

test('physical ingress takes the processor boundary for MiniLab -> Arpeggiator -> VST', async () => {
  const api = mockApi();
  const hub = createHub(api);
  await hub.engine.init();
  hub.network.addNode({ id: 'minilab-3', name: 'MiniLab', outputs: [{ id: 'midi-out', type: 'midi' }] });
  const arp = hub.nodes.create('arpeggiator');
  const vst = hub.nodes.create('vst');
  hub.network.connect('minilab-3', 'midi-out', arp.id, 'midi-in');
  hub.network.connect(arp.id, 'midi-out', vst.id, 'midi-in');
  const dispose = setupMidiRouting(hub);

  hub.events.emit('midi:message', {
    type: 'noteon', channel: 1, note: 60, velocity: 100, raw: [0x90, 60, 100]
  });

  assert.deepEqual(sentOf(api, 'midiNode').at(-1), {
    v: 1, type: 'midiNode', nodeId: arp.id, data: [0x90, 60, 100]
  }, 'physical Note On enters the native processor node');
  assert.equal(sentOf(api, 'midi').length, 0,
    'the physical note does not bypass the Arpeggiator into the destination VST');
  dispose();
});

// ---- network audio connection controls physical output assignment ------------
test('authoritative audio network controls VST assignment to Audio Output', () => {
  const api = mockApi();
  const hub = createHub(api);
  hub.engine.init();
  hub.modules.register(createAudioOutputModule(hub));
  setupEngineSync(hub);

  const inst = hub.nodes.create('vst');
  const lastNetwork = () => sentOf(api, 'syncAudioNetwork').at(-1).nodes;

  // No audio connection yet -> output disabled.
  assert.equal(lastNetwork().find((n)=>n.id==='audio-output').inputs.length, 0);

  // Connect VST AUDIO OUT -> Audio Output AUDIO IN.
  hub.network.connect(inst.id, 'audio-out', 'audio-output', 'audio-in');
  assert.equal(lastNetwork().find((n)=>n.id==='audio-output').inputs[0].sourceNodeId, inst.id);

  // Disconnect -> output disabled again.
  hub.network.disconnect(inst.id, 'audio-out', 'audio-output', 'audio-in');
  assert.equal(lastNetwork().find((n)=>n.id==='audio-output').inputs.length, 0);
});

// ---- plugin-chain synchronization commands ----------------------------------
test('adding a plugin to a VST chain issues an engine createInstance command', async () => {
  const api = mockApi();
  const hub = createHub(api);
  hub.engine.init();
  const inst = hub.nodes.create('vst');
  const chain = hub.nodes.getChain(inst.id);
  const p = chain.append({ pluginId: 'X', name: 'Dexed', role: 'instrument' });
  hub.engine.createInstance(inst.id, p.pluginId, p.id, chain.plugins.length - 1);

  const cmds = sentOf(api, 'createInstance');
  assert.equal(cmds.length, 1);
  assert.equal(cmds[0].chainId, inst.id);
  assert.equal(cmds[0].pluginId, 'X');
  assert.equal(cmds[0].instanceId, p.id);
  assert.equal(cmds[0].index, 0);
});

// ---- stable plugin identity persistence + no native handles ----------------
test('persisted VST chain stores stable plugin identity and never native handles', async () => {
  const api = mockApi();
  const hub = createHub(api);
  const inst = hub.nodes.create('vst');
  const chain = hub.nodes.getChain(inst.id);
  chain.append({ pluginId: 'X', name: 'Dexed', role: 'instrument', state: 'AQID' });
  chain.append({ pluginId: 'Y', name: 'ValhallaDelay', role: 'audio-effect' });

  const serialized = JSON.stringify(api.data.nodeInstances);
  assert.ok(serialized.includes('"pluginId":"X"'));
  assert.ok(serialized.includes('"pluginId":"Y"'));
  assert.ok(!/native|handle|pointer|HWND|ptr/i.test(serialized), 'no native/runtime handles serialized');

  // Relaunch over the same settings.
  const api2 = mockApi(api.data);
  const hub2 = createHub(api2);
  await hub2.settings.load();
  await hub2.nodes.load();
  const inst2 = hub2.nodes.get(inst.id);
  assert.equal(inst2.content.plugins.length, 2);
  assert.equal(inst2.content.plugins[0].pluginId, 'X');
  assert.equal(inst2.content.plugins[0].id, 'plugin-1', 'stable plugin instance id across reload');
  assert.equal(inst2.content.plugins[1].role, 'audio-effect');
});

// ---- engine unavailable / error behavior -----------------------------------
test('VST editor reports engine-unavailable state when the engine is down', () => {
  const api = mockApi();
  const hub = createHub(api);
  hub.engine.init();
  api.emitState({ state: 'error', error: 'engine exited unexpectedly' });
  assert.equal(hub.engine.state, 'error');
  // The engine client surfaces the error; UI derives from it.
  assert.ok(hub.engine.error.includes('engine'));
});

// ---- node type registry still intact ---------------------------------------
test('Audio Output is a system node type, not a user node type', () => {
  assert.equal(getNodeType('audio-output'), null, 'audio-output is not a user-created node type');
});
