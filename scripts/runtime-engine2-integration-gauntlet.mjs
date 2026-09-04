import fs from 'node:fs';
import path from 'node:path';

const [port = '9462', artifactDirectory = '', fixturePath = ''] = process.argv.slice(2);
if (!artifactDirectory || !fixturePath) {
  throw new Error('Usage: runtime-engine2-integration-gauntlet.mjs <port> <artifact-directory> <audio-fixture>');
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
const root = path.resolve(artifactDirectory).replaceAll('\\', '/');
const fixture = path.resolve(fixturePath).replaceAll('\\', '/');
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
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
  const waitFor = async (predicate, after, description, timeout = 10000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const found = events.slice(after).find(predicate);
      if (found) return found;
      await sleep(5);
    }
    throw new Error('timeout waiting for ' + description + '; errors='
      + JSON.stringify(events.slice(after).filter((event) => event.type === 'error')));
  };
  const transport = async (payload, expectedPlaying, expectedPpq = null) => {
    const after = events.length;
    await command({ type: 'setTransport', ...payload });
    return waitFor((event) => event.type === 'transport'
      && event.playing === expectedPlaying
      && (expectedPpq === null || Math.abs(Number(event.ppqPosition) - expectedPpq) < 0.000001),
    after, 'transport ' + JSON.stringify(payload), 3000);
  };
  const samePath = (left, right) => String(left).replaceAll(String.fromCharCode(92), '/').toLowerCase()
    === String(right).replaceAll(String.fromCharCode(92), '/').toLowerCase();
  try {
    const state = await window.hubAPI.engineState();
    assert(state?.state === 'running', 'Engine 2 is not running: ' + JSON.stringify(state));

    let after = events.length;
    await command({ type: 'syncSequencer', project: { tracks: [{
      id: 'engine2-stress-track', type: 'audio', armed: false, muted: false, volume: 1,
      inputId: '', outputId: 'audio-output', clips: [{ id: 'engine2-stress-clip',
        filePath: ${JSON.stringify(fixture)}, startPpq: 0, lengthPpq: 0.2,
        trimStartSeconds: 0, trimEndSeconds: 0.1, durationSeconds: 0.1, gain: 0.25 }]
    }] } });
    await waitFor((event) => event.type === 'sequencerSynced' && event.trackCount === 1,
      after, 'stress sequencer');
    after = events.length;
    await command({ type: 'syncAudioNetwork', nodes: [
      { id: 'engine2-stress-sequencer', nodeType: 'sequencer', inputs: [] },
      { id: 'audio-output', nodeType: 'audio-output', inputs: [{ portId: 'audio-in',
        sourceNodeId: 'engine2-stress-sequencer', sourcePortId: 'audio-out', level: 1, muted: false }] }
    ] });
    await waitFor((event) => event.type === 'audioNetworkSynced' && event.nodeCount === 2,
      after, 'stress audio network');

    for (let index = 0; index < 100; index += 1) {
      await transport({ playing: true }, true);
      await transport({ playing: false }, false);
    }

    for (let index = 0; index < 50; index += 1) {
      await transport({ playing: true }, true);
      await transport({ seekPpq: 0 }, true, 0);
      await transport({ playing: true }, true);
      await transport({ playing: false }, false);
    }

    const exportFiles = [];
    for (let index = 0; index < 20; index += 1) {
      await transport({ seekPpq: 0, playing: true }, true, 0);
      const filePath = ${JSON.stringify(root)} + '/transport-cycle-${stamp}-'
        + String(index + 1).padStart(2, '0') + '.wav';
      after = events.length;
      await command({ type: 'sequencerExport', filePath, format: 'wav', bits: 24,
        startPpq: 0, endPpq: 0.05, tailSeconds: 0 });
      const terminal = await waitFor((event) => event.type === 'sequencerExport'
        && samePath(event.filePath, filePath)
        && ['complete', 'error', 'cancelled'].includes(event.state), after,
      'transport export ' + (index + 1), 10000);
      assert(terminal.state === 'complete' && terminal.livePlaying === true,
        'offline export changed live transport: ' + JSON.stringify(terminal));
      await transport({ playing: false }, false);
      await transport({ playing: true }, true);
      exportFiles.push(filePath);
    }
    await transport({ playing: false, seekPpq: 0 }, false, 0);

    const projectPath = ${JSON.stringify(root)} + '/engine2-project-roundtrip-${stamp}.minihub';
    const project = { format: 'minihub-project', version: 1,
      projectId: 'engine2-roundtrip-${stamp}', name: 'Engine 2 Roundtrip',
      createdAt: new Date().toISOString(), modifiedAt: new Date().toISOString(),
      network: { connections: [], layout: {}, viewport: null },
      nodeInstances: { instances: [], idSeq: {} }, transport: { bpm: 137 },
      master: { gainDb: -3 }, sequencer: { tracks: [] } };
    const written = await window.hubAPI.projectWrite(projectPath, project);
    assert(written?.ok === true, 'project write failed: ' + JSON.stringify(written));
    const read = await window.hubAPI.projectRead(projectPath);
    assert(read?.ok === true && read.project?.projectId === project.projectId
      && Number(read.project?.transport?.bpm) === 137,
    'project round-trip failed: ' + JSON.stringify(read));

    return { verdict: 'PASS', state, playStopCycles: 100, goToStartCycles: 50,
      playExportStopPlayCycles: 20, exportFiles, projectPath,
      transportEvents: events.filter((event) => event.type === 'transport').length,
      exportTerminalEvents: events.filter((event) => event.type === 'sequencerExport'
        && ['complete', 'error', 'cancelled'].includes(event.state)).length,
      engineErrors: events.filter((event) => event.type === 'error') };
  } finally {
    try { await command({ type: 'setTransport', playing: false }); } catch {}
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
if (result?.verdict === 'PASS') {
  for (const filePath of result.exportFiles) {
    const header = fs.readFileSync(filePath).subarray(0, 12);
    if (header.subarray(0, 4).toString('ascii') !== 'RIFF'
      || header.subarray(8, 12).toString('ascii') !== 'WAVE') {
      throw new Error(`invalid WAV artifact: ${filePath}`);
    }
  }
  if (!fs.existsSync(result.projectPath)) throw new Error(`missing project artifact: ${result.projectPath}`);
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result?.verdict !== 'PASS') process.exitCode = 1;
