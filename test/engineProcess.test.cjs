'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EngineProcess } = require('../src/main/engine');

function rig() {
  const events = [];
  const engine = new EngineProcess({ onEvent: (event) => events.push(event) });
  engine.child = { stdin: {} };
  const commands = [];
  engine.send = (command) => { commands.push(command); return true; };
  return { engine, events, commands };
}

test('concurrent VST state captures share one native transaction and both settle', async () => {
  const { engine, commands } = rig();
  const first = engine.capturePluginStates(100);
  const second = engine.capturePluginStates(100);
  assert.strictEqual(second, first, 'concurrent callers observe the same in-flight capture');
  assert.equal(commands.length, 1, 'only one native snapshot command is necessary');

  engine._onLine(JSON.stringify({ v: 1, type: 'pluginStateCaptureComplete' }));
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(engine._stateCapturePending, null);

  // A duplicate completion from a noisy/replayed native stream is harmless.
  engine._onLine(JSON.stringify({ v: 1, type: 'pluginStateCaptureComplete' }));
  assert.equal(commands.length, 1);
});

test('engine failure settles every coalesced state-capture caller', async () => {
  const { engine } = rig();
  const first = engine.capturePluginStates(100);
  const second = engine.capturePluginStates(100);
  engine._fail('test-crash');
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.equal(engine._stateCapturePending, null);
});

// ---- a question main asks the engine itself --------------------------------------

test('a main-process query settles on its own answer, which is not forwarded', async () => {
  const { engine, events, commands } = rig();
  const pending = engine.query({ type: 'getEditorBrowsers', chainId: 'vst-1', instanceId: 'plugin-1' },
    { replyType: 'editorBrowsers', timeoutMs: 100 });
  const { requestId } = commands[0];
  assert.equal(commands[0].v, 1);
  assert.match(requestId, /^main-query-/);

  // Same id, wrong type: an answer to something else is not this answer.
  engine._onLine(JSON.stringify({ type: 'error', requestId, message: 'unrelated' }));
  engine._onLine(JSON.stringify({ type: 'editorBrowsers', requestId, open: true, browsers: [] }));
  assert.deepEqual(await pending, { type: 'editorBrowsers', requestId, open: true, browsers: [] });
  assert.deepEqual(events.map((event) => event.type), ['error'],
    'the answer main asked for does not travel on to the renderer');
});

test('a query nobody answers, or asked of a dead engine, settles as null', async () => {
  const { engine } = rig();
  assert.equal(await engine.query({ type: 'getEditorBrowsers' }, { replyType: 'editorBrowsers', timeoutMs: 10 }), null);

  const waiting = engine.query({ type: 'getEditorBrowsers' }, { replyType: 'editorBrowsers', timeoutMs: 1000 });
  engine._fail('test-crash');
  assert.equal(await waiting, null, 'a crash does not leave an agent waiting on a socket');

  engine.child = null;
  assert.equal(await engine.query({ type: 'getEditorBrowsers' }, { replyType: 'editorBrowsers' }), null);
});

test('the engine starts with the environment it is given, and the parent one otherwise', () => {
  const given = new EngineProcess({ env: { WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=0' } });
  assert.equal(given.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, '--remote-debugging-port=0');
  assert.equal(new EngineProcess({}).env, null);
});
