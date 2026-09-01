'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ALLOWED_ENGINE_COMMANDS } = require('../src/main/engineCommandPolicy');

test('Sequencer recording/export and Metronome commands cross the Electron boundary', () => {
  assert.equal(ALLOWED_ENGINE_COMMANDS.has('recorder'), false);
  for (const command of ['syncSequencer', 'sequencerMidiInput', 'sequencerRecord', 'sequencerExport', 'sequencerCancelExport', 'sequencerQuiesce', 'sequencerPanic', 'selectMidiOutput']) {
    assert.equal(ALLOWED_ENGINE_COMMANDS.has(command), true);
  }
  assert.equal(ALLOWED_ENGINE_COMMANDS.has('setMetronome'), true);
  assert.equal(ALLOWED_ENGINE_COMMANDS.has('setMasterOutput'), true);
  assert.equal(ALLOWED_ENGINE_COMMANDS.has('resetMasterClip'), true);
  assert.equal(ALLOWED_ENGINE_COMMANDS.has('shutdown'), false);
});
