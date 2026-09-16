import test from 'node:test';
import assert from 'node:assert/strict';
import { OneRingRandom, RANDOM_STREAM } from '../src/renderer/js/core/oneRingRandom.js';

// The same values native_tests.cpp checks in [core] one-ring-random: the two
// copies of the algorithm draw one sequence from one seed.

const hex = (value) => `0x${value.toString(16).padStart(16, '0')}`;

test('the draws are the engine\'s, bit for bit', () => {
  const probability = new OneRingRandom({ seed: 42, execution: 1, loop: 3, channel: 2, step: 12 }, RANDOM_STREAM.probability);
  assert.deepEqual([probability.next(), probability.next(), probability.next()].map(hex),
    ['0x346263f5bb0808f3', '0xe895a41e11708f92', '0xea10d451f0cdc0be']);
  const value = new OneRingRandom({ seed: 123 }, RANDOM_STREAM.value);
  assert.deepEqual([value.next(), value.next(), value.next()].map(hex),
    ['0x03377d64b3650c92', '0x0ad518c59166bfb5', '0x15c660c09fec3fac']);
  const humanize = new OneRingRandom({ seed: 0 }, RANDOM_STREAM.humanize);
  assert.deepEqual([humanize.unit(), humanize.unit(), humanize.unit()],
    [0.068585551244810583, 0.78030197182278149, 0.19742007130653372]);
  const mutation = new OneRingRandom({ seed: 7, execution: 2, loop: 5, channel: 15, step: 63 }, RANDOM_STREAM.mutation);
  assert.deepEqual([mutation.below(101), mutation.below(101), mutation.below(101)], [79n, 57n, 17n]);
});

test('a key at its limits wraps as the engine\'s unsigned integers do', () => {
  const most = '18446744073709551615';
  const extremes = new OneRingRandom({ seed: most, execution: most, loop: most, channel: 4294967295, step: 4294967295 },
    RANDOM_STREAM.humanize);
  assert.equal(hex(extremes.next()), '0x47ea9131a4086e02');
});

test('a seed reads the same as a number, a BigInt or the string a project saves', () => {
  const draw = (seed) => new OneRingRandom({ seed, execution: 3 }, RANDOM_STREAM.value).next();
  assert.equal(draw(99), draw(99n));
  assert.equal(draw(99), draw('99'));
  assert.notEqual(draw(99), draw(100));
});

test('probability is never at 0 and always at 100, and below() stays under its bound', () => {
  const random = new OneRingRandom({ seed: 5 }, RANDOM_STREAM.probability);
  for (let i = 0; i < 200; i += 1) {
    assert.equal(random.probability(0), false);
    assert.equal(random.probability(100), true);
    assert.ok(random.below(7) < 7n);
  }
  assert.equal(random.below(0), 0n);
  assert.equal(random.probability(Number.NaN), false);
});
