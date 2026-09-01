import fs from 'node:fs';

const [port = '9444', artifactDirectory = ''] = process.argv.slice(2);

if (!artifactDirectory) throw new Error('Usage: runtime-export-gauntlet.mjs <port> <absolute-artifact-directory>');

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
const sourceFile = `${artifactRoot}/sequencer-export-transport.wav`;
const runStamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
const expression = `(async () => {
  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const samePath = (left, right) => String(left).split(String.fromCharCode(92)).join('/').toLowerCase()
    === String(right).split(String.fromCharCode(92)).join('/').toLowerCase();
  const events = [];
  const off = window.hubAPI.onEngineEvent((message) => events.push({ ...message, observedAt: Date.now() }));
  const command = async (payload) => {
    const result = await window.hubAPI.engineCommand({ v: 1, ...payload });
    assert(result?.ok === true, 'engine command rejected: ' + payload.type + ' / ' + JSON.stringify(result));
    return result;
  };
  const waitFor = async (predicate, after, description, timeout = 15000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const found = events.slice(after).find(predicate);
      if (found) return found;
      await sleep(20);
    }
    const errors = events.slice(after).filter((event) => event.type === 'error');
    throw new Error('timeout waiting for ' + description + '; errors=' + JSON.stringify(errors));
  };
  const sendAndWaitTransport = async (payload, expectedPlaying) => {
    const after = events.length;
    await command({ type: 'setTransport', ...payload });
    return waitFor((event) => event.type === 'transport' && event.playing === expectedPlaying,
      after, 'transport playing=' + expectedPlaying, 3000);
  };
  const waitQuiet = async () => {
    const after = events.length;
    await sleep(350);
    const meters = events.slice(after).filter((event) => event.type === 'masterMeter');
    assert(meters.length >= 2, 'no post-Stop meter evidence');
    const meter = meters.at(-1);
    assert(Number(meter.peakLeft) <= 0.0001 && Number(meter.peakRight) <= 0.0001,
      'ghost audio after Stop: ' + JSON.stringify(meter));
    return { peakLeft: meter.peakLeft, peakRight: meter.peakRight };
  };
  const waitAudible = async () => {
    const after = events.length;
    const meter = await waitFor((event) => event.type === 'masterMeter'
      && Math.max(Number(event.peakLeft) || 0, Number(event.peakRight) || 0) > 0.002,
      after, 'audible Master meter after Play', 3000);
    return { peakLeft: meter.peakLeft, peakRight: meter.peakRight };
  };

  try {
    const appState = await window.hubAPI.engineState();
    assert(appState?.state === 'running', 'packaged native engine is not running: ' + JSON.stringify(appState));
    let after = events.length;
    await command({ type: 'hello' });
    const hello = await waitFor((event) => event.type === 'hello', after, 'hello', 3000);
    assert(hello.sequencerExportCapabilities?.formats?.join(',') === 'wav,mp3,ogg',
      'runtime does not advertise WAV/MP3/OGG');
    assert(hello.sequencerExportCapabilities?.mp3Available === true,
      'packaged runtime does not see bundled LAME');

    after = events.length;
    await command({ type: 'syncSequencer', project: { tracks: [
      { id: 'track-runtime-a', type: 'audio', armed: false, muted: false, volume: 0.42,
        inputId: '', outputId: 'mixer-runtime', clips: [
          { id: 'clip-runtime-a1', filePath: ${JSON.stringify(sourceFile)}, startPpq: 0,
            lengthPpq: 0.2, trimStartSeconds: 0, trimEndSeconds: 0.1,
            durationSeconds: 0.1, gain: 0.55 },
          { id: 'clip-runtime-a2', filePath: ${JSON.stringify(sourceFile)}, startPpq: 0.2,
            lengthPpq: 0.2, trimStartSeconds: 0, trimEndSeconds: 0.1,
            durationSeconds: 0.1, gain: 0.45 }
        ] },
      { id: 'track-runtime-b', type: 'audio', armed: false, muted: false, volume: 0.31,
        inputId: '', outputId: 'mixer-runtime', clips: [
          { id: 'clip-runtime-b1', filePath: ${JSON.stringify(sourceFile)}, startPpq: 0.05,
            lengthPpq: 0.2, trimStartSeconds: 0, trimEndSeconds: 0.1,
            durationSeconds: 0.1, gain: 0.35 },
          { id: 'clip-runtime-b2', filePath: ${JSON.stringify(sourceFile)}, startPpq: 0.25,
            lengthPpq: 0.2, trimStartSeconds: 0, trimEndSeconds: 0.1,
            durationSeconds: 0.1, gain: 0.3 }
        ] }
    ] } });
    await waitFor((event) => event.type === 'sequencerSynced' && event.trackCount === 2,
      after, 'two-track sequencer sync', 5000);
    const importedAudio = events.slice(after).filter((event) => event.type === 'sequencerAudioInfo');
    assert(importedAudio.length === 4 && importedAudio.every((event) => event.available === true),
      'runtime audio fixture import failed: ' + JSON.stringify(importedAudio));

    after = events.length;
    await command({ type: 'syncAudioGraph', nodes: [
      { id: 'sequencer-runtime', nodeType: 'sequencer', inputs: [] },
      { id: 'mixer-runtime', nodeType: 'mixer', masterLevel: 0.65,
        inputs: [{ portId: 'audio-in-1', sourceNodeId: 'sequencer-runtime',
          sourcePortId: 'audio-out', level: 0.7, muted: false }] },
      { id: 'audio-output', nodeType: 'audio-output', inputs: [
        { portId: 'audio-in', sourceNodeId: 'mixer-runtime', sourcePortId: 'audio-out',
          level: 1, muted: false }
      ] }
    ] });
    await waitFor((event) => event.type === 'audioGraphSynced' && event.nodeCount === 3,
      after, 'runtime audio graph sync', 5000);

    await sendAndWaitTransport({ bpm: 120, loop: { enabled: true, startPpq: 0.05, endPpq: 0.35 },
      seekPpq: 0.1, playing: false }, false);
    await waitQuiet();

    const codecs = [
      { format: 'wav', bits: 24 },
      { format: 'mp3', bitrateKbps: 320 },
      { format: 'ogg', qualityIndex: hello.sequencerExportCapabilities.oggQualityOptions.length - 1 }
    ];
    const formatResults = [];
    for (const codec of codecs) {
      const filePath = ${JSON.stringify(artifactRoot)} + '/runtime-export-${runStamp}.' + codec.format;
      const stoppedBefore = await sendAndWaitTransport({ loop: { enabled: true, startPpq: 0.05, endPpq: 0.35 },
        seekPpq: 0.1, playing: false }, false);
      const quietBefore = await waitQuiet();
      after = events.length;
      await command({ type: 'sequencerExport', filePath, startPpq: 0, endPpq: 0.45,
        tailSeconds: 1.5, ...codec });
      const started = await waitFor((event) => event.type === 'sequencerExport'
        && event.state === 'started' && samePath(event.filePath, filePath),
        after, codec.format + ' started');
      assert(started.livePlaying === false,
        codec.format + ' export changed the stopped live transport at start');
      assert(started.renderThread === 'offline-worker' && started.deviceIndependent === true
        && started.hardwareOutput === false,
        codec.format + ' export is not running on the device-independent offline worker');
      assert(started.liveLoopEnabled === true && started.offlineLoopEnabled === false,
        codec.format + ' transport contexts are not isolated');
      assert(started.snapshot?.tracks?.length === 2
        && started.snapshot.tracks.every((track) => track.clips.length === 2),
        codec.format + ' snapshot did not capture the two-track/four-clip arrangement');
      assert(started.offlinePpqPosition === 0, codec.format + ' offline range did not start at zero');

      const quietDuringExport = await waitQuiet();
      const terminal = await waitFor((event) => event.type === 'sequencerExport'
        && samePath(event.filePath, filePath) && ['complete', 'error', 'cancelled'].includes(event.state),
        after, codec.format + ' terminal event');
      assert(terminal.state === 'complete', codec.format + ' export failed: ' + JSON.stringify(terminal));
      const metronomeTicksDuringExport = events.filter((event) => event.type === 'metronomeTick'
        && event.observedAt >= started.observedAt && event.observedAt <= terminal.observedAt);
      assert(metronomeTicksDuringExport.length === 0,
        codec.format + ' export emitted metronome clicks: ' + JSON.stringify(metronomeTicksDuringExport));
      assert(terminal.livePlaying === false && terminal.livePpqPosition === 0.1
        && terminal.liveLoopEnabled === true,
        codec.format + ' changed the live transport at completion: ' + JSON.stringify(terminal));
      assert(terminal.sampleRate === 48000 && terminal.channels === 2 && terminal.frames === 82800,
        codec.format + ' has unexpected render metadata: ' + JSON.stringify(terminal));
      assert(Number(terminal.realtimeSpeed) > 2,
        codec.format + ' short bounce did not exceed 2x realtime: ' + JSON.stringify(terminal));

      const stoppedAfter = await sendAndWaitTransport({ playing: false }, false);
      const quiet = await waitQuiet();
      const playedAfter = await sendAndWaitTransport({ loop: { enabled: true, startPpq: 0.05, endPpq: 0.35 },
        seekPpq: 0.1, playing: true }, true);
      const audible = await waitAudible();
      const finalStop = await sendAndWaitTransport({ playing: false }, false);
      const finalQuiet = await waitQuiet();
      formatResults.push({ codec, filePath, stoppedBefore, quietBefore, started, quietDuringExport,
        terminal, metronomeTicksDuringExport, stoppedAfter, quiet, playedAfter, audible,
        finalStop, finalQuiet });
    }

    const cancelledPath = ${JSON.stringify(artifactRoot)} + '/runtime-export-cancelled-${runStamp}.mp3';
    after = events.length;
    await command({ type: 'sequencerExport', format: 'mp3', bitrateKbps: 128, filePath: cancelledPath,
      startPpq: 0, endPpq: 200000, tailSeconds: 0 });
    const cancelStarted = await waitFor((event) => event.type === 'sequencerExport'
      && event.state === 'started' && samePath(event.filePath, cancelledPath),
      after, 'cancellable export started');
    const cancelPlay = await sendAndWaitTransport({ loop: { enabled: true, startPpq: 0.05, endPpq: 0.35 },
      seekPpq: 0.1, playing: true }, true);
    const audibleDuringCancel = await waitAudible();
    const cancelStop = await sendAndWaitTransport({ playing: false }, false);
    await command({ type: 'sequencerCancelExport' });
    const cancelled = await waitFor((event) => event.type === 'sequencerExport'
      && samePath(event.filePath, cancelledPath) && event.state === 'cancelled',
      after, 'cancelled terminal event', 5000);
    assert(Number(cancelled.frames) >= 0 && cancelled.livePlaying === false,
      'cancel did not preserve the requested stopped live state');
    await sendAndWaitTransport({ loop: { enabled: true, startPpq: 0.05, endPpq: 0.35 },
      seekPpq: 0.1, playing: true }, true);
    const audibleAfterCancel = await waitAudible();
    await sendAndWaitTransport({ playing: false }, false);
    const quietAfterCancel = await waitQuiet();

    return {
      verdict: 'PASS',
      appState,
      page: { title: document.title, url: location.href },
      provenance: await window.hubAPI.runtimeProvenance(),
      capabilities: hello.sequencerExportCapabilities,
      importedAudio,
      formatResults,
      cancellation: { filePath: cancelledPath, started: cancelStarted,
        played: cancelPlay, audibleDuringCancel, stopped: cancelStop, terminal: cancelled,
        audibleAfterCancel, quietAfterCancel },
      engineErrors: events.filter((event) => event.type === 'error')
    };
  } finally {
    off();
  }
})()`;

const evaluation = await send('Runtime.evaluate', {
  expression,
  awaitPromise: true,
  returnByValue: true
});
socket.close();
if (evaluation.exceptionDetails) {
  throw new Error(evaluation.exceptionDetails.exception?.description || evaluation.exceptionDetails.text);
}
const result = evaluation.result?.value;
const expectedSignatures = {
  wav: (header) => header.subarray(0, 4).toString('ascii') === 'RIFF'
    && header.subarray(8, 12).toString('ascii') === 'WAVE',
  ogg: (header) => header.subarray(0, 4).toString('ascii') === 'OggS',
  mp3: (header) => header.subarray(0, 3).toString('ascii') === 'ID3'
    || (header[0] === 0xff && (header[1] & 0xe0) === 0xe0)
};
if (result?.verdict === 'PASS') {
  result.artifactEvidence = result.formatResults.map(({ codec, filePath }) => {
    const stat = fs.statSync(filePath);
    const descriptor = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(16);
    try { fs.readSync(descriptor, header, 0, header.length, 0); } finally { fs.closeSync(descriptor); }
    if (stat.size <= 1024) throw new Error(`${codec.format} runtime artifact is unexpectedly small: ${stat.size}`);
    if (!expectedSignatures[codec.format]?.(header)) {
      throw new Error(`${codec.format} runtime artifact has an invalid signature: ${header.toString('hex')}`);
    }
    return { format: codec.format, filePath, bytes: stat.size, headerHex: header.toString('hex') };
  });
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result?.verdict !== 'PASS') process.exitCode = 1;
