/**
 * An audio clip's fades, as Reaper draws and plays them (D-062).
 *
 * A fade is a length in seconds -- it belongs to the sound, which a tempo
 * change stretches in quarters but not in time -- a shape, a curvature the
 * hand bends by dragging the curve, and an optional low-pass sweep. The
 * shapes are Reaper's seven, in Reaper's order, because the author asked for
 * "exactly the same" and a musician arrives with that menu in their hands.
 *
 * The arithmetic is written twice, here and in `native/audio-engine/src/
 * fade_shape.h`, because the drawing and the sound must agree to the sample
 * and a process boundary lies between them. The tests pin both to the same
 * values; change one, change the other.
 */

export const FADE_SHAPES = Object.freeze([
  'Linear',
  'Fast start',
  'Slow start',
  'Fast start, steep',
  'Slow start, steep',
  'S-curve',
  'S-curve, steep'
]);

/** A new fade's shape: Reaper's default, the second in its menu. */
export const DEFAULT_FADE_SHAPE = 1;

/** Curvature, -1 (sagging) to 1 (bulging); 0 is the shape as drawn. */
export const FADE_CURVE_LIMIT = 1;

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));

/** A shape's gain at `x`, 0 at the silent end to 1 at full level. */
export function fadeShapeGain(shape, x) {
  const t = clamp01(x);
  switch (Number(shape)) {
    case 1: return 1 - (1 - t) ** 2;
    case 2: return t ** 2;
    case 3: return 1 - (1 - t) ** 4;
    case 4: return t ** 4;
    case 5: return t * t * (3 - 2 * t);
    case 6: return t < 0.5 ? 8 * t ** 4 : 1 - 8 * (1 - t) ** 4;
    default: return t;
  }
}

/**
 * The gain of a fade at `x`, the shape bent by its curvature: raised to
 * 4^-curve, so +1 bulges it up (a quarter power), -1 sags it (a fourth), and
 * 0 leaves it alone. The ends stay at 0 and 1 whatever the curve.
 */
export function fadeGain(shape, curve, x) {
  const bend = Math.max(-FADE_CURVE_LIMIT, Math.min(FADE_CURVE_LIMIT, Number(curve) || 0));
  return fadeShapeGain(shape, x) ** (4 ** -bend);
}

/** A fade made safe: a length that is not negative, a known shape, a bounded curve. */
export function normalizeFade(value) {
  const seconds = Number(value?.seconds);
  const shape = Number(value?.shape);
  return {
    seconds: Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) : 0,
    shape: Number.isInteger(shape) && shape >= 0 && shape < FADE_SHAPES.length ? shape : DEFAULT_FADE_SHAPE,
    curve: Math.max(-FADE_CURVE_LIMIT, Math.min(FADE_CURVE_LIMIT, Number(value?.curve) || 0)),
    lowPass: value?.lowPass === true
  };
}

/**
 * Both fades of a clip that plays `durationSeconds`, fitted into it: they may
 * meet, never cross. The fade-in keeps its length and the fade-out gives
 * way, which is what a drag of either edge then feels like -- the fade you
 * are not touching never jumps.
 */
export function fitFades(fadeIn, fadeOut, durationSeconds) {
  const duration = Math.max(0, Number(durationSeconds) || 0);
  const inFade = normalizeFade(fadeIn);
  const outFade = normalizeFade(fadeOut);
  inFade.seconds = Math.min(inFade.seconds, duration);
  outFade.seconds = Math.min(outFade.seconds, Math.max(0, duration - inFade.seconds));
  return { fadeIn: inFade, fadeOut: outFade };
}

/**
 * A fade as SVG paths in a 100 by 100 box stretched over it: the curve, and
 * the area it takes away from the sound, shaded as Reaper shades it. `in`
 * rises left to right, `out` falls.
 */
export function fadePaths(fade, direction = 'in', points = 32) {
  const coordinates = [];
  for (let index = 0; index <= points; index += 1) {
    const x = index / points;
    const gain = fadeGain(fade.shape, fade.curve, direction === 'in' ? x : 1 - x);
    coordinates.push(`${(x * 100).toFixed(2)} ${((1 - gain) * 100).toFixed(2)}`);
  }
  const line = `M${coordinates.join(' L')}`;
  const shade = direction === 'in' ? `${line} L0 0 Z` : `${line} L100 0 Z`;
  return { line, shade };
}

/** A shape's picture for its menu entry, in a 24 by 12 box, the way it faces. */
export function fadeShapeIcon(shape, direction = 'in', points = 16) {
  const coordinates = [];
  for (let index = 0; index <= points; index += 1) {
    const x = index / points;
    const gain = fadeShapeGain(shape, direction === 'in' ? x : 1 - x);
    coordinates.push(`${(x * 24).toFixed(2)} ${((1 - gain) * 12).toFixed(2)}`);
  }
  return `M0 12 L${coordinates.join(' L')} L24 12 Z`;
}

/**
 * The low-pass fade's cutoff for a fade gain: 20 Hz silent, 20 kHz at full
 * level, exponentially between -- a sweep the ear hears as even.
 */
export function lowPassCutoffHz(gain) {
  return 20 * 1000 ** clamp01(gain);
}

/*
 * Where the hand takes a fade, in pixels. One copy for the two places a take
 * is drawn -- the arrangement's clip, in quarters, and the Clip Editor's
 * waveform, in seconds -- so a fade is grabbed the same way in both: each
 * says how many pixels a second is, and measures from where the sound starts.
 */
export const FADE_GRAB_PX = 6;
export const FADE_TOP_PX = 10;

/** Both fades' lengths in pixels, over a sound `width` pixels long. */
export function fadeSpans(clip, pxPerSecond, width) {
  const perSecond = Math.max(0, Number(pxPerSecond) || 0);
  return {
    in: Math.min(width, (Number(clip?.fadeIn?.seconds) || 0) * perSecond),
    out: Math.min(width, (Number(clip?.fadeOut?.seconds) || 0) * perSecond)
  };
}

/**
 * What the hand is over, in a sound `width` by `height`: a fade's length
 * (`in-length`, `out-length`) at the top, where a fade ends or where one can
 * begin, or its curve (`in-curve`, `out-curve`) within a few pixels of it.
 */
export function fadeZone(clip, pxPerSecond, width, height, x, y) {
  const px = fadeSpans(clip, pxPerSecond, width);
  const inEnd = px.in;
  const outStart = width - px.out;
  if (y <= FADE_TOP_PX) {
    const toIn = Math.abs(x - inEnd);
    const toOut = Math.abs(x - outStart);
    if (Math.min(toIn, toOut) <= FADE_GRAB_PX) return toIn <= toOut ? 'in-length' : 'out-length';
  }
  if (px.in > 0 && x >= 0 && x <= inEnd) {
    const gain = fadeGain(clip.fadeIn.shape, clip.fadeIn.curve, x / inEnd);
    if (Math.abs(y - (1 - gain) * height) <= FADE_GRAB_PX) return 'in-curve';
  }
  if (px.out > 0 && x >= outStart && x <= width) {
    const gain = fadeGain(clip.fadeOut.shape, clip.fadeOut.curve, (width - x) / px.out);
    if (Math.abs(y - (1 - gain) * height) <= FADE_GRAB_PX) return 'out-curve';
  }
  return '';
}

/** Which fade `x` is inside, for its menu: `in`, `out`, or none. */
export function fadeRegion(clip, pxPerSecond, width, x) {
  const px = fadeSpans(clip, pxPerSecond, width);
  if (px.in > 0 && x <= px.in) return 'in';
  if (px.out > 0 && x >= width - px.out) return 'out';
  return '';
}

/**
 * A fade's length or curve after a drag of `dx`, `dy` pixels from where it was
 * taken: a length follows the hand sideways, toward the middle for either
 * fade; a curve bends up as the hand rises, a full height from -1 to 1.
 */
export function fadeDragged(original, zone, dx, dy, pxPerSecond, height) {
  if (zone.endsWith('length')) {
    const secondsPerPx = 1 / Math.max(1e-9, Number(pxPerSecond) || 0);
    return { seconds: Math.max(0, original.seconds + (zone.startsWith('in') ? dx : -dx) * secondsPerPx) };
  }
  return { curve: Math.max(-FADE_CURVE_LIMIT, Math.min(FADE_CURVE_LIMIT, original.curve - (dy / Math.max(1, height)) * 2)) };
}
