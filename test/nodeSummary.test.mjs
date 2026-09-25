/**
 * What a card's readout says on the Patch Bay (core/nodeSummary.js, D-055).
 *
 * The readout replaced two badges and a subtitle; what it must keep doing is
 * tell two nodes of one type apart, and say an absence as an absence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { gainDb, meterReading, nodeSummaryLines, oneRingSceneId, SUMMARY_LINE_CHARS } from '../src/renderer/js/core/nodeSummary.js';

test('a VST chain lists its plugins, with their role, and counts what does not fit', () => {
  assert.deepEqual(nodeSummaryLines('vst', { plugins: [] }), [{ text: 'No plugin', tone: 'dim', tag: '' }]);
  const two = nodeSummaryLines('vst', { plugins: [
    { name: 'Pigments', role: 'instrument' }, { name: 'ValhallaSupermassive', role: 'audio-effect' }
  ] });
  // The number takes its room from the name: twenty letters are cut at nineteen.
  assert.deepEqual(two.map((line) => [line.num, line.text, line.tag]), [['1', 'Pigments', 'VSTi'], ['2', 'ValhallaSupermassi…', 'FX']],
    'numbered in chain order');
  const three = nodeSummaryLines('vst', { plugins: [
    { name: 'A', role: 'instrument' }, { name: 'B', role: 'audio-effect' }, { name: 'C', role: 'audio-effect' }
  ] });
  assert.deepEqual(three.map((line) => line.text), ['A', '+ 2 more'], 'two lines at most');
});

test('a long name is cut to the card, and leaves room for its tag', () => {
  const [line] = nodeSummaryLines('vst', { plugins: [{ name: 'X'.repeat(60), role: 'instrument' }] });
  assert.ok(line.text.endsWith('…'));
  assert.ok(line.text.length + line.tag.length + 1 <= SUMMARY_LINE_CHARS);
});

test('a player shows its file, and its format as the tag', () => {
  assert.deepEqual(nodeSummaryLines('audio-player', { filePath: String.raw`C:\Music\Take 3.wav` }),
    [{ text: 'Take 3', tone: 'value', tag: 'WAV' }]);
  assert.deepEqual(nodeSummaryLines('audio-player', {}), [{ text: 'No file', tone: 'dim', tag: '' }]);
});

test('the other types say what sets one apart from the next', () => {
  const [arp] = nodeSummaryLines('arpeggiator', { mode: 'Up', rate: '1/16', patternLength: 8 });
  assert.equal(arp.text, 'UP  1/16  8 STEPS');
  assert.deepEqual(arp.segments.map((part) => part.tone), ['accent', 'value', 'value'], 'the mode lit, as on its screen');
  assert.deepEqual(nodeSummaryLines('sequencer', null, { trackCount: 2 }).map((l) => l.text), ['2 tracks']);
  assert.deepEqual(nodeSummaryLines('sequencer', null), [], 'nothing known is said by the caller, as the family');
  assert.deepEqual(nodeSummaryLines('audio-input', null).map((l) => l.text), ['Live input']);
});

test('a One Ring says its scene, the runtime one once it has spoken, and whether it plays', () => {
  const content = { selectedScene: 1, scenes: [{ id: 'A1' }, { id: 'B1' }, { id: 'C1' }] };
  const [stopped] = nodeSummaryLines('one-ring', content);
  assert.deepEqual([stopped.text, stopped.tag], ['SCENE  B1', 'STOPPED']);
  const [playing] = nodeSummaryLines('one-ring', content, { ringStatus: { playing: true, scene: 2 } });
  assert.deepEqual([playing.text, playing.tag], ['SCENE  C1', 'PLAYING']);
  assert.equal(oneRingSceneId(content, null), 'B1');
});

test('a card meter reads the last 60 dB and warms near the top', () => {
  assert.deepEqual(meterReading(0), { fraction: 0, level: 'ok' });
  assert.deepEqual(meterReading(Number.NaN), { fraction: 0, level: 'ok' });
  assert.equal(meterReading(1).fraction, 1);
  assert.equal(meterReading(1).level, 'hot');
  assert.ok(Math.abs(meterReading(0.001).fraction) < 1e-9, '-60 dB is the floor');
  assert.equal(meterReading(0.6).level, 'warn', '-4.4 dB');
  assert.equal(meterReading(0.2).level, 'ok');
  assert.equal(meterReading(2).fraction, 1, 'over full scale stays full');
});

test('a gain prints as a mixer does', () => {
  assert.equal(gainDb(1), '0.0');
  assert.equal(gainDb(0.5), '−6.0');
  assert.equal(gainDb(2), '+6.0');
  assert.equal(gainDb(0), '−∞');
});
