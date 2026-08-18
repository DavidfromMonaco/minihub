/**
 * MiniLab 3 identification helpers.
 *
 * The MiniLab 3 enumerates as a USB MIDI device; on Windows its port name
 * typically contains "MiniLab 3" or "Arturia MiniLab 3". We match on a
 * case-insensitive "minilab" token and prefer the "3" variant when present.
 */
export function isMiniLabName(name) {
  return /minilab/i.test(name || '');
}

export function isMiniLab3Name(name) {
  return /minilab\s*3/i.test(name || '');
}

/** Score a port name for how strongly it looks like a MiniLab 3. */
export function miniLabScore(name) {
  const n = (name || '').toLowerCase();
  if (!n.includes('minilab')) return 0;
  return n.includes('3') ? 2 : 1;
}
