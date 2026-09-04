/**
 * Port roles: which of a controller's MIDI ports can carry what is played.
 *
 * A controller rarely exposes one input. The MiniLab 3 exposes four on Windows
 * and only two of them ever carry a played note; the other two are a DAW
 * control surface and a 5-pin pass-through. Ranking them alike armed whichever
 * one the operating system enumerated first, and every key press was then
 * discarded as coming from an unselected input.
 *
 * That ranking used to be a regular expression over the word "minilab". It is
 * now `device.ports[]` in the profile -- specification section 4.2 -- and this
 * file is what reads it. Nothing here knows a device: the profile arrives as an
 * argument and is never imported, which is the entire difference between "works
 * with the MiniLab" and "works with the controller that is loaded".
 *
 * MATCHING, AND WHAT IT DELIBERATELY REFUSES TO DO
 * -----------------------------------------------
 * A declared port matches a physical one when the physical name CONTAINS the
 * declared name, both lower-cased with their whitespace removed.
 *
 * Containment rather than equality, because the operating system decorates: the
 * port one machine calls "Minilab3 MIDI" is handed back as "MIDIIN2 (Minilab3
 * MIDI)" on another. Whitespace removed, because the same device is spelled
 * "Minilab3" by its driver and "MiniLab 3" by its manual, and a profile author
 * copies whichever one he is looking at.
 *
 * What it refuses is to guess. A port the profile does not declare belongs to no
 * profile: there is no fallback onto a resemblance to the vendor or the model
 * string. That is the point rather than a limitation -- a controller whose ports
 * are named otherwise is a profile to fix, as data, which is exactly what
 * DECISIONS.md D-020 bought. A heuristic fallback would put the old regular
 * expression back, one device at a time.
 *
 * TWO DECLARATIONS MATCHING ONE PORT
 * ----------------------------------
 * Legitimate: a profile may declare "Minilab3" alongside "Minilab3 MIDI". The
 * longer declaration wins, because it is the more specific identification, and
 * ties fall back to declaration order. Resolving it by array position alone
 * would decide by accident, which is what the validator already refuses for two
 * bindings answering one message.
 */

/** Specification section 4.2. A port with this role is the only one that can be armed. */
const PERFORMANCE = 'performance';

/**
 * Comparable form of a port name. Lower case answers the driver that shouts;
 * removing whitespace answers "Minilab3" versus "MiniLab 3", which is the one
 * variation observed between a device's driver and its own documentation.
 */
function comparable(value) {
  return typeof value === 'string' ? value.toLowerCase().replace(/\s+/g, '') : '';
}

/**
 * Which declared port is this physical port, according to this profile?
 *
 * Returns the declaration -- `{ role, priority, note }` -- or null when the
 * profile does not describe this port at all. Null is not "unknown role": it is
 * "not this controller", and the two callers that matter treat it that way.
 */
export function resolvePortRole(profile, portName) {
  const name = comparable(portName);
  if (!name) return null;
  const ports = profile?.device?.ports;
  if (!Array.isArray(ports)) return null;

  let best = null;
  let bestLength = 0;
  for (const port of ports) {
    const declared = comparable(port?.match?.name);
    if (!declared || declared.length <= bestLength || !name.includes(declared)) continue;
    best = port;
    bestLength = declared.length;
  }
  if (!best) return null;
  return Object.freeze({
    role: best.role,
    priority: Number.isInteger(best.priority) ? best.priority : 0,
    note: typeof best.note === 'string' ? best.note : ''
  });
}

/**
 * Can this port deliver what the user plays?
 *
 * The question `role` exists to answer, and the one a name cannot: a
 * control-surface port carries transport and faders, a pass-through port
 * carries another instrument's traffic, and both are named after the device
 * just as convincingly as the musical port is.
 */
export function isPerformancePort(profile, portName) {
  return resolvePortRole(profile, portName)?.role === PERFORMANCE;
}

/**
 * Of these physical ports, the one to arm -- or null when none of them can
 * carry a note.
 *
 * Two rules, and the second one is the one that was missing. Rank by
 * `priority`, highest first; but consider only a `performance` port, because
 * priority cannot express "never". When the pass-through port is the only one a
 * machine enumerates it is by definition the highest-ranked port present, and
 * arming it selects an input that will never deliver anything.
 *
 * Ties keep enumeration order: a profile that ranks two ports equally has said
 * it does not care, and inventing a preference here would be deciding by
 * accident on its behalf.
 *
 * `ports` is anything with a `name`; the caller's own objects are returned
 * untouched, so it stays free to carry an id, a manufacturer, or a live Web MIDI
 * port alongside.
 */
export function bestPerformancePort(profile, ports) {
  let best = null;
  let bestPriority = -1;
  for (const port of ports ?? []) {
    const declared = resolvePortRole(profile, port?.name);
    if (declared?.role !== PERFORMANCE || declared.priority <= bestPriority) continue;
    best = port;
    bestPriority = declared.priority;
  }
  return best;
}
