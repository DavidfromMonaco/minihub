/**
 * MiniLab 3 identification helpers.
 *
 * The MiniLab 3 does not expose one MIDI input - on Windows it exposes four,
 * and only some of them carry what you play:
 *
 *   "Minilab3 MIDI"      keys, pads, encoders          <- performance MIDI
 *   "Minilab3 ALV"       dedicated Analog Lab channel  <- performance MIDI
 *   "Minilab3 MCU/HUI"   DAW control surface           <- transport/faders only
 *   "Minilab3 DIN THRU"  5-pin DIN pass-through        <- nothing of ours
 *
 * Scoring them all the same meant the first one enumerated (MCU/HUI) was
 * selected, and every key press was filtered out as coming from an unselected
 * input. Ports are therefore ranked by ROLE, not just by name matching.
 */
export function isMiniLabName(name) {
  return /minilab/i.test(name || '');
}

export function isMiniLab3Name(name) {
  return /minilab\s*3/i.test(name || '');
}

/** Ports that exist on the device but never carry played notes. */
const CONTROL_ONLY = /\b(mcu|hui|din\s*thru|thru)\b/i;

/**
 * True when a port can actually deliver what the user plays. A control-surface
 * or DIN-thru port cannot, no matter how much its name looks like a MiniLab.
 */
export function isPerformanceInputName(name) {
  return isMiniLabName(name) && !CONTROL_ONLY.test(name || '');
}

/**
 * Rank a port for auto-selection. Higher wins.
 *   0  not a MiniLab
 *   1  MiniLab, but control-surface / DIN thru: cannot send played notes
 *   3  dedicated Analog Lab port: real performance MIDI, app-specific
 *   4  the plain musical port
 *   5  the plain musical port of a MiniLab 3
 */
export function miniLabScore(name) {
  const n = (name || '').toLowerCase();
  if (!n.includes('minilab')) return 0;
  if (CONTROL_ONLY.test(n)) return 1;
  if (/\balv\b|analog\s*lab/.test(n)) return 3;
  return n.includes('3') ? 5 : 4;
}
