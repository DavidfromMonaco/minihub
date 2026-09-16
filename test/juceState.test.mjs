import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeJuceBase64, readVst3State } from '../src/renderer/js/core/juceState.js';
import { createSequence, readSequence, sequenceFromComponentState, toVstState } from '../src/renderer/js/core/oneRingSequence.js';
import { encodeJuceBase64, oneRingComponent, vst3StateString } from './juceFixture.mjs';

const tenBytes = Uint8Array.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x31, 0x7d, 0x00, 0xff, 0x80]);

test('JUCE\'s base64 reads back, the strings being the ones JUCE writes', () => {
  // native_tests.cpp [core] juce-state checks these two against JUCE.
  assert.equal(encodeJuceBase64(tenBytes), '10.6IRXhnSL8Av+.B');
  assert.deepEqual(decodeJuceBase64('10.6IRXhnSL8Av+.B'), tenBytes);
  assert.deepEqual(new TextDecoder().decode(decodeJuceBase64('8.O4VYfHUZtcF')), 'One Ring');
  assert.deepEqual(decodeJuceBase64('0.'), new Uint8Array(0));
  for (const broken of ['', '.AB', 'x.AB', '3.A*B', 12, null, '99999999999.A']) {
    assert.equal(decodeJuceBase64(broken), null, String(broken));
  }
});

test('a VST3 state gives back its streams, and anything else gives nothing', () => {
  const controller = Uint8Array.from([1, 2, 3]);
  const both = readVst3State(vst3StateString(tenBytes, controller));
  assert.deepEqual(both.component, tenBytes);
  assert.deepEqual(both.controller, controller);
  assert.equal(readVst3State(vst3StateString(tenBytes)).controller, null);
  assert.equal(readVst3State(encodeJuceBase64(tenBytes)), null, 'no magic, no state');
  assert.equal(readVst3State('not a state'), null);
  const block = decodeJuceBase64(vst3StateString(tenBytes));
  new DataView(block.buffer).setUint32(4, block.length, true);
  assert.equal(readVst3State(encodeJuceBase64(block)), null, 'a length past the block');
});

test('a One Ring component stream gives its sequence, past what JUCE wraps around it', () => {
  const state = toVstState(createSequence());
  state.seed = '77';
  state.scenes[2].channels[5].enabled = false;
  const expected = readSequence(state);
  assert.deepEqual(sequenceFromComponentState(oneRingComponent(state)), expected);

  // A plugin that may replace a VST2 writes a binary header first, and a
  // brace may sit in it.
  const header = Uint8Array.from([0x43, 0x63, 0x6e, 0x4b, 0x7b, 0x00, 0x00, 0x7b, 0x22, 0x46, 0x42]);
  const body = oneRingComponent(state);
  const wrapped = new Uint8Array(header.length + body.length);
  wrapped.set(header);
  wrapped.set(body, header.length);
  assert.deepEqual(sequenceFromComponentState(wrapped), expected);

  assert.throws(() => sequenceFromComponentState(tenBytes), /not a One Ring state/);
  assert.throws(() => sequenceFromComponentState(oneRingComponent({ ...state, version: 2 })), /version/);
  assert.throws(() => sequenceFromComponentState(null), /no plugin state/);
});
