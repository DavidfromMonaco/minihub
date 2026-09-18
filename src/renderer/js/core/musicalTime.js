/**
 * Musical time, written and stepped the same way everywhere.
 *
 * Positions inside MiniHub are counted in quarters -- `ppqPosition` from the
 * engine, `startPpq` on a clip, `beat` from a One Ring node -- and two places
 * already turned one into a bar and a beat with the same arithmetic spelled
 * twice. A third was about to: the header's position readout. One spelling, or
 * the day a time signature stops being 4/4 the shell and the node disagree
 * about which bar is playing.
 *
 * Everything here is pure and takes quarters. It says nothing about the
 * transport -- what a position MEANS is `SequencerController`'s business.
 */

/**
 * Quarters in a bar.
 *
 * Four, because the engine's playhead declares 4/4 and nothing in MiniHub
 * offers another signature (`Transport::getPosition`, which sets
 * `signature.numerator = 4`). It is named rather than written as `4` so that
 * the day a signature becomes a project property, this is the one place that
 * has to learn it -- and so that a `4` in a formula is not mistaken for a
 * quarter note.
 */
export const QUARTERS_PER_BAR = 4;

/** The quarter the bar containing `quarters` starts on. */
export function barStart(quarters) {
  const q = Number(quarters);
  if (!Number.isFinite(q) || q <= 0) return 0;
  return Math.floor(q / QUARTERS_PER_BAR) * QUARTERS_PER_BAR;
}

/**
 * A position written as `bar.beat`, both counted from one.
 *
 * Returns an em dash for a position there is no answer for, which is what the
 * One Ring panel showed for a node the engine does not hold: a readout that
 * says `1.1` when nothing is running is worse than one that says nothing.
 */
export function barBeat(quarters) {
  const q = Number(quarters);
  if (!Number.isFinite(q) || q < 0) return '—';
  const bar = Math.floor(q / QUARTERS_PER_BAR) + 1;
  const beat = Math.floor(q % QUARTERS_PER_BAR) + 1;
  return `${bar}.${beat}`;
}

/**
 * Where a step of `bars` from `quarters` lands, on a bar line.
 *
 * Backwards from the middle of a bar lands on that bar's own line rather than
 * the one before it -- the step a media player's rewind takes, and the one
 * that makes "back" usable: pressed once it puts you at the top of the bar
 * you are in, pressed again it goes back a bar. Forwards always crosses to
 * the next line. Never negative: bar one is the beginning.
 */
export function barStep(quarters, bars) {
  const q = Number(quarters);
  const count = Math.trunc(Number(bars));
  if (!Number.isFinite(q) || !Number.isFinite(count) || count === 0) {
    return Math.max(0, Number.isFinite(q) ? q : 0);
  }
  const start = barStart(q);
  // Mid-bar, the first step back is the distance already travelled into it.
  const from = count < 0 && q > start ? start + QUARTERS_PER_BAR : start;
  return Math.max(0, from + count * QUARTERS_PER_BAR);
}
