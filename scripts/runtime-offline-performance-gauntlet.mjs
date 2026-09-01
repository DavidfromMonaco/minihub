import fs from 'node:fs';

const [port = '9462', artifactDirectory = '', instrumentPath = '', effectPath = '', capturePause = '0'] = process.argv.slice(2);
if (!artifactDirectory || !instrumentPath || !effectPath) {
  throw new Error('Usage: runtime-offline-performance-gauntlet.mjs <port> <artifact-directory> <instrument-vst3> <effect-vst3>');
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
let targets;
for (let attempt = 0; attempt < 120; attempt += 1) {
  try {
    targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
    if (targets.some((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl
      && /\/index\.html(?:$|[?#])/.test(entry.url || ''))) break;
  } catch {}
  await sleep(125);
}

const target = targets?.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl
  && /\/index\.html(?:$|[?#])/.test(entry.url || ''));
if (!target) throw new Error(`No MiniHub renderer target on CDP port ${port}`);

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

let sequence = 0;
const pending = new Map();
socket.addEventListener('message', (messageEvent) => {
  const message = JSON.parse(String(messageEvent.data));
  if (message.method === 'Runtime.consoleAPICalled') {
    const marker = message.params?.args?.map((entry) => entry.value).find((value) =>
      typeof value === 'string' && value.startsWith('__MLH_OFFLINE_'));
    if (marker) process.stdout.write(`${marker}\n`);
    return;
  }
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
const root = artifactDirectory.replaceAll('\\', '/');
const instrument = instrumentPath.replaceAll('\\', '/');
const effect = effectPath.replaceAll('\\', '/');
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
const capturePauseMs = Math.max(0, Math.min(10000, Number(capturePause) || 0));

const expression = `(async () => {
  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const events = [];
  const off = window.hubAPI.onEngineEvent((event) => events.push({ ...event, observedAt: Date.now() }));
  const command = async (payload) => {
    const result = await window.hubAPI.engineCommand({ v: 1, ...payload });
    assert(result?.ok === true, payload.type + ' rejected: ' + JSON.stringify(result));
    return result;
  };
  const waitFor = async (predicate, after, description, timeout = 60000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const match = events.slice(after).find(predicate);
      if (match) return match;
      await sleep(10);
    }
    throw new Error('timeout waiting for ' + description + '; errors='
      + JSON.stringify(events.slice(after).filter((event) => event.type === 'error')));
  };
  const samePath = (left, right) => String(left).replaceAll(String.fromCharCode(92), '/').toLowerCase()
    === String(right).replaceAll(String.fromCharCode(92), '/').toLowerCase();
  const loaded = [];

  const loadChain = async (chainId, index) => {
    for (const plugin of [
      { pluginId: ${JSON.stringify(instrument)}, instanceId: chainId + '-instrument', slot: 0 },
      { pluginId: ${JSON.stringify(effect)}, instanceId: chainId + '-effect', slot: 1 }
    ]) {
      const after = events.length;
      await command({ type: 'createInstance', chainId, pluginId: plugin.pluginId,
        instanceId: plugin.instanceId, requestId: 'perf-' + index + '-' + plugin.slot, index: plugin.slot });
      const status = await waitFor((event) => event.type === 'instanceStatus'
        && event.chainId === chainId && event.instanceId === plugin.instanceId
        && ['ready', 'error'].includes(event.status), after, plugin.instanceId, 45000);
      assert(status.status === 'ready', plugin.instanceId + ' failed: ' + JSON.stringify(status));
      loaded.push({ chainId, instanceId: plugin.instanceId });
    }
    await command({ type: 'setChainMidiEnabled', chainId, enabled: true });
    await command({ type: 'setChainOutputEnabled', chainId, enabled: true });
  };

  const clearScenario = async () => {
    let after = events.length;
    await command({ type: 'syncSequencer', project: { tracks: [] } });
    await waitFor((event) => event.type === 'sequencerSynced' && event.trackCount === 0,
      after, 'empty sequencer');
    after = events.length;
    await command({ type: 'syncAudioGraph', nodes: [
      { id: 'audio-output', nodeType: 'audio-output', inputs: [] }
    ] });
    await waitFor((event) => event.type === 'audioGraphSynced', after, 'empty audio graph');
    for (const plugin of loaded.splice(0).reverse()) {
      await command({ type: 'removeInstance', ...plugin });
    }
  };

  const runScenario = async ({ name, trackCount, endPpq, format }) => {
    const chains = Array.from({ length: trackCount }, (_, index) => 'perf-' + name + '-chain-' + index);
    for (let index = 0; index < chains.length; index += 1) await loadChain(chains[index], index);

    let after = events.length;
    await command({ type: 'syncAudioGraph', nodes: [
      ...chains.map((id) => ({ id, nodeType: 'vst', inputs: [] })),
      { id: 'perf-' + name + '-mixer', nodeType: 'mixer', masterLevel: 0.35,
        inputs: chains.map((sourceNodeId, index) => ({ portId: 'audio-in-' + (index + 1),
          sourceNodeId, sourcePortId: 'audio-out', level: 0.5, muted: false })) },
      { id: 'audio-output', nodeType: 'audio-output', inputs: [
        { portId: 'audio-in', sourceNodeId: 'perf-' + name + '-mixer',
          sourcePortId: 'audio-out', level: 1, muted: false }
      ] }
    ] });
    await waitFor((event) => event.type === 'audioGraphSynced'
      && event.nodeCount === trackCount + 2, after, name + ' audio graph');

    const tracks = chains.map((outputId, index) => ({
      id: 'perf-' + name + '-track-' + index,
      type: 'midi', armed: index % 2 === 0, monitored: false, muted: false,
      volume: 0.7, inputId: '', outputId,
      clips: [{ id: 'perf-' + name + '-clip-' + index, startPpq: 0, lengthPpq: endPpq,
        notes: [
          { id: 'start-' + index, pitch: 48 + index, startPpq: index * 0.125,
            durationPpq: endPpq - 1, velocity: 92, channel: 1 },
          { id: 'end-' + index, pitch: 72 - index, startPpq: endPpq - 0.75,
            durationPpq: 0.5, velocity: 84, channel: 1 }
        ] }]
    }));
    after = events.length;
    await command({ type: 'syncSequencer', project: { tracks } });
    await waitFor((event) => event.type === 'sequencerSynced' && event.trackCount === trackCount,
      after, name + ' sequencer');
    await command({ type: 'setTransport', bpm: 120, seekPpq: 0.5, playing: false,
      loop: { enabled: true, startPpq: 0.5, endPpq: 2 } });

    if (name.startsWith('medium') && ${capturePauseMs} > 0) {
      console.info('__MLH_OFFLINE_CAPTURE_READY__:${stamp}:' + name);
      await sleep(${capturePauseMs});
    }
    const filePath = ${JSON.stringify(root)} + '/offline-' + name + '-${stamp}.' + format;
    after = events.length;
    await command({ type: 'sequencerExport', filePath, format,
      ...(format === 'wav' ? { bits: 24 } : { qualityIndex: 7 }),
      startPpq: 0, endPpq, tailSeconds: 0 });
    const started = await waitFor((event) => event.type === 'sequencerExport'
      && event.state === 'started' && samePath(event.filePath, filePath), after, name + ' started');
    assert(started.renderThread === 'offline-worker' && started.deviceIndependent === true
      && started.hardwareOutput === false, name + ' is not a device-independent worker bounce');
    assert(started.snapshot?.tracks?.length === trackCount,
      name + ' snapshot track mismatch: ' + JSON.stringify(started.snapshot));
    assert(started.vstSnapshot?.length === trackCount * 2
      && new Set(started.vstSnapshot.map((entry) => entry.chainId)).size === trackCount,
      name + ' VST/FX clone mismatch: ' + JSON.stringify(started.vstSnapshot));
    console.info('__MLH_OFFLINE_STARTED__:${stamp}:' + name);

    const liveAfter = events.length;
    await command({ type: 'midi', chainId: chains[0], data: [0x90, 79, 100], offsetMs: 0 });
    const liveMeter = await waitFor((event) => event.type === 'masterMeter'
      && Math.max(Number(event.peakLeft) || 0, Number(event.peakRight) || 0) > 0.001,
      liveAfter, name + ' live audio during export', 5000);
    await command({ type: 'midi', chainId: chains[0], data: [0x80, 79, 0], offsetMs: 0 });

    const terminal = await waitFor((event) => event.type === 'sequencerExport'
      && samePath(event.filePath, filePath) && ['complete', 'error', 'cancelled'].includes(event.state),
      after, name + ' completion', 120000);
    assert(terminal.state === 'complete', name + ' failed: ' + JSON.stringify(terminal));
    assert(Number(terminal.realtimeSpeed) > 2,
      name + ' did not exceed 2x realtime: ' + JSON.stringify(terminal));
    assert(terminal.livePlaying === false && Math.abs(Number(terminal.livePpqPosition) - 0.5) < 0.0001,
      name + ' changed the live transport: ' + JSON.stringify(terminal));
    console.info('__MLH_OFFLINE_COMPLETE__:${stamp}:' + name + ':' + terminal.realtimeSpeed);
    await clearScenario();
    return { name, trackCount, vstInstruments: trackCount, vstEffects: trackCount,
      endPpq, format, filePath, started, terminal, liveMeter };
  };

  try {
    const state = await window.hubAPI.engineState();
    assert(state?.state === 'running', 'packaged engine not running: ' + JSON.stringify(state));
    const light = await runScenario({ name: 'light-2vst-2fx', trackCount: 2, endPpq: 230, format: 'wav' });
    const medium = await runScenario({ name: 'medium-6vst-6fx', trackCount: 6, endPpq: 240, format: 'ogg' });
    return { verdict: 'PASS', state, light, medium,
      engineErrors: events.filter((event) => event.type === 'error') };
  } finally {
    try { await command({ type: 'sequencerCancelExport' }); } catch {}
    try { await command({ type: 'sequencerPanic' }); } catch {}
    try { await command({ type: 'setTransport', playing: false }); } catch {}
    try { await clearScenario(); } catch {}
    off();
  }
})()`;

const evaluation = await send('Runtime.evaluate', {
  expression, awaitPromise: true, returnByValue: true
});
socket.close();
if (evaluation.exceptionDetails) {
  throw new Error(evaluation.exceptionDetails.exception?.description || evaluation.exceptionDetails.text);
}
const result = evaluation.result?.value;
for (const scenario of [result?.light, result?.medium].filter(Boolean)) {
  const stat = fs.statSync(scenario.filePath);
  const handle = fs.openSync(scenario.filePath, 'r');
  const header = Buffer.alloc(12);
  try { fs.readSync(handle, header, 0, header.length, 0); } finally { fs.closeSync(handle); }
  const valid = scenario.format === 'wav'
    ? header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WAVE'
    : header.subarray(0, 4).toString('ascii') === 'OggS';
  if (!valid || stat.size <= 1024) throw new Error(`invalid ${scenario.format} artifact for ${scenario.name}`);
  scenario.artifactEvidence = { bytes: stat.size, headerHex: header.toString('hex') };
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result?.verdict !== 'PASS') process.exitCode = 1;
