/**
 * One answer to "is this the same physical port".
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A Web MIDI id is not stable. On 2026-09-07 the same MiniLab 3 enumerated as
 * `input-2`, then `input-0`, then `input-2` again across three launches of this
 * application on this machine. Anything that stores a bare id and compares it
 * later is therefore storing a number that means something else tomorrow.
 *
 * `MidiManager` already solved that for the global selection by storing a
 * DESCRIPTOR -- name, manufacturer, type -- and matching on it. The sequencer
 * stored a bare `track.inputId` and did not, which is why an armed MIDI track
 * stopped matching the selected port after a relaunch and answered with
 * "The armed MIDI track Input must match the MIDI port selected for ...".
 *
 * Both now ask this module. That is the point of the module: two
 * implementations of "same physical port" disagree the day a port is renamed,
 * and the disagreement surfaces as a track that is armed on the wrong device.
 */

function normalizedIdentityText(value) {
  return String(value || '').trim().toLocaleLowerCase();
}

/**
 * Accept a descriptor that arrived from disk.
 *
 * Settings and project files are written by earlier versions and can be edited
 * by hand, so every field is re-typed and bounded here rather than trusted.
 * Returns null for anything that could not identify a port at all.
 */
export function normalizePortPreference(value) {
  if (!value || typeof value !== 'object') return null;
  const field = (name, max) => typeof value[name] === 'string' && value[name].length <= max
    ? value[name] : '';
  const id = field('id', 256);
  const name = field('name', 256);
  const manufacturer = field('manufacturer', 256);
  const type = field('type', 32) || 'input';
  if (!id && !name) return null;
  return { id, name, manufacturer, type };
}

/** The descriptor to store for a port that is on the desk right now. */
export function preferenceForPort(port) {
  return {
    id: port.id,
    name: port.name || '',
    manufacturer: port.manufacturer || '',
    type: port.type || 'input'
  };
}

/** Does this live port describe the same hardware the descriptor was taken from? */
export function samePhysicalPort(port, preference) {
  return normalizedIdentityText(port?.name) === normalizedIdentityText(preference?.name)
    && normalizedIdentityText(port?.manufacturer) === normalizedIdentityText(preference?.manufacturer)
    && normalizedIdentityText(port?.type || 'input') === normalizedIdentityText(preference?.type || 'input');
}

/**
 * Find the live port a stored descriptor points at, or null.
 *
 * The id is tried first and only counts when the fingerprint agrees with it:
 * an id alone can now belong to a different device. A descriptor with no name
 * is a legacy id-only setting -- it has no fingerprint to check, so the id is
 * all there is, and the caller is expected to write a real descriptor back the
 * moment it resolves.
 */
export function resolvePortPreference(preference, ports) {
  if (!preference) return null;
  const list = Array.isArray(ports) ? ports : [...ports];
  const exact = preference.id ? list.find((port) => port.id === preference.id) : null;
  if (exact && (!preference.name || samePhysicalPort(exact, preference))) return exact;
  if (!preference.name) return null;
  return list.find((port) => samePhysicalPort(port, preference)) || null;
}
