/**
 * Musical time, written and stepped the same way everywhere.
 *
 * Positions inside MiniHub are counted in quarters -- `ppqPosition` from the
 * engine, `startPpq` on a clip, `beat` from a One Ring node -- and two places
 * already turned one into a bar and a beat with the same arithmetic spelled
 * twice. A third was about to: the header's position readout. One spelling, or
 * the shell and the node disagree about which bar is playing.
 *
 * Everything here is pure and takes quarters, plus the time signature that
 * says how many of them make a bar. It says nothing about the transport --
 * what a position MEANS is `SequencerController`'s business, and so is which
 * signature is in force (D-059).
 */

/**
 * The signature a project without one is in, and the one every function here
 * falls back to. A caller that forgets to pass the project's signature is
 * therefore wrong only in a project that is not in 4/4 -- which is why every
 * caller in the renderer passes it, and the tests look for the ones that
 * do not.
 */
export const COMMON_TIME = Object.freeze({ numerator: 4, denominator: 4 });

/** Beats a bar may hold. 32 covers every signature a score writes. */
export const SIGNATURE_NUMERATOR_MAX = 32;

/**
 * The note values a beat may be. What the other workstations offer, less the
 * whole note: a bar counted in whole notes is a 4/4 bar nobody writes that way.
 */
export const SIGNATURE_DENOMINATORS = Object.freeze([2, 4, 8, 16]);

/**
 * A signature made safe to compute with. Anything that is not one -- a
 * project from before signatures, a hand-edited file, a request from the
 * agent channel -- becomes `fallback`, whole: a valid numerator is not kept
 * over an invalid denominator, since "7/3" repaired to "7/4" is a signature
 * nobody asked for.
 */
export function normalizeSignature(value, fallback = COMMON_TIME) {
  const numerator = Number(value?.numerator);
  const denominator = Number(value?.denominator);
  if (Number.isInteger(numerator) && numerator >= 1 && numerator <= SIGNATURE_NUMERATOR_MAX
      && SIGNATURE_DENOMINATORS.includes(denominator)) {
    return { numerator, denominator };
  }
  return fallback === COMMON_TIME ? { ...COMMON_TIME } : normalizeSignature(fallback, COMMON_TIME);
}

/** `"6/8"`, the way a score and the header write it. */
export function formatSignature(signature) {
  const { numerator, denominator } = normalizeSignature(signature);
  return `${numerator}/${denominator}`;
}

/** `"6/8"` read back, or null for text that is not a signature. */
export function parseSignature(text) {
  const match = /^\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*$/.exec(String(text ?? ''));
  if (!match) return null;
  const candidate = { numerator: Number(match[1]), denominator: Number(match[2]) };
  const normalized = normalizeSignature(candidate, { numerator: 0, denominator: 0 });
  return normalized.numerator === candidate.numerator && normalized.denominator === candidate.denominator
    ? normalized : null;
}

/** Quarters in one beat: the note value the denominator names. */
export function quartersPerBeat(signature = COMMON_TIME) {
  return 4 / normalizeSignature(signature).denominator;
}

/**
 * Quarters in a bar. Not always whole: a bar of 7/8 is three and a half, and
 * every function below works in fractions of a quarter for that reason.
 */
export function quartersPerBar(signature = COMMON_TIME) {
  const { numerator, denominator } = normalizeSignature(signature);
  return numerator * 4 / denominator;
}

// A position the engine reports is a double that reaches a bar line as
// 6.9999999998 as readily as 7: without the margin it would read as the last
// beat of the bar before.
const EPSILON = 1e-9;

/** The index of the bar holding `quarters`, counted from zero. */
function barIndex(q, bar) {
  return Math.floor(q / bar + EPSILON);
}

/** The quarter the bar containing `quarters` starts on. */
export function barStart(quarters, signature = COMMON_TIME) {
  const q = Number(quarters);
  if (!Number.isFinite(q) || q <= 0) return 0;
  const bar = quartersPerBar(signature);
  return barIndex(q, bar) * bar;
}

/**
 * A position written as `bar.beat`, both counted from one, the beat being the
 * signature's own -- an eighth in 6/8, as every workstation counts it.
 *
 * Returns an em dash for a position there is no answer for, which is what the
 * One Ring panel showed for a node the engine does not hold: a readout that
 * says `1.1` when nothing is running is worse than one that says nothing.
 */
export function barBeat(quarters, signature = COMMON_TIME) {
  const q = Number(quarters);
  if (!Number.isFinite(q) || q < 0) return '—';
  const { numerator } = normalizeSignature(signature);
  const bar = quartersPerBar(signature);
  const index = barIndex(q, bar);
  const into = Math.max(0, q - index * bar);
  const beat = Math.min(numerator, Math.floor(into / quartersPerBeat(signature) + EPSILON) + 1);
  return `${index + 1}.${beat}`;
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
export function barStep(quarters, bars, signature = COMMON_TIME) {
  const q = Number(quarters);
  const count = Math.trunc(Number(bars));
  if (!Number.isFinite(q) || !Number.isFinite(count) || count === 0) {
    return Math.max(0, Number.isFinite(q) ? q : 0);
  }
  const bar = quartersPerBar(signature);
  const start = barStart(q, signature);
  // Mid-bar, the first step back is the distance already travelled into it.
  const from = count < 0 && q > start + EPSILON ? start + bar : start;
  return Math.max(0, from + count * bar);
}

/**
 * A loop range as its From and To fields show it: the first bar and the last
 * bar it holds, both counted from one, as the ruler above the tracks counts
 * them. "From 1 To 16" is sixteen bars, quarters 0 to 64 in 4/4.
 *
 * The fields used to show the quarters themselves, under a ruler numbered in
 * bars, so "To 16" looped four bars. The export panel already said "bars 1 to
 * 16" of the same range: this is its reading, and the fields now agree with it.
 *
 * A range set in quarters that does not fall on bar lines (the agent channel's
 * `loop` can set one, and so does a change of signature) shows its fraction
 * rather than being rounded out of sight: three decimals of a bar, finer than
 * a sixteenth.
 */
export function loopBars(loop, signature = COMMON_TIME) {
  const round = (value) => Math.round(value * 1000) / 1000;
  const bar = quartersPerBar(signature);
  const startPpq = Math.max(0, Number(loop?.startPpq) || 0);
  const endPpq = Math.max(startPpq, Number(loop?.endPpq) || 0);
  return { from: round(startPpq / bar + 1), to: round(endPpq / bar) };
}

/**
 * The quarters a From and To typed in bars stand for. A To before the From
 * makes the loop the From bar alone; a field that is not a number keeps what
 * the loop had (`fallback`), so clearing a field does not move the loop.
 */
export function loopRangeFromBars(from, to, fallback = {}, signature = COMMON_TIME) {
  const read = (value) => (value === '' || value === null || value === undefined ? NaN : Number(value));
  const bar = quartersPerBar(signature);
  const kept = loopBars(fallback, signature);
  const fromBar = Math.max(1, Number.isFinite(read(from)) ? read(from) : kept.from);
  const toBar = Number.isFinite(read(to)) ? read(to) : kept.to;
  const startPpq = (fromBar - 1) * bar;
  return { startPpq, endPpq: Math.max(toBar * bar, startPpq + bar) };
}

/**
 * A track's meter: the signature changes it makes, each at one of ITS bars
 * (D-060). Polymetry is the point -- a track in 7/8 against the project's
 * 4/4 has bars of its own, which drift against the project's and meet them
 * again every 28 quarters -- so a change is placed by the track's bar number,
 * never by the project's. Before its first change a track counts the
 * project's signature, and a track with no change IS in the project's
 * signature, whatever it becomes.
 *
 * Kept by bar rather than by quarter because a change can only sit on one of
 * the track's own bar lines: stored in quarters, an edit to an earlier
 * change would leave the later ones in the middle of a bar.
 */
export const METER_CHANGES_MAX = 256;
const METER_BAR_MAX = 100000;

/** A meter made safe: valid changes only, one per bar, in bar order. */
export function normalizeMeter(value) {
  const byBar = new Map();
  for (const entry of Array.isArray(value) ? value : []) {
    const bar = Number(entry?.bar);
    if (!Number.isInteger(bar) || bar < 1 || bar > METER_BAR_MAX) continue;
    const signature = normalizeSignature(entry, { numerator: 0, denominator: 0 });
    if (signature.numerator !== Number(entry?.numerator) || signature.denominator !== Number(entry?.denominator)) continue;
    byBar.set(bar, { bar, ...signature });
  }
  return [...byBar.values()].sort((a, b) => a.bar - b.bar).slice(0, METER_CHANGES_MAX);
}

/**
 * The stretches of a track in which one signature holds, each from a bar
 * line: `{ startPpq, startBar, signature }`, `startBar` counted from one.
 * Everything below reads a track's bars through these.
 */
export function meterRegions(meter, projectSignature = COMMON_TIME) {
  const regions = [{ startPpq: 0, startBar: 1, signature: normalizeSignature(projectSignature) }];
  for (const change of normalizeMeter(meter)) {
    const last = regions.at(-1);
    const signature = { numerator: change.numerator, denominator: change.denominator };
    if (change.bar === last.startBar) { last.signature = signature; continue; }
    regions.push({
      startPpq: last.startPpq + (change.bar - last.startBar) * quartersPerBar(last.signature),
      startBar: change.bar,
      signature
    });
  }
  return regions;
}

function regionAt(regions, q) {
  let found = regions[0];
  for (const region of regions) {
    if (region.startPpq <= q + EPSILON) found = region;
    else break;
  }
  return found;
}

/** The track bar holding `quarters`: where it starts, how long it is, its number. */
export function meterBarAt(regions, quarters) {
  const q = Math.max(0, Number(quarters) || 0);
  const region = regionAt(regions, q);
  const length = quartersPerBar(region.signature);
  const index = barIndex(q - region.startPpq, length);
  return {
    startPpq: region.startPpq + index * length,
    lengthPpq: length,
    bar: region.startBar + index,
    signature: region.signature
  };
}

/** Where the track's bar `bar` (from one) starts, in quarters. */
export function meterBarPpq(regions, bar) {
  const wanted = Math.max(1, Math.trunc(Number(bar) || 1));
  let region = regions[0];
  for (const candidate of regions) if (candidate.startBar <= wanted) region = candidate;
  return region.startPpq + (wanted - region.startBar) * quartersPerBar(region.signature);
}

/**
 * `quarters` on the track's grid: the nearest bar line for `'bar'`, else the
 * nearest multiple of `step` counted from the bar it falls in -- a grid starts
 * again at every bar line, as in every workstation, which is what keeps a
 * quarter grid on the beats of a 7/8 bar that starts half a quarter late.
 * In a 4/4 track from zero it is the rounding it always was.
 */
export function meterSnap(regions, quarters, step) {
  const q = Math.max(0, Number(quarters) || 0);
  const bar = meterBarAt(regions, q);
  if (step === 'bar') {
    return q - bar.startPpq < bar.lengthPpq / 2 ? bar.startPpq : bar.startPpq + bar.lengthPpq;
  }
  const size = Number(step) > 0 ? Number(step) : 0.25;
  const snapped = bar.startPpq + Math.round((q - bar.startPpq) / size) * size;
  return Math.max(0, Math.min(snapped, bar.startPpq + bar.lengthPpq));
}

/**
 * The bar lines and signature changes between two positions, for drawing:
 * each region cut to the window, as `{ fromPpq, toPpq, signature, startPpq }`.
 */
export function meterSpans(regions, fromPpq, toPpq) {
  const spans = [];
  regions.forEach((region, index) => {
    const end = index + 1 < regions.length ? regions[index + 1].startPpq : Infinity;
    const from = Math.max(region.startPpq, fromPpq);
    const to = Math.min(end, toPpq);
    if (to > from) spans.push({ fromPpq: from, toPpq: to, startPpq: region.startPpq, signature: region.signature });
  });
  return spans;
}
