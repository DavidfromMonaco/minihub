import fs from 'node:fs';

const [port = '9457', artifactDirectory = '', pluginPath = ''] = process.argv.slice(2);
if (!artifactDirectory || !pluginPath) {
  throw new Error('Usage: runtime-vst-midi-gauntlet.mjs <port> <artifact-directory> <deterministic-vst3-path>');
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
let targets;
for (let attempt = 0; attempt < 80; attempt += 1) {
  try {
    targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => {
      if (!response.ok) throw new Error(`CDP HTTP ${response.status}`);
      return response.json();
    });
    if (targets.some((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl
      && /\/index\.html(?:$|[?#])/.test(entry.url || ''))) break;
  } catch {}
  await sleep(125);
}

const target = targets?.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl
  && /\/index\.html(?:$|[?#])/.test(entry.url || ''));
if (!target) throw new Error(`No MiniHub main renderer target on CDP port ${port}`);

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

let sequence = 0;
const pending = new Map();
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data));
  if (!message.id || !pending.has(message.id)) return;
  const request = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error.message));
  else request.resolve(message.result);
});

function send(method, params = {}) {
  const id = ++sequence;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

await send('Runtime.enable');
const artifactRoot = artifactDirectory.replaceAll('\\', '/');
const runtimePlugin = pluginPath.replaceAll('\\', '/');
const runStamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
const exportPath = `${artifactRoot}/runtime-vst-routing-${runStamp}.wav`;

const expression = `(async () => {
  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const sameGains = (actual, expected, tolerance = 0.000001) => Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => Math.abs(Number(value) - expected[index]) <= tolerance);
  const samePath = (left, right) => String(left).split(String.fromCharCode(92)).join('/').toLowerCase()
    === String(right).split(String.fromCharCode(92)).join('/').toLowerCase();
  const nativeEvents = [];
  const routedMidi = [];
  let engine;
  const nativeOff = window.hubAPI.onEngineEvent((message) => {
    nativeEvents.push({ ...message, observedAt: Date.now() });
    engine?._onEvent(message);
  });
  const command = async (payload) => {
    const result = await window.hubAPI.engineCommand({ v: 1, ...payload });
    assert(result?.ok === true, 'engine command rejected: ' + payload.type + ' / ' + JSON.stringify(result));
    return result;
  };
  const waitFor = async (predicate, after, description, timeout = 30000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const found = nativeEvents.slice(after).find(predicate);
      if (found) return found;
      await sleep(20);
    }
    const errors = nativeEvents.slice(after).filter((event) => event.type === 'error');
    throw new Error('timeout waiting for ' + description + '; errors=' + JSON.stringify(errors));
  };
  const waitAudible = async (after = nativeEvents.length) => waitFor((event) => event.type === 'masterMeter'
    && Math.max(Number(event.peakLeft) || 0, Number(event.peakRight) || 0) > 0.002,
    after, 'audible live VST Master', 5000);
  const waitQuiet = async () => {
    const after = nativeEvents.length;
    await sleep(600);
    const meters = nativeEvents.slice(after).filter((event) => event.type === 'masterMeter');
    assert(meters.length >= 2, 'no live VST silence meter evidence');
    const meter = meters.at(-1);
    assert(Math.max(Number(meter.peakLeft) || 0, Number(meter.peakRight) || 0) <= 0.0001,
      'live VST note is stuck: ' + JSON.stringify(meter));
    return meter;
  };

  const chainA = 'runtime-vst-a';
  const chainB = 'runtime-vst-b';
  const instanceA = 'runtime-vst-instance-a';
  const instanceB = 'runtime-vst-instance-b';
  const pluginId = ${JSON.stringify(runtimePlugin)};
  const filePath = ${JSON.stringify(exportPath)};
  let controller;
  try {
    const [{ EventBus }, { Graph }, { EngineClient }, { SequencerController }, { SequencerModel }]
      = await Promise.all([
        import('./js/core/eventBus.js'),
        import('./js/core/graph.js'),
        import('./js/core/engineClient.js'),
        import('./js/core/sequencerController.js'),
        import('./js/core/sequencerModel.js')
      ]);

    const settingsMap = new Map([['transportBpm', 120], ['vstCatalog', []]]);
    const settings = {
      get: (key) => settingsMap.get(key),
      set: (key, value) => { settingsMap.set(key, structuredClone(value)); }
    };
    const events = new EventBus();
    const trackedApi = {
      diagnosticsLog: () => {},
      engineCommand: (payload) => {
        if (payload?.type === 'midi') routedMidi.push({
          chainId: payload.chainId,
          data: [...(payload.data || [])],
          exportTransactionActive: engine?._exportTransactionActive === true,
          observedAt: Date.now()
        });
        return window.hubAPI.engineCommand(payload);
      }
    };
    engine = new EngineClient(trackedApi, events, settings);

    for (const target of [
      { chainId: chainA, instanceId: instanceA, requestId: 'runtime-load-a' },
      { chainId: chainB, instanceId: instanceB, requestId: 'runtime-load-b' }
    ]) {
      const after = nativeEvents.length;
      await command({ type: 'createInstance', pluginId, index: 0, ...target });
      const status = await waitFor((event) => event.type === 'instanceStatus'
        && event.chainId === target.chainId && event.instanceId === target.instanceId
        && ['ready', 'error'].includes(event.status), after, target.chainId + ' ready', 45000);
      assert(status.status === 'ready', target.chainId + ' failed to load: ' + JSON.stringify(status));
      await command({ type: 'setChainMidiEnabled', chainId: target.chainId, enabled: true });
      await command({ type: 'setChainOutputEnabled', chainId: target.chainId, enabled: true });
    }

    let after = nativeEvents.length;
    await command({ type: 'syncMidiGraph', nodes: [] });
    await waitFor((event) => event.type === 'midiGraphSynced', after, 'empty MIDI processor graph');
    after = nativeEvents.length;
    await command({ type: 'syncAudioGraph', nodes: [
      { id: chainA, nodeType: 'vst', inputs: [] },
      { id: chainB, nodeType: 'vst', inputs: [] },
      { id: 'runtime-vst-mixer', nodeType: 'mixer', masterLevel: 0.35, inputs: [
        { portId: 'audio-in-1', sourceNodeId: chainA, sourcePortId: 'audio-out', level: 0.5, muted: false },
        { portId: 'audio-in-2', sourceNodeId: chainB, sourcePortId: 'audio-out', level: 0.5, muted: false }
      ] },
      { id: 'audio-output', nodeType: 'audio-output', inputs: [
        { portId: 'audio-in', sourceNodeId: 'runtime-vst-mixer', sourcePortId: 'audio-out', level: 1, muted: false }
      ] }
    ] });
    await waitFor((event) => event.type === 'audioGraphSynced' && event.nodeCount === 4,
      after, 'two-VST audio graph');

    // Packaged gain-staging acceptance: hold one real hosted VST for 20 s,
    // then activate the second. Passive per-VST telemetry must prove that A's
    // output and static track coefficient are independent of B.
    const gainHoldStart = nativeEvents.length;
    await command({ type: 'midi', chainId: chainA, data: [0x90, 60, 127], offsetMs: 0 });
    await sleep(20500);
    const heldEvents = nativeEvents.slice(gainHoldStart);
    const heldMeters = heldEvents.filter((event) => event.type === 'masterMeter'
      && Number(event.peakLeft) > 0.1).slice(5);
    const heldA = heldEvents.filter((event) => event.type === 'audioPathTelemetry'
      && event.instanceId === instanceA).at(-1);
    const heldMixer = heldEvents.filter((event) => event.type === 'audioPathTelemetry'
      && event.nodeId === 'runtime-vst-mixer').at(-1);
    assert(heldMeters.length >= 100, '20-second VST hold did not produce continuous Master evidence');
    const heldPeaks = heldMeters.map((event) => Number(event.peakLeft));
    assert(Math.max(...heldPeaks) - Math.min(...heldPeaks) < 0.002,
      'single VST level pumped during 20-second hold: ' + JSON.stringify({
        minimum: Math.min(...heldPeaks), maximum: Math.max(...heldPeaks)
      }));
    assert(Number(heldA?.outputPeak) > 0.94 && heldA?.automaticGainReduction === false
      && Number(heldA?.gainReductionCoefficient) === 1,
      'Track A VST output was not passive/unity: ' + JSON.stringify(heldA));
    assert(sameGains(heldMixer?.inputGainCoefficients, [0.175, 0.175]),
      'static mixer coefficients are not the authored 0.5 x 0.35 values: ' + JSON.stringify(heldMixer));

    const secondStart = nativeEvents.length;
    await command({ type: 'midi', chainId: chainB, data: [0x90, 67, 127], offsetMs: 0 });
    await sleep(1500);
    const secondEvents = nativeEvents.slice(secondStart);
    const afterA = secondEvents.filter((event) => event.type === 'audioPathTelemetry'
      && event.instanceId === instanceA).at(-1);
    const afterB = secondEvents.filter((event) => event.type === 'audioPathTelemetry'
      && event.instanceId === instanceB).at(-1);
    const afterMixer = secondEvents.filter((event) => event.type === 'audioPathTelemetry'
      && event.nodeId === 'runtime-vst-mixer').at(-1);
    assert(Math.abs(Number(afterA?.outputPeak) - Number(heldA.outputPeak)) < 0.0001
      && Number(afterA?.gainCoefficient) === Number(heldA.gainCoefficient),
      'activating Track B changed Track A: ' + JSON.stringify({ before: heldA, after: afterA }));
    assert(Number(afterB?.outputPeak) > 0.94,
      'Track B did not become independently audible: ' + JSON.stringify(afterB));
    assert(sameGains(afterMixer?.inputGainCoefficients,
      heldMixer.inputGainCoefficients.map(Number)),
      'activating Track B changed an authored track coefficient');
    await command({ type: 'midi', chainId: chainA, data: [0x80, 60, 0], offsetMs: 0 });
    await command({ type: 'midi', chainId: chainB, data: [0x80, 67, 0], offsetMs: 0 });
    await waitQuiet();

    // Deliberate two-VST overload at unity. The explicit -60 dB Master keeps
    // hardware listening safe while pre-gain and Mixer telemetry must retain
    // the ~1.9 floating-point sum with GR fixed at unity.
    await command({ type: 'setMasterOutput', gainDb: -60 });
    after = nativeEvents.length;
    await command({ type: 'syncAudioGraph', nodes: [
      { id: chainA, nodeType: 'vst', inputs: [] },
      { id: chainB, nodeType: 'vst', inputs: [] },
      { id: 'runtime-vst-mixer', nodeType: 'mixer', masterLevel: 1, inputs: [
        { portId: 'audio-in-1', sourceNodeId: chainA, sourcePortId: 'audio-out', level: 1, muted: false },
        { portId: 'audio-in-2', sourceNodeId: chainB, sourcePortId: 'audio-out', level: 1, muted: false }
      ] },
      { id: 'audio-output', nodeType: 'audio-output', inputs: [
        { portId: 'audio-in', sourceNodeId: 'runtime-vst-mixer', sourcePortId: 'audio-out', level: 1, muted: false }
      ] }
    ] });
    await waitFor((event) => event.type === 'audioGraphSynced' && event.nodeCount === 4,
      after, 'unity overload audio graph');
    const overloadStart = nativeEvents.length;
    await command({ type: 'midi', chainId: chainA, data: [0x90, 60, 127], offsetMs: 0 });
    await command({ type: 'midi', chainId: chainB, data: [0x90, 60, 127], offsetMs: 0 });
    await sleep(1500);
    const overloadEvents = nativeEvents.slice(overloadStart);
    const overloadMeter = overloadEvents.filter((event) => event.type === 'masterMeter'
      && Number(event.preGainPeak) > 1.8).at(-1);
    const overloadMixer = overloadEvents.filter((event) => event.type === 'audioPathTelemetry'
      && event.nodeId === 'runtime-vst-mixer' && Number(event.outputPeak) > 1.8).at(-1);
    assert(overloadMeter && overloadMeter.automaticGainReduction === false
      && Number(overloadMeter.gainReductionCoefficient) === 1,
      'Master pre-gain did not preserve the deliberate float overload: ' + JSON.stringify(overloadMeter));
    assert(overloadMixer && Math.abs(Number(overloadMixer.inputPeak)-Number(overloadMixer.outputPeak)) < 0.0001
      && sameGains(overloadMixer.inputGainCoefficients, [1, 1]),
      'Mixer reduced or normalized the deliberate two-VST sum: ' + JSON.stringify(overloadMixer));
    await command({ type: 'midi', chainId: chainA, data: [0x80, 60, 0], offsetMs: 0 });
    await command({ type: 'midi', chainId: chainB, data: [0x80, 60, 0], offsetMs: 0 });
    await command({ type: 'setMasterOutput', gainDb: 0 });
    after = nativeEvents.length;
    await command({ type: 'syncAudioGraph', nodes: [
      { id: chainA, nodeType: 'vst', inputs: [] },
      { id: chainB, nodeType: 'vst', inputs: [] },
      { id: 'runtime-vst-mixer', nodeType: 'mixer', masterLevel: 0.35, inputs: [
        { portId: 'audio-in-1', sourceNodeId: chainA, sourcePortId: 'audio-out', level: 0.5, muted: false },
        { portId: 'audio-in-2', sourceNodeId: chainB, sourcePortId: 'audio-out', level: 0.5, muted: false }
      ] },
      { id: 'audio-output', nodeType: 'audio-output', inputs: [
        { portId: 'audio-in', sourceNodeId: 'runtime-vst-mixer', sourcePortId: 'audio-out', level: 1, muted: false }
      ] }
    ] });
    await waitFor((event) => event.type === 'audioGraphSynced' && event.nodeCount === 4,
      after, 'restored runtime audio graph');

    const graph = new Graph(events, settings);
    const midi = { selectedInputId: 'runtime-minilab-port', selectedOutputId: '', send: () => {}, getOutput: () => null };
    const hub = {
      events, settings, graph, engine, midi,
      api: { clipEditorInvalidate: async () => {}, clipEditorPublishTransport: async () => {} },
      project: { currentProjectName: 'Runtime routing', projectId: 'runtime-routing-project' }
    };
    controller = new SequencerController(hub);
    const vstInput = (chainId) => (portId, message) => {
      if (portId === 'midi-in') engine.midi(chainId, message.raw);
    };
    graph.addNode({ id: 'minilab-3', type: 'midi-input', outputs: [{ id: 'midi-out', type: 'midi' }] });
    graph.addNode({ id: 'sequencer', type: 'sequencer',
      inputs: [{ id: 'midi-in', type: 'midi' }], outputs: [{ id: 'midi-out', type: 'midi' }],
      onInput: (portId, message) => { if (portId === 'midi-in') controller.receiveMidiInput(message); } });
    graph.addNode({ id: chainA, type: 'vst', inputs: [{ id: 'midi-in', type: 'midi' }],
      outputs: [{ id: 'audio-out', type: 'audio' }], onInput: vstInput(chainA) });
    graph.addNode({ id: chainB, type: 'vst', inputs: [{ id: 'midi-in', type: 'midi' }],
      outputs: [{ id: 'audio-out', type: 'audio' }], onInput: vstInput(chainB) });
    graph.connect('minilab-3', 'midi-out', 'sequencer', 'midi-in');
    graph.connect('sequencer', 'midi-out', chainA, 'midi-in');
    graph.connect('sequencer', 'midi-out', chainB, 'midi-in');

    controller.model = new SequencerModel({
      focusedTrackId: 'track-vst-a',
      selectedClipId: 'clip-vst-a',
      selectedClipIds: ['clip-vst-a'],
      selectionAnchorClipId: 'clip-vst-a',
      loop: { enabled: true, startPpq: 0.25, endPpq: 1.75 },
      tracks: [
        { id: 'track-vst-a', name: 'VST A', type: 'midi', armed: true, monitored: false,
          muted: false, volume: 0.8, inputId: 'runtime-minilab-port', outputId: chainA, clips: [
            { id: 'clip-vst-a', name: 'A', startPpq: 0, lengthPpq: 2, notes: [
              { id: 'note-vst-a', pitch: 60, startPpq: 0, durationPpq: 1.5, velocity: 100, channel: 1 }
            ] }
          ] },
        { id: 'track-vst-b', name: 'VST B', type: 'midi', armed: false, monitored: false,
          muted: false, volume: 0.7, inputId: 'runtime-minilab-port', outputId: chainB, clips: [
            { id: 'clip-vst-b', name: 'B', startPpq: 0.5, lengthPpq: 1.5, notes: [
              { id: 'note-vst-b', pitch: 67, startPpq: 0, durationPpq: 1, velocity: 96, channel: 1 }
            ] }
          ] }
      ]
    });
    controller.tempo = 120;
    after = nativeEvents.length;
    controller.syncNative();
    await waitFor((event) => event.type === 'sequencerSynced' && event.trackCount === 2,
      after, 'renderer-routed two-track sequencer');
    assert(controller.model.arrangementEndPpq() === 2, 'true arrangement end is not 2 PPQ');

    const ingress = (data) => graph.emitData('minilab-3', 'midi-out', {
      raw: data, sourceId: 'runtime-minilab-port'
    });
    const routeStartA = routedMidi.length;
    controller.focusTrack('track-vst-a');
    ingress([0x90, 60, 100]);
    controller.focusTrack('track-vst-b');
    const focusA = routedMidi.slice(routeStartA);
    assert(focusA.some((entry) => entry.chainId === chainA && entry.data[0] === 0x90 && entry.data[1] === 60),
      'focus A did not route Note On to VST A');
    assert(focusA.some((entry) => entry.chainId === chainA && entry.data[0] === 0x80 && entry.data[1] === 60),
      'focus change did not deliver the exact Note Off to VST A');
    assert(!focusA.some((entry) => entry.chainId === chainB && entry.data[0] === 0x90 && entry.data[1] === 60),
      'exclusive focus leaked Note On to VST B');
    assert(focusA.some((entry) => entry.chainId === chainA && entry.data[1] === 123)
      && focusA.some((entry) => entry.chainId === chainA && entry.data[1] === 120),
      'focus cleanup omitted CC123/CC120');

    const routeStartB = routedMidi.length;
    ingress([0x90, 62, 100]); ingress([0x80, 62, 0]);
    const focusB = routedMidi.slice(routeStartB);
    assert(focusB.filter((entry) => entry.data[1] === 62).every((entry) => entry.chainId === chainB),
      'focus B did not route exclusively to VST B');

    controller.setTrackArmed('track-vst-a', true, { additive: true });
    const routeStartMulti = routedMidi.length;
    ingress([0x90, 64, 100]); ingress([0x80, 64, 0]);
    const multi = routedMidi.slice(routeStartMulti).filter((entry) => entry.data[1] === 64);
    assert([chainA, chainB].every((chainId) => multi.some((entry) => entry.chainId === chainId
      && entry.data[0] === 0x90) && multi.some((entry) => entry.chainId === chainId
      && entry.data[0] === 0x80)), 'intentional multi-arm did not reach both VST destinations');
    controller.focusTrack('track-vst-b');

    await engine.setTransport({ bpm: 120, seekPpq: 0.25, playing: false,
      loop: { enabled: true, startPpq: 0.25, endPpq: 1.75 } });
    await waitQuiet();
    after = nativeEvents.length;
    await engine.sequencerExport({ format: 'wav', bits: 24, filePath,
      startPpq: 0, endPpq: controller.model.arrangementEndPpq(), tailSeconds: 1.5 });
    const started = await waitFor((event) => event.type === 'sequencerExport' && event.state === 'started'
      && samePath(event.filePath, filePath), after, 'two-VST cloned export', 60000);
    assert(started.livePlaying === false && started.livePpqPosition === 0.25
      && started.liveLoopEnabled === true && started.offlineLoopEnabled === false,
      'two-VST export did not preserve the live transport: ' + JSON.stringify(started));
    assert(started.snapshot?.tracks?.length === 2 && started.snapshot.tracks.every((track) => track.clips.length === 1),
      'selected clip incorrectly limited the master export snapshot');
    assert(started.vstSnapshot?.length === 2,
      'two live VST chains were not cloned: ' + JSON.stringify(started.vstSnapshot));

    const duringStart = routedMidi.length;
    ingress([0x90, 74, 100]); ingress([0x80, 74, 0]);
    const during = routedMidi.slice(duringStart).filter((entry) => entry.data[1] === 74);
    assert(during.some((entry) => entry.data[0] === 0x90 && entry.exportTransactionActive)
      && during.some((entry) => entry.data[0] === 0x80 && entry.exportTransactionActive),
      'live Note On/Off was deferred or dropped during export');

    const heldStart = routedMidi.length;
    const heldMeterAfter = nativeEvents.length;
    ingress([0x90, 72, 100]);
    const audibleWhileExporting = await waitAudible(heldMeterAfter);
    const terminal = await waitFor((event) => event.type === 'sequencerExport'
      && samePath(event.filePath, filePath) && ['complete', 'error', 'cancelled'].includes(event.state),
      after, 'two-VST export completion', 15000);
    assert(terminal.state === 'complete', 'two-VST export failed: ' + JSON.stringify(terminal));
    assert(terminal.livePlaying === false && terminal.livePpqPosition === 0.25
      && terminal.liveLoopEnabled === true, 'two-VST export changed live transport at completion');
    const heldAfterTerminal = await waitAudible(nativeEvents.length);
    ingress([0x80, 72, 0]);
    const heldRoutes = routedMidi.slice(heldStart).filter((entry) => entry.data[1] === 72);
    assert(heldRoutes.some((entry) => entry.data[0] === 0x90)
      && heldRoutes.some((entry) => entry.data[0] === 0x80),
      'held live note lost its eventual Note Off across export completion');
    const quietAfterNoteOff = await waitQuiet();

    return {
      verdict: 'PASS',
      page: { title: document.title, url: location.href },
      pluginId,
      routing: {
        focusA: focusA.filter((entry) => entry.data[1] === 60 || entry.data[1] === 123 || entry.data[1] === 120).length,
        focusB: focusB.filter((entry) => entry.data[1] === 62).length,
        multiArmMessages: multi.length,
        duringExportMessages: during,
        heldRoutes
      },
      gainStaging: {
        heldSeconds: 20.5,
        heldPeakMinimum: Math.min(...heldPeaks),
        heldPeakMaximum: Math.max(...heldPeaks),
        trackABefore: heldA,
        trackAAfterTrackB: afterA,
        trackB: afterB,
        mixerBefore: heldMixer,
        mixerAfterTrackB: afterMixer,
        overloadMeter,
        overloadMixer
      },
      export: { filePath, started, terminal, audibleWhileExporting, heldAfterTerminal, quietAfterNoteOff },
      engineErrors: nativeEvents.filter((event) => event.type === 'error')
    };
  } finally {
    try { controller?._panicLiveDestinations(); } catch {}
    try {
      if (engine?._exportTransactionActive) await engine.sequencerCancelExport();
    } catch {}
    try { await command({ type: 'sequencerPanic' }); } catch {}
    try { await command({ type: 'setTransport', playing: false }); } catch {}
    try { await command({ type: 'removeInstance', chainId: chainA, instanceId: instanceA }); } catch {}
    try { await command({ type: 'removeInstance', chainId: chainB, instanceId: instanceB }); } catch {}
    nativeOff();
  }
})()`;

const evaluation = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
socket.close();
if (evaluation.exceptionDetails) {
  throw new Error(evaluation.exceptionDetails.exception?.description || evaluation.exceptionDetails.text);
}
const result = evaluation.result?.value;
if (result?.verdict === 'PASS') {
  const stat = fs.statSync(result.export.filePath);
  const header = Buffer.alloc(12);
  const descriptor = fs.openSync(result.export.filePath, 'r');
  try { fs.readSync(descriptor, header, 0, header.length, 0); } finally { fs.closeSync(descriptor); }
  if (stat.size <= 1024 || header.subarray(0, 4).toString('ascii') !== 'RIFF'
      || header.subarray(8, 12).toString('ascii') !== 'WAVE') {
    throw new Error(`invalid two-VST runtime WAV artifact (${stat.size} bytes, ${header.toString('hex')})`);
  }
  result.artifactEvidence = { bytes: stat.size, headerHex: header.toString('hex') };
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result?.verdict !== 'PASS') process.exitCode = 1;
