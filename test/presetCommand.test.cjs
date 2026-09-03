'use strict';

/**
 * The IPC gate for `loadPresetChunks`.
 *
 * This command carries the least trusted bytes in the application: everything
 * else the engine loads was chosen by the user from their own disk, while a
 * preset may have been downloaded, and it ends up inside a VST3 plugin's
 * setState in the audio engine process. The validator is the first of three
 * gates -- the engine re-checks identity, generation and class on arrival.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isValidLoadPresetChunksCommand, MAX_CHUNK_CHARS } = require('../src/main/presetCommand.js');
const { ALLOWED_ENGINE_COMMANDS } = require('../src/main/engineCommandPolicy.js');

const CLASS_ID = '5653544E6924486D6173736976652078';
const CHUNK = Buffer.from('component-state').toString('base64');

const valid = (overrides = {}) => ({
  v: 1,
  type: 'loadPresetChunks',
  chainId: 'vst-011',
  instanceId: 'plugin-3',
  pluginId: 'C:/Program Files/Common Files/VST3/Massive X.vst3',
  generation: 7,
  classId: CLASS_ID,
  component: CHUNK,
  ...overrides
});

test('the command is on the engine whitelist', () => {
  // Without this the validator never runs: main.js rejects unknown types first.
  assert.equal(ALLOWED_ENGINE_COMMANDS.has('loadPresetChunks'), true);
});

test('a well-formed request is accepted', () => {
  assert.equal(isValidLoadPresetChunksCommand(valid()), true);
  assert.equal(isValidLoadPresetChunksCommand(valid({ controller: CHUNK })), true);
  // The controller half is optional, exactly as it is in the container.
  assert.equal(isValidLoadPresetChunksCommand(valid({ controller: null })), true);
  assert.equal(isValidLoadPresetChunksCommand(valid({ controller: undefined })), true);
});

test('anything that is not this command is refused', () => {
  assert.equal(isValidLoadPresetChunksCommand(null), false);
  assert.equal(isValidLoadPresetChunksCommand(undefined), false);
  assert.equal(isValidLoadPresetChunksCommand('loadPresetChunks'), false);
  assert.equal(isValidLoadPresetChunksCommand(valid({ v: 2 })), false);
  assert.equal(isValidLoadPresetChunksCommand(valid({ type: 'setState' })), false);
});

test('the target identity must be complete and well-shaped', () => {
  assert.equal(isValidLoadPresetChunksCommand(valid({ chainId: '' })), false);
  assert.equal(isValidLoadPresetChunksCommand(valid({ chainId: '1-starts-with-digit' })), false);
  assert.equal(isValidLoadPresetChunksCommand(valid({ chainId: 'vst/../../etc' })), false);
  assert.equal(isValidLoadPresetChunksCommand(valid({ instanceId: 'plugin-0' })), false);
  assert.equal(isValidLoadPresetChunksCommand(valid({ instanceId: 'plugin' })), false);
  assert.equal(isValidLoadPresetChunksCommand(valid({ pluginId: '' })), false);
  assert.equal(isValidLoadPresetChunksCommand(valid({ pluginId: 'x'.repeat(2049) })), false);
  assert.equal(isValidLoadPresetChunksCommand(valid({ generation: 0 })), false);
  assert.equal(isValidLoadPresetChunksCommand(valid({ generation: -1 })), false);
  assert.equal(isValidLoadPresetChunksCommand(valid({ generation: 1.5 })), false);
  assert.equal(isValidLoadPresetChunksCommand(valid({ generation: '7' })), false);
});

test('a preset with no declared target class cannot be sent at all', () => {
  // The engine re-checks this, but a request that cannot name its target has
  // no business travelling in the first place.
  assert.equal(isValidLoadPresetChunksCommand(valid({ classId: undefined })), false);
  assert.equal(isValidLoadPresetChunksCommand(valid({ classId: '' })), false);
  assert.equal(isValidLoadPresetChunksCommand(valid({ classId: CLASS_ID.slice(0, 31) })), false);
  assert.equal(isValidLoadPresetChunksCommand(valid({ classId: 'z'.repeat(32) })), false);
  // Case is not the gate's business: the engine compares case-insensitively.
  assert.equal(isValidLoadPresetChunksCommand(valid({ classId: CLASS_ID.toLowerCase() })), true);
});

test('chunks must be real base64, present, and bounded', () => {
  assert.equal(isValidLoadPresetChunksCommand(valid({ component: '' })), false);
  assert.equal(isValidLoadPresetChunksCommand(valid({ component: undefined })), false);
  assert.equal(isValidLoadPresetChunksCommand(valid({ component: 'not base64!' })), false);
  // Padding that does not land on a 4-character boundary is not base64.
  assert.equal(isValidLoadPresetChunksCommand(valid({ component: 'abcde' })), false);
  assert.equal(isValidLoadPresetChunksCommand(valid({ component: Buffer.alloc(0) })), false);
  assert.equal(isValidLoadPresetChunksCommand(valid({ controller: 'not base64!' })), false);

  const overCap = 'A'.repeat(MAX_CHUNK_CHARS + 4);
  assert.equal(isValidLoadPresetChunksCommand(valid({ component: overCap })), false);
  assert.equal(isValidLoadPresetChunksCommand(valid({ controller: overCap })), false);
});

test('the ceiling leaves room for a genuinely large preset', () => {
  // Sample-heavy instruments run to megabytes; the cap only has to bound the
  // single JSON line the engine reads.
  assert.ok(MAX_CHUNK_CHARS >= 8 * 1024 * 1024);
  const big = 'A'.repeat(4 * 1024 * 1024);
  assert.equal(isValidLoadPresetChunksCommand(valid({ component: big })), true);
});
