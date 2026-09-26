/**
 * How a strip's values read -- a Sequencer track's and a Mixer strip's, which
 * the author asked to see written beside their sliders (2026-09-26). One
 * spelling for both, since both drive the same engine controls: a gain the
 * engine clamps to +6 dB (2.0), and a pan on one balance law (`pan_law.h`).
 */

/** A linear gain in dB, from -60 (read as silence) to +6. */
export const gainToDb = (gain) => (gain > 0
  ? Math.max(-60, Math.min(6, 20 * Math.log10(gain))) : -60);

export const dbToGain = (db) => (db <= -60 ? 0 : 10 ** (db / 20));

export function formatGainDb(gain) {
  const db = gainToDb(gain);
  return db <= -60 ? '−∞ dB' : `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
}

/** C at the centre, L or R and how far, in percent of the way to the end. */
export function formatPan(value) {
  const pan = Math.round(Math.max(-1, Math.min(1, Number(value) || 0)) * 100);
  return pan === 0 ? 'C' : `${pan < 0 ? 'L' : 'R'}${Math.abs(pan)}`;
}
