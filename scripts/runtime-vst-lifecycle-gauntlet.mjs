const [port = '9462', dexed = '', vital = ''] = process.argv.slice(2);
if (!dexed || !vital) throw new Error('Usage: runtime-vst-lifecycle-gauntlet.mjs <port> <dexed> <vital>');

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
    { name: 'Dexed', path: ${JSON.stringify(dexed.replaceAll('\\', '/'))} },
    { name: 'Vital', path: ${JSON.stringify(vital.replaceAll('\\', '/'))} }
  ];
  const results = [];
  try {
    for (const plugin of plugins) {
      const chainId = 'lifecycle-' + plugin.name.toLowerCase();
      const instanceId = 'lifecycle-instance';
      for (let cycle = 1; cycle <= 3; cycle += 1) {
        let after = events.length;
        await command({ type: 'createInstance', requestId: chainId + '-load-' + cycle,
          chainId, instanceId, pluginId: plugin.path, index: 0 });
        const ready = await waitFor((event) => event.type === 'instanceStatus'
          && event.chainId === chainId && event.instanceId === instanceId
          && ['ready', 'error'].includes(event.status), after, plugin.name + ' ready');
        assert(ready.status === 'ready', plugin.name + ' load failed: ' + JSON.stringify(ready));

        let editorOpen = null;
        let editorClosed = null;
        if (cycle === 1) {
          after = events.length;
          await command({ type: 'openEditor', chainId, instanceId,
            pluginId: plugin.path.replaceAll('/', String.fromCharCode(92)),
            generation: ready.generation });
          editorOpen = await waitFor((event) => event.type === 'editorStatus'
            && event.chainId === chainId && event.instanceId === instanceId, after,
          plugin.name + ' editor open');
          assert(editorOpen.open === true && Number(editorOpen.width) > 0 && Number(editorOpen.height) > 0,
            plugin.name + ' editor did not open: ' + JSON.stringify(editorOpen));
          after = events.length;
          await command({ type: 'closeEditor', chainId, instanceId });
          editorClosed = await waitFor((event) => event.type === 'editorStatus'
            && event.chainId === chainId && event.instanceId === instanceId && event.open === false,
          after, plugin.name + ' editor close');
        }

        if (cycle === 2) {
          after = events.length;
          const requestId = 'quiesce-' + plugin.name.toLowerCase();
          await command({ type: 'sequencerQuiesce', requestId });
          await waitFor((event) => event.type === 'sequencerQuiesced'
            && event.requestId === requestId, after, plugin.name + ' project quiesce');
        }

        after = events.length;
        await command({ type: 'removeInstance', chainId, instanceId });
        const removed = await waitFor((event) => event.type === 'chainChanged'
          && event.chainId === chainId
          && !event.instances?.some((instance) => instance.instanceId === instanceId),
        after, plugin.name + ' removal');
        results.push({ plugin: plugin.name, cycle, generation: ready.generation,
          editorOpen, editorClosed, remainingInstances: removed.instances?.length || 0 });
      }
    }
    return { verdict: 'PASS', results,
      engineErrors: events.filter((event) => event.type === 'error') };
  } finally {
    for (const name of ['dexed', 'vital']) {
      try { await command({ type: 'removeInstance', chainId: 'lifecycle-' + name,
        instanceId: 'lifecycle-instance' }); } catch {}
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
