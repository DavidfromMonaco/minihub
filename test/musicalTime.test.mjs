import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QUARTERS_PER_BAR, barBeat, barStart, barStep } from '../src/renderer/js/core/musicalTime.js';

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
  assert.equal(QUARTERS_PER_BAR, 4);
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
