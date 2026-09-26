import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMON_TIME, barBeat, barStart, barStep, formatSignature, loopBars, loopRangeFromBars, normalizeSignature,
  parseSignature, quartersPerBar, quartersPerBeat
} from '../src/renderer/js/core/musicalTime.js';

test('a position is written bar.beat, counted from one', () => {
  assert.equal(barBeat(0), '1.1', 'the beginning is bar one beat one, not zero');
  assert.equal(barBeat(3.9), '1.4', 'a beat is the beat you are IN, not the nearest');
  assert.equal(barBeat(4), '2.1');
  assert.equal(barBeat(10), '3.3');
  assert.equal(barBeat(1023.5), '256.4');
  // A readout that says 1.1 when there is nothing running is a lie; the One
  // Ring panel showed a dash for a node the engine does not hold, and the
  // header inherits that rather than inventing a second answer.
  assert.equal(barBeat(-1), '—');
  assert.equal(barBeat(Number.NaN), '—');
  assert.equal(barBeat(undefined), '—');
});

test('a bar starts where the bar line is', () => {
  assert.equal(quartersPerBar(COMMON_TIME), 4);
  assert.equal(quartersPerBar(), 4, 'a project without a signature is in 4/4');
  assert.equal(barStart(0), 0);
  assert.equal(barStart(3.99), 0);
  assert.equal(barStart(4), 4);
  assert.equal(barStart(10), 8);
  assert.equal(barStart(-5), 0, 'there is nothing before bar one');
  assert.equal(barStart(Number.NaN), 0);
});

test('stepping back from mid-bar lands on the bar you are in', () => {
  // The step that makes Back usable: pressed in the middle of bar three it
  // puts you at the top of bar three, pressed again it goes to bar two.
  assert.equal(barStep(10, -1), 8);
  assert.equal(barStep(8, -1), 4);
  assert.equal(barStep(4, -1), 0);
  // Forwards always crosses to the next line, wherever you are in the bar.
  assert.equal(barStep(10, 1), 12);
  assert.equal(barStep(8, 1), 12);
  assert.equal(barStep(0, 1), 4);
  // More than one bar at a time, and never off the front of the arrangement.
  assert.equal(barStep(40, -4), 24);
  assert.equal(barStep(40, 4), 56);
  assert.equal(barStep(2, -9), 0);
  assert.equal(barStep(0, -1), 0);
  // Nothing asked, nothing moved -- and a position that is already exact is
  // not snapped by a step of zero.
  assert.equal(barStep(10.5, 0), 10.5);
  assert.equal(barStep(10, Number.NaN), 10);
  assert.equal(barStep(Number.NaN, 1), 0);
});

test('the loop fields count bars as the ruler does: From 1 To 16 is sixteen bars', () => {
  // The author's report of 2026-09-26: "To 16" looped four bars, because the
  // fields showed quarters under a ruler numbered in bars.
  assert.deepEqual(loopRangeFromBars('1', '16'), { startPpq: 0, endPpq: 64 });
  assert.deepEqual(loopBars({ startPpq: 0, endPpq: 64 }), { from: 1, to: 16 });
  assert.deepEqual(loopRangeFromBars('5', '8'), { startPpq: 16, endPpq: 32 });
  // What a project saved before holds reads back as the bars it always played.
  assert.deepEqual(loopBars({ startPpq: 0, endPpq: 16 }), { from: 1, to: 4 });
  // A range off the bar lines, which the agent channel can set, shows its fraction.
  assert.deepEqual(loopBars({ startPpq: 1, endPpq: 6 }), { from: 1.25, to: 1.5 });
});

test('a loop typed backwards or half typed stays a loop', () => {
  assert.deepEqual(loopRangeFromBars('9', '3'), { startPpq: 32, endPpq: 36 }, 'a To before the From is the From bar alone');
  assert.deepEqual(loopRangeFromBars('4', '4'), { startPpq: 12, endPpq: 16 }, 'From 4 To 4 is bar four');
  assert.deepEqual(loopRangeFromBars('', '8', { startPpq: 16, endPpq: 64 }), { startPpq: 16, endPpq: 32 }, 'a cleared field keeps what the loop had');
  assert.deepEqual(loopRangeFromBars('0', '2'), { startPpq: 0, endPpq: 8 }, 'there is no bar before bar one');
});

const WALTZ = { numerator: 3, denominator: 4 };
const COMPOUND = { numerator: 6, denominator: 8 };
const SEVEN_EIGHT = { numerator: 7, denominator: 8 };
const TWELVE_EIGHT = { numerator: 12, denominator: 8 };

test('a bar lasts what its signature says, in quarters', () => {
  assert.equal(quartersPerBar(WALTZ), 3);
  assert.equal(quartersPerBar(COMPOUND), 3);
  assert.equal(quartersPerBar(SEVEN_EIGHT), 3.5, 'a bar that is not a whole number of quarters');
  assert.equal(quartersPerBar(TWELVE_EIGHT), 6);
  assert.equal(quartersPerBar({ numerator: 2, denominator: 2 }), 4);
  assert.equal(quartersPerBeat(COMPOUND), 0.5, 'the beat of 6/8 is the eighth');
  assert.equal(quartersPerBeat({ numerator: 5, denominator: 16 }), 0.25);
});

test('bar.beat counts the beats of the signature', () => {
  assert.equal(barBeat(3, WALTZ), '2.1');
  assert.equal(barBeat(8.5, WALTZ), '3.3');
  // In 6/8 the beat is an eighth: 1.5 quarters in is the fourth eighth.
  assert.equal(barBeat(1.5, COMPOUND), '1.4');
  assert.equal(barBeat(3, COMPOUND), '2.1');
  assert.equal(barBeat(3.4999, SEVEN_EIGHT), '1.7');
  assert.equal(barBeat(3.5, SEVEN_EIGHT), '2.1');
  // A double the engine reports a hair short of the bar line is the bar line.
  assert.equal(barBeat(6.9999999999, SEVEN_EIGHT), '3.1');
  assert.equal(barBeat(-1, WALTZ), '—');
});

test('the transport steps and the loop fields follow the signature', () => {
  assert.equal(barStart(10, WALTZ), 9);
  assert.equal(barStep(10, -1, WALTZ), 9);
  assert.equal(barStep(9, -1, WALTZ), 6);
  assert.equal(barStep(10, 1, WALTZ), 12);
  assert.equal(barStep(0, 3, SEVEN_EIGHT), 10.5);
  assert.equal(barStep(7, -1, SEVEN_EIGHT), 3.5, 'on a line, back goes to the bar before');
  assert.deepEqual(loopRangeFromBars('1', '4', {}, WALTZ), { startPpq: 0, endPpq: 12 });
  assert.deepEqual(loopBars({ startPpq: 6, endPpq: 24 }, TWELVE_EIGHT), { from: 2, to: 4 });
  // A loop drawn in 4/4 read after a change to 3/4 keeps its quarters and
  // shows where they now fall.
  assert.deepEqual(loopBars({ startPpq: 0, endPpq: 16 }, WALTZ), { from: 1, to: 5.333 });
});

test('a signature that is not one falls back whole', () => {
  assert.deepEqual(normalizeSignature({ numerator: 7, denominator: 8 }), SEVEN_EIGHT);
  assert.deepEqual(normalizeSignature(null), COMMON_TIME);
  assert.deepEqual(normalizeSignature({ numerator: 7, denominator: 3 }), COMMON_TIME, '7/3 is not repaired into 7/4');
  assert.deepEqual(normalizeSignature({ numerator: 0, denominator: 4 }), COMMON_TIME);
  assert.deepEqual(normalizeSignature({ numerator: 33, denominator: 4 }), COMMON_TIME);
  assert.deepEqual(normalizeSignature({ numerator: 2.5, denominator: 4 }), COMMON_TIME);
  assert.deepEqual(normalizeSignature({ numerator: '5', denominator: '4' }), { numerator: 5, denominator: 4 });
  assert.deepEqual(normalizeSignature({ numerator: 9 }, WALTZ), WALTZ, 'the fallback is the one given');
  assert.equal(formatSignature(TWELVE_EIGHT), '12/8');
  assert.deepEqual(parseSignature(' 6 / 8 '), COMPOUND);
  assert.equal(parseSignature('6/7'), null);
  assert.equal(parseSignature('four'), null);
});
