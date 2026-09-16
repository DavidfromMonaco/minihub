/**
 * One Ring's random draws, bit for bit the engine's
 * (native/audio-engine/src/one_ring/generative.cpp).
 *
 * WHY THE SAME ALGORITHM ON BOTH SIDES
 * ------------------------------------
 * A seed saved in a project replays one sequence. The scheduler draws in the
 * engine; MUTATE and NEW SEED rewrite the sequence here, where it is edited and
 * saved. If the two walked different algorithms, a MUTATE would not be the one a
 * VST state with the same seed and mutation count describes.
 *
 * WHY BIGINT
 * ----------
 * The algorithm is 64-bit integer arithmetic and a JavaScript number holds 53
 * bits. The draws are few -- a handful per cell, on a click -- so BigInt costs
 * nothing that matters. test/oneRingRandom.test.mjs checks the values the native
 * tests check.
 */

const MASK = (1n << 64n) - 1n;
const GOLDEN_GAMMA = 0x9e3779b97f4a7c15n;
const TWO_TO_THE_64 = 1n << 64n;

/** The stream a draw belongs to: unrelated draws never share a sequence. */
export const RANDOM_STREAM = Object.freeze({ probability: 1n, value: 2n, mutation: 3n, humanize: 4n });

function mix(input) {
  let value = input;
  value = ((value ^ (value >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
  value = ((value ^ (value >> 27n)) * 0x94d049bb133111ebn) & MASK;
  return value ^ (value >> 31n);
}

const unsigned = (value, bits) => BigInt.asUintN(bits, BigInt(value));

export class OneRingRandom {
  /**
   * `seed`, `execution` and `loop` are 64-bit, `channel` and `step` 32-bit, as
   * numbers, BigInts or decimal strings -- a saved seed is a string.
   */
  constructor({ seed = 0n, execution = 0n, loop = 0n, channel = 0, step = 0 } = {}, stream) {
    let state = mix(unsigned(seed, 64));
    for (const part of [unsigned(execution, 64), unsigned(loop, 64), unsigned(channel, 32),
      unsigned(step, 32), BigInt(stream)]) {
      state = mix((state + part) & MASK);
    }
    this.state = state;
  }

  /** The next 64-bit draw, as a BigInt. */
  next() {
    this.state = (this.state + GOLDEN_GAMMA) & MASK;
    return mix(this.state);
  }

  /** A number in [0, 1), from the top 53 bits of a draw. */
  unit() {
    return Number(this.next() >> 11n) * 2 ** -53;
  }

  /** A BigInt in [0, bound). Rejection keeps it unbiased, in at most nine draws. */
  below(bound) {
    const limit = BigInt(bound);
    if (limit <= 0n) return 0n;
    const threshold = (TWO_TO_THE_64 - limit) % limit;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const value = this.next();
      if (value >= threshold) return value % limit;
    }
    return this.next() % limit;
  }

  /** True with the given chance, in percent. */
  probability(percent) {
    if (!Number.isFinite(percent) || percent <= 0) return false;
    if (percent >= 100) return true;
    return this.unit() * 100 < percent;
  }
}
