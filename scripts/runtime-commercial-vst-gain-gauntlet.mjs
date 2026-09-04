const [port = '9462', pluginPath = '', secondPluginPath = pluginPath] = process.argv.slice(2);
if (!pluginPath) throw new Error('Usage: runtime-commercial-vst-gain-gauntlet.mjs <port> <vst3-path-a> [vst3-path-b]');

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
const runtimePlugin = pluginPath.replaceAll('\\', '/');
const runtimeSecondPlugin = secondPluginPath.replaceAll('\\', '/');
const expression = `(async () => {
  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const near = (actual, expected, tolerance = 0.02) => Math.abs(Number(actual) - expected) <= tolerance;
  const sameGains = (actual, expected) => Array.isArray(actual) && actual.length === expected.length
    && actual.every((value, index) => near(value, expected[index], 0.000001));
  const events = [];
  const off = window.hubAPI.onEngineEvent((message) => events.push({ ...message, observedAt: Date.now() }));
  const command = async (payload) => {
    const result = await window.hubAPI.engineCommand({ v: 1, ...payload });
    assert(result?.ok === true, 'command rejected: ' + JSON.stringify({ payload, result }));
  };
  const waitFor = async (predicate, after, description, timeout = 45000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const found = events.slice(after).find(predicate);
      if (found) return found;
      await sleep(20);
    }
    throw new Error('timeout waiting for ' + description + '; errors='
      + JSON.stringify(events.slice(after).filter((event) => event.type === 'error')));
  };
  const chainA = 'commercial-vst-a';
  const chainB = 'commercial-vst-b';
  const instanceA = 'commercial-instance-a';
  const instanceB = 'commercial-instance-b';
  const pluginIds = [${JSON.stringify(runtimePlugin)}, ${JSON.stringify(runtimeSecondPlugin)}];
  const audioNetwork = (gainA = 1, gainB = 1, muteA = false, muteB = false) => [
    { id: chainA, nodeType: 'vst', inputs: [] },
    { id: chainB, nodeType: 'vst', inputs: [] },
    { id: 'commercial-mixer', nodeType: 'mixer', masterLevel: 1, inputs: [
      { portId: 'audio-in-1', sourceNodeId: chainA, sourcePortId: 'audio-out', level: gainA, muted: muteA },
      { portId: 'audio-in-2', sourceNodeId: chainB, sourcePortId: 'audio-out', level: gainB, muted: muteB }
    ] },
    { id: 'audio-output', nodeType: 'audio-output', inputs: [
      { portId: 'audio-in', sourceNodeId: 'commercial-mixer', sourcePortId: 'audio-out', level: 1, muted: false }
    ] }
  ];
  try {
    for (const target of [
      { chainId: chainA, instanceId: instanceA, requestId: 'commercial-load-a', pluginId: pluginIds[0] },
      { chainId: chainB, instanceId: instanceB, requestId: 'commercial-load-b', pluginId: pluginIds[1] }
    ]) {
      const after = events.length;
      await command({ type: 'createInstance', index: 0, ...target });
      const status = await waitFor((event) => event.type === 'instanceStatus'
        && event.chainId === target.chainId && event.instanceId === target.instanceId
        && ['ready', 'error'].includes(event.status), after, target.chainId + ' load');
      assert(status.status === 'ready', 'commercial VST load failed: ' + JSON.stringify(status));
      await command({ type: 'setChainMidiEnabled', chainId: target.chainId, enabled: true });
      await command({ type: 'setChainOutputEnabled', chainId: target.chainId, enabled: true });
    }
    let after = events.length;
    await command({ type: 'syncAudioNetwork', nodes: audioNetwork() });
    await waitFor((event) => event.type === 'audioNetworkSynced', after, 'commercial audio network');

    const holdStart = events.length;
    await command({ type: 'midi', chainId: chainA, data: [0x90, 60, 110], offsetMs: 0 });
    await sleep(20500);
    const hold = events.slice(holdStart);
    const audibleMeters = hold.filter((event) => event.type === 'masterMeter'
      && Math.max(Number(event.peakLeft) || 0, Number(event.peakRight) || 0) > 0.0001);
    const heldTrackEvents = hold.filter((event) => event.type === 'audioPathTelemetry'
      && event.instanceId === instanceA);
    const trackABefore = heldTrackEvents.at(-1);
    const mixerBefore = hold.filter((event) => event.type === 'audioPathTelemetry'
      && event.nodeId === 'commercial-mixer').at(-1);
    // A commercial preset may have a natural decay. Require that it sounded,
    // while host-boundary telemetry and unity gain remain present throughout
    // the full held-note interval. The deterministic VST gauntlet separately
    // proves a sample-stable continuous tone for all 20.5 seconds.
    assert(audibleMeters.length >= 3 && heldTrackEvents.length >= 15,
      'commercial VST did not sound and remain hosted for the 20-second hold');
    assert(Number(trackABefore?.maximumOutputPeak) > 0.0001
      && trackABefore?.automaticGainReduction === false
      && Number(trackABefore?.gainReductionCoefficient) === 1,
      'commercial Track A did not retain a passive unity host boundary: ' + JSON.stringify(trackABefore));
    assert(sameGains(mixerBefore?.inputGainCoefficients, [1, 1]),
      'commercial mixer authored gains are not unity: ' + JSON.stringify(mixerBefore));

    const secondStart = events.length;
    await command({ type: 'midi', chainId: chainB, data: [0x90, 67, 110], offsetMs: 0 });
    await sleep(1800);
    const second = events.slice(secondStart);
    const trackAAfter = second.filter((event) => event.type === 'audioPathTelemetry'
      && event.instanceId === instanceA).at(-1);
    const trackB = second.filter((event) => event.type === 'audioPathTelemetry'
      && event.instanceId === instanceB).at(-1);
    const mixerAfter = second.filter((event) => event.type === 'audioPathTelemetry'
      && event.nodeId === 'commercial-mixer').at(-1);
    assert(Number(trackAAfter?.gainCoefficient) === Number(trackABefore.gainCoefficient)
      && Number(trackAAfter?.gainReductionCoefficient) === 1,
      'commercial Track B changed Track A host gain');
    assert(Number(trackB?.maximumOutputPeak) > 0.0001 && sameGains(mixerAfter?.inputGainCoefficients, [1, 1]),
      'commercial Track B or mixer unity state is invalid');

    await command({ type: 'setMasterOutput', gainDb: -6 });
    await command({ type: 'midi', chainId: chainA, data: [0x90, 65, 110], offsetMs: 0 });
    await command({ type: 'midi', chainId: chainB, data: [0x90, 69, 110], offsetMs: 0 });
    await sleep(1200);
    const masterMinusSix = events.filter((event) => event.type === 'masterMeter'
      && Number(event.gainDb) === -6 && Number(event.preGainPeak) > 0).at(-1);
    assert(masterMinusSix && near(Number(masterMinusSix.peakLeft) / Number(masterMinusSix.preGainPeak),
      Math.pow(10, -6 / 20), 0.002),
      'explicit -6 dB Master gain is not a static multiplier: ' + JSON.stringify(masterMinusSix));
    await command({ type: 'setMasterOutput', gainDb: 0 });

    after = events.length;
    await command({ type: 'syncAudioNetwork', nodes: audioNetwork(0.5, 1, false, true) });
    await waitFor((event) => event.type === 'audioNetworkSynced', after, 'commercial fader/mute network');
    await sleep(1200);
    const faderMute = events.filter((event) => event.type === 'audioPathTelemetry'
      && event.nodeId === 'commercial-mixer' && sameGains(event.inputGainCoefficients, [0.5, 0])).at(-1);
    assert(faderMute && faderMute.automaticGainReduction === false,
      'commercial Level/Mute did not remain explicit and static');

    after = events.length;
    await command({ type: 'syncAudioNetwork', nodes: audioNetwork(0.5, 1, true, true) });
    await waitFor((event) => event.type === 'audioNetworkSynced', after, 'commercial all-muted network');
    await sleep(700);
    const quiet = events.slice(after).filter((event) => event.type === 'masterMeter').at(-1);
    assert(quiet && Math.max(Number(quiet.peakLeft) || 0, Number(quiet.peakRight) || 0) <= 0.0001,
      'commercial Mute did not produce silence: ' + JSON.stringify(quiet));

    return {
      verdict: 'PASS', pluginIds, heldSeconds: 20.5,
      audibleMeterCount: audibleMeters.length,
      heldTelemetryCount: heldTrackEvents.length,
      trackABefore, trackAAfterTrackB: trackAAfter, trackB,
      mixerBefore, mixerAfterTrackB: mixerAfter,
      masterMinusSix, faderMute, quiet,
      engineErrors: events.filter((event) => event.type === 'error')
    };
  } finally {
    try { await command({ type: 'midi', chainId: chainA, data: [0x80, 60, 0], offsetMs: 0 }); } catch {}
    try { await command({ type: 'midi', chainId: chainB, data: [0x80, 67, 0], offsetMs: 0 }); } catch {}
    try { await command({ type: 'setMasterOutput', gainDb: 0 }); } catch {}
    try { await command({ type: 'removeInstance', chainId: chainA, instanceId: instanceA }); } catch {}
    try { await command({ type: 'removeInstance', chainId: chainB, instanceId: instanceB }); } catch {}
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
