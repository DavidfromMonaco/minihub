import test from 'node:test';
import assert from 'node:assert/strict';
import { formatGainDb, formatPan } from '../src/renderer/js/core/stripValues.js';
import { audioNodeValues } from '../src/renderer/js/core/engineSync.js';
import { normalizeContentFor } from '../src/renderer/js/core/nodeInstances.js';

test('a pan reads C at the centre, and L or R with how far', () => {
  assert.equal(formatPan(0), 'C');
  assert.equal(formatPan(-1), 'L100');
  assert.equal(formatPan(0.25), 'R25');
  assert.equal(formatPan(Number.NaN), 'C');
  assert.equal(formatPan(4), 'R100');
});

test('a Mixer strip keeps its pan, a Morpher input does not grow one', () => {
  const mixer = normalizeContentFor('mixer', { inputs: [{ id: 'audio-in-1', level: 1, pan: -0.5 }, { id: 'audio-in-2', pan: 0 }, { id: 'audio-in-3', pan: 3 }] });
  assert.deepEqual(mixer.inputs.map((input) => input.pan), [-0.5, undefined, 1]);
  const morpher = normalizeContentFor('morpher', { inputs: [{ id: 'audio-in-1', pan: -0.5 }] });
  assert.equal('pan' in morpher.inputs[0], false);
});

test('the live values carry a strip pan to the engine, and nothing for an input without one', () => {
  const values = audioNodeValues([{ id: 'mixer-001', masterLevel: 1, inputs: [
    { portId: 'audio-in-1', level: 1, muted: false, pan: -1 },
    { portId: 'audio-in-2', level: 0.5, muted: true }
  ] }]);
  assert.deepEqual(values[0].inputs, [
    { portId: 'audio-in-1', level: 1, muted: false, pan: -1 },
    { portId: 'audio-in-2', level: 0.5, muted: true }
  ]);
});

test('a gain reads in dB, from silence to +6', () => {
  assert.equal(formatGainDb(1), '+0.0 dB');
  assert.equal(formatGainDb(2), '+6.0 dB');
  assert.equal(formatGainDb(0.5), '-6.0 dB');
  assert.equal(formatGainDb(0), '−∞ dB');
});
