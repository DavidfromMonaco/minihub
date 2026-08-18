/**
 * Feeds incoming MIDI into the routing graph, for the lifetime of the app.
 *
 * This used to live inside the MiniLab module's `mount()`, which tied signal
 * routing to UI focus: navigating away from the MiniLab page unsubscribed the
 * handler and MIDI silently stopped reaching every connected VST chain — you
 * could not play a plugin while looking at its own page. Routing must be
 * independent of which module is visible (that is the whole point of
 * `hub.graph`), so the subscription is owned by the Hub instead.
 *
 * The MiniLab module still renders its own monitor/keyboard from the same
 * event; it just no longer owns the routing.
 */
const NODE_ID = 'minilab-3';

export function setupMidiRouting(hub) {
  return hub.events.on('midi:message', (msg) => {
    hub.graph.emitData(NODE_ID, 'midi-out', msg);
  });
}
