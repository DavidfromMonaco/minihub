const [port = '9471', dexed = '', vital = ''] = process.argv.slice(2);
if (!dexed || !vital) {
  throw new Error('Usage: runtime-vst-stop-gauntlet.mjs <port> <dexed-vst3> <vital-vst3>');
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
let targets;
for (let attempt = 0; attempt < 100; attempt += 1) {
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
  const waitFor = async (predicate, after, description, timeout = 45000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const found = events.slice(after).find(predicate);
      if (found) return found;
      await sleep(10);
    }
    throw new Error('timeout waiting for ' + description + '; errors='
      + JSON.stringify(events.slice(after).filter((event) => event.type === 'error')));
  };
  const plugins = [
    { name: 'Dexed', chainId: 'stop-dexed', instanceId: 'stop-dexed-instance',
      path: ${JSON.stringify(dexed.replaceAll('\\', '/'))} },
    { name: 'Vital', chainId: 'stop-vital', instanceId: 'stop-vital-instance',
      path: ${JSON.stringify(vital.replaceAll('\\', '/'))} }
  ];
  try {
    const state = await window.hubAPI.engineState();
    assert(state?.state === 'running', 'Engine 2 is not running: ' + JSON.stringify(state));
    for (const plugin of plugins) {
      const after = events.length;
      await command({ type: 'createInstance', requestId: 'stop-load-' + plugin.name,
        chainId: plugin.chainId, instanceId: plugin.instanceId, pluginId: plugin.path, index: 0 });
      const ready = await waitFor((event) => event.type === 'instanceStatus'
        && event.chainId === plugin.chainId && event.instanceId === plugin.instanceId
        && ['ready', 'error'].includes(event.status), after, plugin.name + ' ready');
      assert(ready.status === 'ready', plugin.name + ' failed to load: ' + JSON.stringify(ready));
      await command({ type: 'setChainMidiEnabled', chainId: plugin.chainId, enabled: true });
      await command({ type: 'setChainOutputEnabled', chainId: plugin.chainId, enabled: true });
    }

    let after = events.length;
    await command({ type: 'syncMidiNetwork', nodes: [] });
    await waitFor((event) => event.type === 'midiNetworkSynced', after, 'empty MIDI network');
    after = events.length;
    await command({ type: 'syncAudioNetwork', nodes: [
      { id: 'stop-dexed', nodeType: 'vst', inputs: [] },
      { id: 'stop-vital', nodeType: 'vst', inputs: [] },
      { id: 'stop-mixer', nodeType: 'mixer', masterLevel: 0.25, inputs: [
        { portId: 'audio-in-1', sourceNodeId: 'stop-dexed', sourcePortId: 'audio-out', level: 0.5, muted: false },
        { portId: 'audio-in-2', sourceNodeId: 'stop-vital', sourcePortId: 'audio-out', level: 0.5, muted: false }
      ] },
      { id: 'audio-output', nodeType: 'audio-output', inputs: [
        { portId: 'audio-in', sourceNodeId: 'stop-mixer', sourcePortId: 'audio-out', level: 1, muted: false }
      ] }
    ] });
    await waitFor((event) => event.type === 'audioNetworkSynced' && event.nodeCount === 4,
      after, 'two-plugin audio network');
    after = events.length;
    await command({ type: 'syncSequencer', project: { tracks: plugins.map((plugin, index) => ({
      id: 'stop-track-' + index, type: 'midi', armed: false, muted: false, volume: 1,
      inputId: '', outputId: plugin.chainId, clips: [{ id: 'stop-clip-' + index,
        startPpq: 0, lengthPpq: 24, notes: [{ id: 'stop-note-' + index,
          pitch: index === 0 ? 60 : 67, startPpq: 0, durationPpq: 20,
          velocity: 110, channel: 1 }] }] })) } });
    await waitFor((event) => event.type === 'sequencerSynced' && event.trackCount === 2,
      after, 'two long-note tracks');

    const stressStart = events.length;
    for (let cycle = 0; cycle < 100; cycle += 1) {
      await command({ type: 'setTransport', bpm: 120, seekPpq: 0, playing: true,
        loop: { enabled: true, startPpq: 0, endPpq: 4 } });
      await sleep(35);
      await command({ type: 'setTransport', playing: false });
      await sleep(35);
    }
    await sleep(800);
    const stressEvents = events.slice(stressStart);
    const audible = stressEvents.filter((event) => event.type === 'masterMeter'
      && Math.max(Number(event.peakLeft) || 0, Number(event.peakRight) || 0) > 0.0001);
    const quietTail = stressEvents.filter((event) => event.type === 'masterMeter'
      && event.observedAt >= Date.now() - 600);
    assert(audible.length > 0, 'Dexed/Vital never became audible during the Stop stress');
    assert(quietTail.length >= 2 && quietTail.every((event) =>
      Math.max(Number(event.peakLeft) || 0, Number(event.peakRight) || 0) <= 0.0001),
    'post-Stop tail is not silent: ' + JSON.stringify(quietTail));

    // Let the long notes cross more than five short loop wraps, then stop in
    // the middle of the next pass. No event from the following pass may sound.
    const loopStressStart = events.length;
    await command({ type: 'setTransport', seekPpq: 0, playing: true,
      loop: { enabled: true, startPpq: 0, endPpq: 0.25 } });
    await sleep(700);
    await command({ type: 'setTransport', playing: false });
    await sleep(800);
    const loopStressEvents = events.slice(loopStressStart);
    const loopAudible = loopStressEvents.filter((event) => event.type === 'masterMeter'
      && Math.max(Number(event.peakLeft) || 0, Number(event.peakRight) || 0) > 0.0001);
    const loopQuiet = loopStressEvents.filter((event) => event.type === 'masterMeter'
      && event.observedAt >= Date.now() - 600);
    assert(loopAudible.length > 0, 'multi-wrap MIDI loop was never audible');
    assert(loopQuiet.length >= 2 && loopQuiet.every((event) =>
      Math.max(Number(event.peakLeft) || 0, Number(event.peakRight) || 0) <= 0.0001),
    'the next loop pass sounded after Stop: ' + JSON.stringify(loopQuiet));

    // Immediate restart after the 100th panic must accept a fresh epoch.
    after = events.length;
    await command({ type: 'setTransport', seekPpq: 0, playing: true });
    const resumed = await waitFor((event) => event.type === 'masterMeter'
      && Math.max(Number(event.peakLeft) || 0, Number(event.peakRight) || 0) > 0.0001,
    after, 'audible immediate restart', 5000);
    await command({ type: 'setTransport', playing: false });
    await sleep(800);
    const finalMeters = events.filter((event) => event.type === 'masterMeter'
      && event.observedAt >= Date.now() - 600);
    assert(finalMeters.length >= 2 && finalMeters.every((event) =>
      Math.max(Number(event.peakLeft) || 0, Number(event.peakRight) || 0) <= 0.0001),
    'final Stop left audible output: ' + JSON.stringify(finalMeters));

    return { verdict: 'PASS', plugins: plugins.map(({ name, path }) => ({ name, path })),
      longNotePpq: 20, loop: { enabled: true, startPpq: 0, endPpq: 4 },
      playStopCycles: 100, audibleMeterCount: audible.length,
      postStopMeterCount: quietTail.length, postStopMaximumPeak: Math.max(0,
        ...quietTail.map((event) => Math.max(Number(event.peakLeft) || 0, Number(event.peakRight) || 0))),
      multiWrapLoop: { startPpq: 0, endPpq: 0.25, heldMilliseconds: 700,
        minimumCompletedWraps: 5, audibleMeterCount: loopAudible.length,
        postStopMeterCount: loopQuiet.length, postStopMaximumPeak: Math.max(0,
          ...loopQuiet.map((event) => Math.max(Number(event.peakLeft) || 0,
            Number(event.peakRight) || 0))) },
      immediateRestartPeak: Math.max(Number(resumed.peakLeft) || 0, Number(resumed.peakRight) || 0),
      finalStopMaximumPeak: Math.max(0, ...finalMeters.map((event) =>
        Math.max(Number(event.peakLeft) || 0, Number(event.peakRight) || 0))),
      engineErrors: events.filter((event) => event.type === 'error') };
  } finally {
    try { await command({ type: 'setTransport', playing: false }); } catch {}
    try { await command({ type: 'sequencerPanic' }); } catch {}
    for (const plugin of plugins) {
      try { await command({ type: 'removeInstance', chainId: plugin.chainId,
        instanceId: plugin.instanceId }); } catch {}
    }
    off();
  }
})()`;

const evaluation = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
socket.close();
if (evaluation.exceptionDetails) {
  throw new Error(evaluation.exceptionDetails.exception?.description || evaluation.exceptionDetails.text);
}
const result = evaluation.result?.value;
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result?.verdict !== 'PASS') process.exitCode = 1;
