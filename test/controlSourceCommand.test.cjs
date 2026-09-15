'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isValidSetControlRegistryCommand,
  isValidSetControlStatusCommand
} = require('../src/main/controlSourceCommand');
const { ALLOWED_ENGINE_COMMANDS } = require('../src/main/engineCommandPolicy');
const { createEngineEventTrace } = require('../src/main/engineEventTrace');

const source = { v: 1, chainId: 'vst-001', instanceId: 'plugin-1', pluginId: 'C:\\VST3\\ONE RING.vst3', generation: 3 };
const registry = { version: 1, revision: 1, modules: [] };

test('the two commands to a plugin that sends commands are on the allow-list, and nothing else came with them', () => {
  assert.equal(ALLOWED_ENGINE_COMMANDS.has('setControlRegistry'), true);
  assert.equal(ALLOWED_ENGINE_COMMANDS.has('setControlStatus'), true);
  assert.equal(ALLOWED_ENGINE_COMMANDS.has('controlEvents'), false, 'events come from the engine, never to it');
});

test('a registry is carried to the engine only with a whole identity and a versioned list', () => {
  assert.equal(isValidSetControlRegistryCommand({ ...source, type: 'setControlRegistry', registry }), true);
  for (const broken of [
    { ...source, type: 'setControlRegistry' },
    { ...source, type: 'setControlRegistry', registry: { ...registry, version: 2 } },
    { ...source, type: 'setControlRegistry', registry: { ...registry, revision: 0 } },
    { ...source, type: 'setControlRegistry', registry: { ...registry, modules: {} } },
    { ...source, type: 'setControlRegistry', registry, generation: 0 },
    { ...source, type: 'setControlRegistry', registry, chainId: '../vst' },
    { ...source, type: 'setControlRegistry', registry, instanceId: 'plugin-01' },
    { ...source, type: 'setControlRegistry', registry, pluginId: '' },
    { ...source, type: 'setControlStatus', registry },
    { ...source, v: 2, type: 'setControlRegistry', registry }
  ]) {
    assert.equal(isValidSetControlRegistryCommand(broken), false, JSON.stringify(broken));
  }
  const huge = { ...registry, modules: [{ id: 'x', label: 'x'.repeat(4 * 1024 * 1024), commands: [] }] };
  assert.equal(isValidSetControlRegistryCommand({ ...source, type: 'setControlRegistry', registry: huge }), false,
    'a list the plugin would refuse for its size is not carried there');
});

test("a status line is a bounded string, for the plugin's own window", () => {
  assert.equal(isValidSetControlStatusCommand({ ...source, type: 'setControlStatus', message: '' }), true);
  assert.equal(isValidSetControlStatusCommand({ ...source, type: 'setControlStatus', message: 'RECORD_ON: refused' }), true);
  assert.equal(isValidSetControlStatusCommand({ ...source, type: 'setControlStatus', message: 42 }), false);
  assert.equal(isValidSetControlStatusCommand({ ...source, type: 'setControlStatus', message: 'é'.repeat(2049) }), false,
    'bounded in bytes, as the plugin receives it');
});

test('the packets a plugin sends are a stream and stay out of the startup log; its registry answer does not', () => {
  const trace = createEngineEventTrace();
  assert.equal(trace({ type: 'controlEvents' }), null);
  assert.equal(trace({ type: 'controlRegistryStatus' }), 'engine:event controlRegistryStatus');
});
