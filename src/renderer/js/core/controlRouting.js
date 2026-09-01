import { decodeMiniLabControl } from '../midi/minilabControls.js';
import { MINILAB_NODE_ID } from './systemNodes.js';


/**
 * Additively project documented MiniLab performance messages into typed
 * CONTROL graph data. The original message continues down the MIDI path.
 * This subscription is app-lifetime and independent of UI focus.
 */
export function setupControlRouting(hub) {
  return hub.events.on('midi:message', (msg) => {
    const control = decodeMiniLabControl(msg);
    if (!control) return;
    hub.graph.emitData(MINILAB_NODE_ID, control.sourcePortId, control);
  });
}
