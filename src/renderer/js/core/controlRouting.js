import { decodeMiniLabControl, profileOfNode } from '../midi/minilabControls.js';
import { LOADED_PROFILE } from '../midi/loadedProfile.js';


/**
 * Additively project documented performance messages into typed CONTROL network
 * data. The original message continues down the MIDI path. This subscription is
 * app-lifetime and independent of UI focus.
 *
 * WHICH keyboard sent it comes with the message: `midi/midiManager.js` arms one
 * port per loaded profile and stamps `profileId` on what arrives. Guessing it
 * here instead -- trying each profile until one decodes -- would hand every CC 74
 * to whichever keyboard loaded first, because both have a first knob.
 *
 * The fallback is the first profile, and it is the case where no loaded profile
 * claims the selected port: the user picked a keyboard MiniHub has no profile
 * for, and this is what the single-controller version did with it.
 *
 * The node is the decoded control's own, not a constant. That is the whole of
 * step 3b: `emitData(MINILAB_NODE_ID, ...)` sent the second keyboard's knobs out
 * of the first keyboard's node, where they would have driven its bindings.
 */
export function setupControlRouting(hub) {
  return hub.events.on('midi:message', (msg) => {
    const control = decodeMiniLabControl(msg, profileOfNode(msg?.profileId) ?? LOADED_PROFILE);
    if (!control) return;
    hub.network.emitData(control.sourceNodeId, control.sourcePortId, control);
  });
}
