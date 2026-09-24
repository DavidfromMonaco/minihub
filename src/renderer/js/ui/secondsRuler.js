/**
 * The clock ruler over an audio take, down to the hundredth of a second.
 *
 * An audio take has no bars -- it is a file, measured in time -- so this
 * ruler is the only scale on screen and has to go as fine as the zoom does.
 * The arrangement's clock row reads the same ladder.
 */

/** Intervals a clock is read in: nobody counts in sevens, or in 0.07s. */
export const STRIDES = Object.freeze([0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600]);
/** `0:00.25` is a longer label than a bar number. */
const MIN_MARK_PX = 72;

/** Seconds between two marks, the finest rung that keeps labels apart. */
export function secondsStride(pxPerSecond) {
  const scale = Number(pxPerSecond);
  if (!Number.isFinite(scale) || scale <= 0) return STRIDES.at(-1);
  return STRIDES.find((stride) => stride * scale >= MIN_MARK_PX) ?? STRIDES.at(-1);
}

/**
 * A position as the ruler writes it: `m:ss`, with as many decimals as the
 * stride needs and no more.
 *
 * Rounded to that precision FIRST, then split into minutes and seconds --
 * splitting first is what prints `0:60.0` for 59.96 seconds.
 */
export function formatSeconds(seconds, stride = 1) {
  const decimals = stride >= 1 ? 0 : stride >= 0.1 ? 1 : 2;
  const scale = 10 ** decimals;
  const value = Math.max(0, Math.round((Number(seconds) || 0) * scale) / scale);
  const minutes = Math.floor(value / 60);
  const rest = (value - minutes * 60).toFixed(decimals);
  return `${minutes}:${rest.padStart(decimals ? 3 + decimals : 2, '0')}`;
}

/**
 * The marks that fall between `fromSeconds` and `toSeconds`, as positions in
 * seconds. Only those: at the finest zoom a long take has hundreds of
 * thousands of them, and a ruler draws what is on screen plus a margin.
 */
export function secondsMarks(fromSeconds, toSeconds, stride) {
  const step = Number(stride);
  if (!(step > 0) || !(toSeconds > fromSeconds)) return [];
  const first = Math.max(0, Math.ceil(fromSeconds / step));
  const last = Math.floor(toSeconds / step);
  const marks = [];
  // Multiplied, never accumulated: adding 0.01 a thousand times drifts.
  for (let index = first; index <= last && marks.length < 2000; index += 1) marks.push(index * step);
  return marks;
}
