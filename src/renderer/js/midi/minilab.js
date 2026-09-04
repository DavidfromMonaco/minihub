/**
 * The three questions `MidiManager` asks about a MIDI port, answered by the
 * loaded profile instead of by a regular expression.
 *
 * This file used to hold the ranking itself: `/minilab/i` for "is this the
 * controller", `\b(mcu|hui|din\s*thru)\b` for "can it carry what is played",
 * and a five-branch score for "which one do we arm". Those three regular
 * expressions were the last place in the MIDI layer where the application knew
 * a device by name -- Etape A turned the MiniLab 3 into a file, and left this
 * behind because the profile field that replaces it, `device.ports[]`, was
 * written and validated but read by nobody.
 *
 * It is read now, by `portRoles.js`. What is left here is the adapter: the
 * three exported names `MidiManager` calls, bound to the one profile that
 * ships. The names are kept exactly as they were so that this change moves no
 * caller; what changed is that none of them can answer without the profile.
 */
import { resolvePortRole, isPerformancePort, bestPerformancePort } from './portRoles.js';
import profile from './profiles/minilab-3.json' with { type: 'json' };

/** True when the profile recognises this port as one of the controller's own. */
export function isMiniLabName(name) {
  return resolvePortRole(profile, name) !== null;
}

/**
 * True when a port can actually deliver what the user plays. A control-surface
 * or pass-through port cannot, no matter how much its name looks like the
 * device's.
 */
export function isPerformanceInputName(name) {
  return isPerformancePort(profile, name);
}

/**
 * Rank a port for auto-selection. Higher wins, 0 for a port the profile does
 * not declare.
 *
 * The number is the profile's `priority` verbatim, which is why a rank now says
 * nothing about whether a port may be armed: the MiniLab 3's pass-through port
 * declares priority 0, the same as a stranger's keyboard. That question belongs
 * to `role`, and `isPerformanceInputName` is where it is asked.
 */
export function miniLabScore(name) {
  return resolvePortRole(profile, name)?.priority ?? 0;
}

/** Of these ports, the one to arm. See `bestPerformancePort`. */
export function bestMiniLabInput(ports) {
  return bestPerformancePort(profile, ports);
}
