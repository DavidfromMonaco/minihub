import fs from 'node:fs';
import path from 'node:path';

const [port = '9471', artifactPath = '', dexedPath = '', vitalPath = ''] = process.argv.slice(2);
if (!artifactPath || !dexedPath || !vitalPath) {
  throw new Error('Usage: runtime-realtime-output-gauntlet.mjs <port> <artifact-json> <dexed.vst3> <vital.vst3>');
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
let targets;
for (let attempt = 0; attempt < 120; attempt += 1) {
  try {
    targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
    if (targets.some((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl
      && /\/index\.html(?:$|[?#])/.test(entry.url || ''))) break;
  } catch {}
  await sleep(100);
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
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data));
  if (!message.id || !pending.has(message.id)) return;
  const request = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error.message));
  else request.resolve(message.result);
});
const send = (method, params = {}) => {
  const id = ++sequence;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
};

await send('Runtime.enable');
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
  const waitFor = async (predicate, after, description, timeout = 15000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const found = events.slice(after).find(predicate);
      if (found) return found;
      await sleep(10);
    }
    throw new Error('timeout waiting for ' + description + '; errors='
      + JSON.stringify(events.slice(after).filter((event) => event.type === 'error')));
  };
  const lastRuntimeAfter = async (after, predicate = () => true) => {
    await waitFor((event) => event.type === 'audioRuntimeTelemetry' && predicate(event),
      after, 'PortAudio runtime telemetry');
    await sleep(1100);
    return events.slice(after).filter((event) => event.type === 'audioRuntimeTelemetry'
      && predicate(event)).at(-1);
  };
  const nonFinite = (runtime) => Number(runtime?.portAudioNonFiniteSamples) || 0;
  const xruns = (runtime) => (Number(runtime?.paOutputUnderflows) || 0)
    + (Number(runtime?.paOutputOverflows) || 0);
  const loadPlugin = async (chainId, instanceId, pluginId) => {
    let after = events.length;
    await command({ type: 'createInstance', requestId: 'load-' + instanceId,
      chainId, instanceId, pluginId, index: 0 });
    const status = await waitFor((event) => event.type === 'instanceStatus'
      && event.chainId === chainId && event.instanceId === instanceId
      && ['ready', 'error'].includes(event.status), after, instanceId + ' ready', 60000);
    assert(status.status === 'ready', instanceId + ' load failed: ' + JSON.stringify(status));
    await command({ type: 'setChainMidiEnabled', chainId, enabled: true });
    await command({ type: 'setChainOutputEnabled', chainId, enabled: true });
  };
  const networkFor = async (chains) => {
    const after = events.length;
    const nodes = chains.map((chainId) => ({ id: chainId, nodeType: 'vst', inputs: [] }));
    if (chains.length === 1) {
      nodes.push({ id: 'audio-output', nodeType: 'audio-output', inputs: [{ portId: 'audio-in',
        sourceNodeId: chains[0], sourcePortId: 'audio-out', level: 1, muted: false }] });
    } else {
      nodes.push({ id: 'realtime-output-mixer', nodeType: 'mixer', masterLevel: 0.5,
        inputs: chains.map((chainId, index) => ({ portId: 'audio-in-' + (index + 1),
          sourceNodeId: chainId, sourcePortId: 'audio-out', level: 0.5, muted: false })) });
      nodes.push({ id: 'audio-output', nodeType: 'audio-output', inputs: [{ portId: 'audio-in',
        sourceNodeId: 'realtime-output-mixer', sourcePortId: 'audio-out', level: 1, muted: false }] });
    }
    await command({ type: 'syncAudioNetwork', nodes });
    await waitFor((event) => event.type === 'audioNetworkSynced' && event.nodeCount === nodes.length,
      after, 'audio network ' + chains.join('+'));
  };
  const exercisePlugins = async (name, chains, notes) => {
    await networkFor(chains);
    const beforeRuntime = events.filter((event) => event.type === 'audioRuntimeTelemetry').at(-1);
    const after = events.length;
    for (let index = 0; index < chains.length; index += 1)
      await command({ type: 'midi', chainId: chains[index], data: [0x90, notes[index], 100], offsetMs: 0 });
    const meter = await waitFor((event) => event.type === 'masterMeter'
      && Math.max(Number(event.peakLeft) || 0, Number(event.peakRight) || 0) > 0.0001,
      after, name + ' audible Master', 10000);
    const runtime = await lastRuntimeAfter(after,
      (event) => Number(event.portAudioLastCopiedPeak) > 0.00001);
    for (let index = 0; index < chains.length; index += 1)
      await command({ type: 'midi', chainId: chains[index], data: [0x80, notes[index], 0], offsetMs: 0 });
    await command({ type: 'sequencerPanic' });
    assert(nonFinite(runtime) === 0, name + ' emitted non-finite output: ' + JSON.stringify(runtime));
    return {
      name,
      masterPeak: Math.max(Number(meter.peakLeft) || 0, Number(meter.peakRight) || 0),
      copiedPeak: Number(runtime.portAudioLastCopiedPeak),
      maximumCopiedPeak: Number(runtime.portAudioMaximumCopiedPeak),
      outputUnderflowDelta: (Number(runtime.paOutputUnderflows) || 0)
        - (Number(beforeRuntime?.paOutputUnderflows) || 0),
      outputOverflowDelta: (Number(runtime.paOutputOverflows) || 0)
        - (Number(beforeRuntime?.paOutputOverflows) || 0),
      nonFiniteSamples: nonFinite(runtime),
      callbackMilliseconds: Number(runtime.portAudioCallbackMilliseconds),
      maximumCallbackMilliseconds: Number(runtime.maximumPortAudioCallbackMilliseconds),
      deadlineMisses: Number(runtime.portAudioDeadlineMisses) || 0
    };
  };

  try {
    const state = await window.hubAPI.engineState();
    assert(state?.state === 'running', 'Engine 2 is not running: ' + JSON.stringify(state));
    let after = events.length;
    await command({ type: 'getDeviceState' });
    const initialDevice = await waitFor((event) => event.type === 'deviceState' && event.running,
      after, 'initial device state');
    const device = initialDevice.device;
    const sampleRate = Number(initialDevice.sampleRate);
    assert(initialDevice.portAudioSampleFormat === 'paFloat32'
      && initialDevice.outputChannels === 2 && initialDevice.outputInterleaved === true
      && initialDevice.outputSampleBytes === 4,
    'wrong PortAudio contract: ' + JSON.stringify(initialDevice));

    const buffers = [];
    for (const bufferSize of [128, 256, 512, 1024]) {
      const baseline = events.filter((event) => event.type === 'audioRuntimeTelemetry').at(-1);
      after = events.length;
      await command({ type: 'selectDevice', device: { name: device }, sampleRate, bufferSize });
      await waitFor((event) => event.type === 'deviceState' && event.running
        && Number(event.bufferSize) === bufferSize, after, 'device buffer ' + bufferSize);
      const runtime = await lastRuntimeAfter(after,
        (event) => Number(event.portAudioCallbackFrames) === bufferSize);
      assert(runtime.portAudioFormat === 'paFloat32'
        && runtime.portAudioOutputChannels === 2 && runtime.portAudioOutputInterleaved === true,
      'runtime PortAudio format mismatch at ' + bufferSize);
      assert(nonFinite(runtime) === 0,
        'non-finite PortAudio output at ' + bufferSize + ': ' + JSON.stringify(runtime));
      assert(Number(runtime.portAudioCallbackId) >= Number(runtime.portAudioOutputWriteId)
        && Number(runtime.audioNetworkProcessId) >= Number(runtime.portAudioOutputWriteId)
        && Number(runtime.masterOutputProcessId) >= Number(runtime.portAudioOutputWriteId),
      'callback/network/Master/write sequence invariant failed: ' + JSON.stringify(runtime));
      buffers.push({
        requestedFrames: bufferSize,
        actualFrames: Number(runtime.portAudioCallbackFrames),
        callbackId: Number(runtime.portAudioCallbackId),
        audioNetworkProcessId: Number(runtime.audioNetworkProcessId),
        masterOutputProcessId: Number(runtime.masterOutputProcessId),
        outputWriteId: Number(runtime.portAudioOutputWriteId),
        outputUnderflowDelta: (Number(runtime.paOutputUnderflows) || 0)
          - (Number(baseline?.paOutputUnderflows) || 0),
        outputOverflowDelta: (Number(runtime.paOutputOverflows) || 0)
          - (Number(baseline?.paOutputOverflows) || 0),
        nonFiniteSamples: nonFinite(runtime),
        callbackMilliseconds: Number(runtime.portAudioCallbackMilliseconds),
        maximumCallbackMilliseconds: Number(runtime.maximumPortAudioCallbackMilliseconds),
        deadlineMisses: Number(runtime.portAudioDeadlineMisses) || 0
      });
    }

    after = events.length;
    await command({ type: 'selectDevice', device: { name: device }, sampleRate, bufferSize: 256 });
    await waitFor((event) => event.type === 'deviceState' && event.running
      && Number(event.bufferSize) === 256, after, 'restore 256 frames');
    await loadPlugin('realtime-dexed', 'plugin-9101', ${JSON.stringify(path.resolve(dexedPath).replaceAll('\\', '/'))});
    await loadPlugin('realtime-vital', 'plugin-9102', ${JSON.stringify(path.resolve(vitalPath).replaceAll('\\', '/'))});
    const plugins = [];
    plugins.push(await exercisePlugins('Dexed', ['realtime-dexed'], [60]));
    plugins.push(await exercisePlugins('Vital', ['realtime-vital'], [67]));
    plugins.push(await exercisePlugins('Dexed + Vital', ['realtime-dexed', 'realtime-vital'], [60, 67]));

    return { verdict: 'PASS', device, sampleRate, format: 'paFloat32 stereo interleaved',
      sampleBytes: 4, buffers, plugins,
      finalRuntime: events.filter((event) => event.type === 'audioRuntimeTelemetry').at(-1),
      engineErrors: events.filter((event) => event.type === 'error') };
  } finally {
    try { await command({ type: 'sequencerPanic' }); } catch {}
    off();
  }
})()`;

const evaluation = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
socket.close();
if (evaluation.exceptionDetails) {
  throw new Error(evaluation.exceptionDetails.exception?.description || evaluation.exceptionDetails.text);
}
const result = evaluation.result?.value;
const resolvedArtifact = path.resolve(artifactPath);
fs.mkdirSync(path.dirname(resolvedArtifact), { recursive: true });
fs.writeFileSync(resolvedArtifact, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result?.verdict !== 'PASS') process.exitCode = 1;
