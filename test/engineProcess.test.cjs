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
