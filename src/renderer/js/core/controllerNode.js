/**
 * Which routing node is the controller, and what to call it in front of the
 * user.
 *
 * Three unrelated places show the user's keyboard by name -- the header's
 * connection status, the sequencer's "connect this before recording" messages,
 * and the Learn panel's instruction -- and each of them spelled "MiniLab 3"
 * itself. Three copies of a device name are three things to find the day
 * someone plugs in something else, and a copy that is missed does not look like
 * a bug: it is a sentence telling a user to connect hardware he does not own.
 *
 * WHY THE NETWORK AND NOT THE PROFILE
 * -----------------------------------
 * The loaded profile knows the device's name, and reading it here would be
 * shorter. It would also be a second source for one string. Every one of these
 * messages is sent to look at the Patch Bay card, so the name in the message has
 * to be the name ON that card -- `modules/minilab/minilabModule.js` is where the
 * node takes its name from the profile, and everything else asks the network.
 * One consequence worth stating: this makes the chain testable end to end. A
 * profile-derived constant is fixed at module load and no test can swap it (see
 * this workstream's step 3); a node is an argument, and a fixture can name it
 * anything.
 *
 * WHY NULL RATHER THAN A FALLBACK NAME
 * ------------------------------------
 * Two hardware MIDI sources means naming one of them is a guess, and a message
 * that guesses sends the user to the wrong card. DECISIONS.md D-022 says there
 * is exactly one controller until a second keyboard exists, so the plural and
 * the empty cases answer null and each caller phrases its own fallback -- "your
 * controller" reads as English inside a sentence and as gibberish inside
 * "No ... detected".
 */

/**
 * The shape of a hardware MIDI endpoint that sends. `midi-output` is MiniHub's
 * node type for physical MIDI (`network.js` exempts it from cycle detection for
 * that reason), and the `midi-out` port is the side carrying what the hardware
 * plays: the same type with only a `midi-in` is an external destination, which
 * is not a controller and can never be a recording source.
 */
export const isControllerNode = (node) => node?.type === 'midi-output'
  && Array.isArray(node.outputs) && node.outputs.some((port) => port.id === 'midi-out');

/** The controller's name as the Patch Bay shows it, or null when there is not
 *  exactly one to name. */
export function controllerName(network) {
  const sources = (network?.listNodes?.() ?? []).filter(isControllerNode);
  return sources.length === 1 ? (sources[0].name ?? null) : null;
}
