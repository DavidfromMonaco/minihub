/**
 * A pan as a strip reads it: C at the centre, L or R and how far, in percent
 * of the way to the end. One spelling for the Sequencer's tracks and the
 * Mixer's strips, which share one pan law in the engine (`pan_law.h`).
 */
export function formatPan(value) {
  const pan = Math.round(Math.max(-1, Math.min(1, Number(value) || 0)) * 100);
  return pan === 0 ? 'C' : `${pan < 0 ? 'L' : 'R'}${Math.abs(pan)}`;
}
