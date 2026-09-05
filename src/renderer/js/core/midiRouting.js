/**
 * Feeds incoming MIDI into the routing network, for the lifetime of the app.
 *
 * This used to live inside the MiniLab module's `mount()`, which tied signal
 * routing to UI focus: navigating away from the MiniLab page unsubscribed the
 * handler and MIDI silently stopped reaching every connected VST chain — you
 * could not play a plugin while looking at its own page. Routing must be
 * independent of which module is visible (that is the whole point of
 * `hub.network`), so the subscription is owned by the Hub instead.
 *
 * The MiniLab module still renders its own monitor/keyboard from the same
 * event; it just no longer owns the routing.
 */

import { CONTROLLER_NODE_IDS, isControllerNodeId } from './systemNodes.js';

/**
 * The node a raw MIDI message leaves by.
 *
 * `midiManager` stamps `profileId` on anything arriving on a port a loaded
 * profile claims. When nothing claims it -- the user selected a keyboard MiniHub
 * has no profile for -- it goes out of the first controller's node, which is
 * what the single-controller version did and what every saved project's cables
 * are drawn from.
 */
const nodeForMessage = (msg) =>
  (isControllerNodeId(msg?.profileId) ? msg.profileId : CONTROLLER_NODE_IDS[0]);

/** CC 123 (All Notes Off) then CC 120 (All Sound Off), for one channel. */
function panicMessages(channel) {
  const status = 0xb0 | (channel - 1);
  return [
    { type: 'cc', channel, controller: 123, value: 0, raw: [status, 123, 0] },
    { type: 'cc', channel, controller: 120, value: 0, raw: [status, 120, 0] }
  ];
}

export function setupMidiRouting(hub) {
  const offMessage = hub.events.on('midi:message', (msg) => {
    // CONTROL is additive: never remove a physical event from its native MIDI
    // path merely because MiniHub can also expose it as CONTROL.
    hub.network.emitData(nodeForMessage(msg), 'midi-out', msg);
  });

  // The controller vanished (or the user switched inputs) while notes were
  // held: the matching Note Offs are never coming. Push an explicit panic
  // through the same route the notes took, so only actually-connected chains
  // are affected. Channel is not tracked, so all 16 are silenced.
  //
  // Through EVERY controller's node, because the panic does not say which cable
  // went away and a note held on the other keyboard is just as stuck. Silencing
  // one node and leaving the other droning would be the worse half of a fix.
  const offPanic = hub.events.on('midi:panic', () => {
    for (let channel = 1; channel <= 16; channel += 1) {
      for (const msg of panicMessages(channel)) {
        for (const nodeId of CONTROLLER_NODE_IDS) hub.network.emitData(nodeId, 'midi-out', msg);
      }
    }
  });

  return () => { offMessage(); offPanic(); };
}
