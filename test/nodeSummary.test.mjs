/**
 * What a card's readout says on the Patch Bay (core/nodeSummary.js, D-055).
 *
 * The readout replaced two badges and a subtitle; what it must keep doing is
 * tell two nodes of one type apart, and say an absence as an absence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nodeSummaryLines, SUMMARY_LINE_CHARS } from '../src/renderer/js/core/nodeSummary.js';

test('a VST chain lists its plugins, with their role, and counts what does not fit', () => {
  assert.deepEqual(nodeSummaryLines('vst', { plugins: [] }), [{ text: 'No plugin', tone: 'dim', tag: '' }]);
  const two = nodeSummaryLines('vst', { plugins: [
    { name: 'Pigments', role: 'instrument' }, { name: 'ValhallaSupermassive', role: 'audio-effect' }
  ] });
  assert.deepEqual(two.map((line) => [line.text, line.tag]), [['Pigments', 'VSTi'], ['ValhallaSupermassive', 'FX']]);
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
  assert.deepEqual(nodeSummaryLines('arpeggiator', { mode: 'Up', rate: '1/16' }).map((l) => l.text), ['UP  1/16']);
  assert.deepEqual(nodeSummaryLines('mixer', { inputs: [{}, {}] }).map((l) => l.text), ['2 inputs']);
  assert.deepEqual(nodeSummaryLines('one-ring', { selectedScene: 1, scenes: [{ id: 'A1' }, { id: 'B1' }] }).map((l) => l.text), ['Scene B1']);
  assert.deepEqual(nodeSummaryLines('sequencer', null), [], 'nothing to say is said by the caller, as the family');
});
