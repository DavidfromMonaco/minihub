/**
 * Hold a number inside a range. One implementation, because there were five.
 *
 * A one-line helper copied five times is usually harmless, and this one was
 * not: three of the copies were identical and two were NOT. `sequencerModel`
 * coerced its argument first and `omniPearl` clamped to 0..1 — both named
 * `clamp`, both doing something the other does not. Reading `clamp(x, 0, 1)`
 * in one file told you nothing about what `clamp(x, 0, 1)` did in the next.
 *
 * So the rule this file exists to hold: `clamp` means exactly this, and a
 * variant says what it adds in its own name (`clampFinite`, `clamp01`) and is
 * built on top rather than beside.
 *
 * `NaN` is deliberately not handled here. `Math.min`/`Math.max` propagate it,
 * which is the honest answer for a function that was handed a non-number; the
 * callers that read from disk or from the DOM coerce first, and they say so.
 */
export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
