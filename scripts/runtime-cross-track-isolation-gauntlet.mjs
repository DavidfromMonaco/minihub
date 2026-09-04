const [port = '9497', dexed = '', vital = ''] = process.argv.slice(2);
if (!dexed || !vital) throw new Error('Usage: runtime-cross-track-isolation-gauntlet.mjs <port> <dexed-vst3> <vital-vst3>');

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
let targets;
for (let attempt = 0; attempt < 150; attempt += 1) {
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
  const request = pending.get(message.id); pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error.message));
  else request.resolve(message.result);
});
const send = (method, params = {}) => {
  const id = ++sequence; socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
};

await send('Runtime.enable');
const expression = `(async () => {
  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const events = []; let observedPpq = null; let playbackStartedAt = 0;
  const off = window.hubAPI.onEngineEvent((event) => {
    if (event.type === 'hostTiming' && Number.isFinite(Number(event.ppqPosition))) observedPpq = Number(event.ppqPosition);
    const observedAt = Date.now();
    events.push({ ...event, observedPpq, observedAt,
      playbackElapsedMs: playbackStartedAt ? observedAt - playbackStartedAt : null });
  });
  const command = async (payload) => {
    const result = await window.hubAPI.engineCommand({ v: 1, ...payload });
    assert(result?.ok === true, payload.type + ' rejected: ' + JSON.stringify(result));
    return result;
  };
  const waitFor = async (predicate, after, description, timeout = 45000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const found = events.slice(after).find(predicate); if (found) return found;
      await sleep(10);
    }
    throw new Error('timeout waiting for ' + description + '; errors=' + JSON.stringify(events.slice(after).filter((event) => event.type === 'error')));
  };
  const plugins = [
    { name: 'Dexed', chainId: 'isolation-track-1-vst', instanceId: 'isolation-track-1-instance', path: ${JSON.stringify(dexed.replaceAll('\\', '/'))} },
    { name: 'Vital', chainId: 'isolation-track-2-vst', instanceId: 'isolation-track-2-instance', path: ${JSON.stringify(vital.replaceAll('\\', '/'))} }
  ];
  try {
    const state = await window.hubAPI.engineState();
    assert(state?.state === 'running', 'Engine 2 is not running: ' + JSON.stringify(state));
    for (const plugin of plugins) {
      const after = events.length;
      await command({ type: 'createInstance', requestId: 'isolation-load-' + plugin.name,
        chainId: plugin.chainId, instanceId: plugin.instanceId, pluginId: plugin.path, index: 0 });
      const ready = await waitFor((event) => event.type === 'instanceStatus'
        && event.chainId === plugin.chainId && event.instanceId === plugin.instanceId
        && ['ready', 'error'].includes(event.status), after, plugin.name + ' ready');
      assert(ready.status === 'ready', plugin.name + ' failed: ' + JSON.stringify(ready));
      await command({ type: 'setChainMidiEnabled', chainId: plugin.chainId, enabled: true });
      await command({ type: 'setChainOutputEnabled', chainId: plugin.chainId, enabled: true });
    }
    let after = events.length;
    await command({ type: 'syncAudioNetwork', nodes: [
      { id: plugins[0].chainId, nodeType: 'vst', inputs: [] },
      { id: plugins[1].chainId, nodeType: 'vst', inputs: [] },
      { id: 'isolation-mixer', nodeType: 'mixer', masterLevel: 1, inputs: [
        { portId: 'audio-in-1', sourceNodeId: plugins[0].chainId, sourcePortId: 'audio-out', level: 1, muted: false },
        { portId: 'audio-in-2', sourceNodeId: plugins[1].chainId, sourcePortId: 'audio-out', level: 1, muted: false }
      ] },
      { id: 'audio-output', nodeType: 'audio-output', inputs: [
        { portId: 'audio-in', sourceNodeId: 'isolation-mixer', sourcePortId: 'audio-out', level: 1, muted: false }
      ] }
    ] });
    await waitFor((event) => event.type === 'audioNetworkSynced' && event.nodeCount === 4, after, 'isolation audio network');
    after = events.length;
    await command({ type: 'syncSequencer', project: { tracks: [
      { id: 'track-1', type: 'midi', armed: false, muted: false, volume: 0.7,
        inputId: '', outputId: plugins[0].chainId, clips: [{ id: 'clip-track-1', startPpq: 6, lengthPpq: 4,
          notes: [{ id: 'note-track-1', pitch: 69, startPpq: 0, durationPpq: 4, velocity: 127, channel: 1 }] }] },
      { id: 'track-2', type: 'midi', armed: false, muted: false, volume: 0.8,
        inputId: '', outputId: plugins[1].chainId, clips: [{ id: 'clip-track-2', startPpq: 0, lengthPpq: 14,
          notes: [{ id: 'note-track-2', pitch: 81, startPpq: 0, durationPpq: 14, velocity: 127, channel: 1 }] }] }
    ] } });
    await waitFor((event) => event.type === 'sequencerSynced' && event.trackCount === 2, after, 'two delayed tracks');
    const playbackStart = events.length; playbackStartedAt = Date.now();
    await command({ type: 'setTransport', bpm: 120, seekPpq: 0, playing: true,
      loop: { enabled: false, startPpq: 0, endPpq: 14 } });
    await sleep(7300);
    await command({ type: 'setTransport', playing: false });
    await sleep(250);
    const playback = events.slice(playbackStart);
    const inPhase = (event, low, high) => Number(event.playbackElapsedMs) >= low && Number(event.playbackElapsedMs) <= high;
    const phases = [[500, 2500], [3500, 4500], [5500, 6800]].map(([low, high]) => ({
      track1: playback.filter((event) => event.type === 'audioPathTelemetry' && event.scope === 'sequencer-track' && event.trackId === 'track-1' && inPhase(event, low, high)),
      track2: playback.filter((event) => event.type === 'audioPathTelemetry' && event.scope === 'sequencer-track' && event.trackId === 'track-2' && inPhase(event, low, high)),
      vst2: playback.filter((event) => event.type === 'audioPathTelemetry' && event.scope === 'vst' && event.nodeId === plugins[1].chainId && inPhase(event, low, high)),
      mixer: playback.filter((event) => event.type === 'audioPathTelemetry' && event.scope === 'network' && event.nodeId === 'isolation-mixer' && inPhase(event, low, high)),
      master: playback.filter((event) => event.type === 'masterMeter' && inPhase(event, low, high))
    }));
    assert(phases.every((phase) => phase.track1.length && phase.track2.length && phase.vst2.length && phase.mixer.length && phase.master.length),
      'missing before/during/after probes: ' + JSON.stringify(phases.map((phase) => Object.fromEntries(Object.entries(phase).map(([key, value]) => [key, value.length])))));
    assert(phases[0].track1.every((event) => event.activeClips === 0) && phases[1].track1.some((event) => event.activeClips === 1) && phases[2].track1.every((event) => event.activeClips === 0), 'Track 1 activation window is wrong');
    assert(phases.every((phase) => phase.track2.every((event) => event.activeClips === 1 && Math.abs(Number(event.gainCoefficient) - 0.8) < 1e-6 && event.destinationBuffer === plugins[1].chainId + ':audio-in')), 'Track 2 identity or DSP gain changed');
    const summarize = (phase) => ({
      track1ActiveClips: [...new Set(phase.track1.map((event) => event.activeClips))],
      track2ActiveClips: [...new Set(phase.track2.map((event) => event.activeClips))],
      track2Gain: [...new Set(phase.track2.map((event) => event.gainCoefficient))],
      track2PostGainPeaks: phase.track2.map((event) => event.peakAfterGain),
      vst2OutputPeaks: phase.vst2.map((event) => event.outputPeak),
      mixerOutputPeaks: phase.mixer.map((event) => event.outputPeak),
      masterPeaks: phase.master.map((event) => Math.max(Number(event.peakLeft) || 0, Number(event.peakRight) || 0))
    });
    return { verdict: 'READY FOR USER TEST', executable: location.href, plugins,
      phases: { before: summarize(phases[0]), during: summarize(phases[1]), after: summarize(phases[2]) },
      engineErrors: playback.filter((event) => event.type === 'error') };
  } finally {
    try { await command({ type: 'setTransport', playing: false }); } catch {}
    try { await command({ type: 'sequencerPanic' }); } catch {}
    for (const plugin of plugins) try { await command({ type: 'removeInstance', chainId: plugin.chainId, instanceId: plugin.instanceId }); } catch {}
    off();
  }
})()`;

const evaluation = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
if (evaluation.exceptionDetails) throw new Error(evaluation.exceptionDetails.exception?.description || evaluation.exceptionDetails.text);
const result = evaluation.result?.value;
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result?.verdict !== 'READY FOR USER TEST' || result.engineErrors?.length) process.exitCode = 1;
socket.send(JSON.stringify({ id: ++sequence, method: 'Browser.close' }));
await sleep(250);
socket.close();
