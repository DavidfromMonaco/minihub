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

import { MINILAB_NODE_ID } from './systemNodes.js';

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
    hub.network.emitData(MINILAB_NODE_ID, 'midi-out', msg);
  });

  // The controller vanished (or the user switched inputs) while notes were
  // held: the matching Note Offs are never coming. Push an explicit panic
  // through the same route the notes took, so only actually-connected chains
  // are affected. Channel is not tracked, so all 16 are silenced.
  const offPanic = hub.events.on('midi:panic', () => {
    for (let channel = 1; channel <= 16; channel += 1) {
      for (const msg of panicMessages(channel)) {
        hub.network.emitData(MINILAB_NODE_ID, 'midi-out', msg);
      }
    }
  });

  return () => { offMessage(); offPanic(); };
}
