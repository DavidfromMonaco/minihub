'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isValidSyncOneRingCommand,
  isValidSetOneRingTargetsCommand,
  isValidOneRingCommand,
  isValidRemoveOneRingCommand
} = require('../src/main/oneRingCommand');
const { ALLOWED_ENGINE_COMMANDS } = require('../src/main/engineCommandPolicy');
const { PERIODIC_EVENTS } = require('../src/main/engineEventTrace');

const node = { v: 1, nodeId: 'one-ring-2', generation: 4 };
const state = { version: 1, seed: '1', mutation: '0', selectedScene: 0, sceneTiming: 0, scenePosition: 0, scenes: [] };
const registry = { version: 1, revision: 1, modules: [] };

test('the four commands of a native One Ring are on the allow-list, and its events are not', () => {
  for (const type of ['syncOneRing', 'setOneRingTargets', 'oneRingCommand', 'removeOneRing']) {
    assert.equal(ALLOWED_ENGINE_COMMANDS.has(type), true, type);
  }
  for (const type of ['oneRingSynced', 'oneRingStatus', 'oneRingTargetsStatus']) {
    assert.equal(ALLOWED_ENGINE_COMMANDS.has(type), false, `${type} comes from the engine, never to it`);
  }
});

test('its status is a stream the startup log does not write down', () => {
  assert.equal(PERIODIC_EVENTS.has('oneRingStatus'), true);
});

test('a sequence goes to the engine only named, flagged and versioned', () => {
  const sync = { v: 1, type: 'syncOneRing', nodeId: 'one-ring-2', restore: false, state };
  assert.equal(isValidSyncOneRingCommand(sync), true);
  assert.equal(isValidSyncOneRingCommand({ ...sync, restore: true }), true);
  for (const broken of [
    { ...sync, restore: undefined },
    { ...sync, nodeId: '../one-ring' },
    { ...sync, nodeId: '' },
    { ...sync, state: undefined },
    { ...sync, state: [] },
    { ...sync, state: { ...state, version: 2 } },
    { ...sync, state: { ...state, scenes: {} } },
    { ...sync, type: 'setOneRingTargets' },
    { ...sync, v: 2 }
  ]) {
    assert.equal(isValidSyncOneRingCommand(broken), false, JSON.stringify(broken));
  }
  const huge = { ...state, scenes: [{ id: 'A', name: 'x'.repeat(4 * 1024 * 1024) }] };
  assert.equal(isValidSyncOneRingCommand({ ...sync, state: huge }), false, 'a state past 4 MB is not carried');
});

test('targets go to one runtime generation, as a versioned list', () => {
  const aim = { ...node, type: 'setOneRingTargets', registry };
  assert.equal(isValidSetOneRingTargetsCommand(aim), true);
  for (const broken of [
    { ...aim, generation: 0 },
    { ...aim, generation: 1.5 },
    { ...aim, registry: { ...registry, version: 2 } },
    { ...aim, registry: { ...registry, revision: 0 } },
    { ...aim, registry: { ...registry, modules: {} } },
    { ...aim, registry: undefined },
    { ...aim, nodeId: 'one ring' }
  ]) {
    assert.equal(isValidSetOneRingTargetsCommand(broken), false, JSON.stringify(broken));
  }
});

test('a command is RUN, STOP, one of the seven channel commands on CH1-CH16, or a scene', () => {
  const command = (fields) => ({ ...node, type: 'oneRingCommand', ...fields });
  for (const valid of [
    { command: 'run' },
    { command: 'stop' },
    { command: 'channel', channel: 1, name: 'START' },
    { command: 'channel', channel: 16, name: 'DISABLE' },
    { command: 'scene', scene: 0 },
    { command: 'scene', scene: 3 }
  ]) {
    assert.equal(isValidOneRingCommand(command(valid)), true, JSON.stringify(valid));
  }
  for (const broken of [
    { command: 'channel', channel: 0, name: 'START' },
    { command: 'channel', channel: 17, name: 'START' },
    { command: 'channel', channel: 1, name: 'start' },
    { command: 'channel', channel: '1', name: 'START' },
    { command: 'scene', scene: -1 },
    { command: 'scene', scene: 1.5 },
    { command: 'mutate' },
    { command: 'run', generation: 0 }
  ]) {
    assert.equal(isValidOneRingCommand(command(broken)), false, JSON.stringify(broken));
  }
});

test('a node is removed by its id alone', () => {
  assert.equal(isValidRemoveOneRingCommand({ v: 1, type: 'removeOneRing', nodeId: 'one-ring-2' }), true);
  assert.equal(isValidRemoveOneRingCommand({ v: 1, type: 'removeOneRing', nodeId: 'one-ring-2;rm' }), false);
  assert.equal(isValidRemoveOneRingCommand({ v: 1, type: 'syncOneRing', nodeId: 'one-ring-2' }), false);
});
