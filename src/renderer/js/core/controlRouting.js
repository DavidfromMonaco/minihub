import { decodeMiniLabControl } from '../midi/minilabControls.js';

const NODE_ID = 'minilab-3';

/**
 * Additively project documented MiniLab performance messages into typed
 * CONTROL graph data. The original message continues down the MIDI path.
 * This subscription is app-lifetime and independent of UI focus.
 */
export function setupControlRouting(hub) {
  return hub.events.on('midi:message', (msg) => {
    const control = decodeMiniLabControl(msg);
    if (!control) return;
    hub.graph.emitData(NODE_ID, control.sourcePortId, control);
  });
}
