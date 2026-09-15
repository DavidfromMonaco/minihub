/**
 * The Learn panel: a faceplate for each keyboard on the desk, and the toolbar
 * that arms, cancels and clears the binding of the control selected on it.
 *
 * It has one host, the bindings bar docked under a plugin editor
 * (`core/bindingsBarHost.js`). The VST node's editor drew it too until
 * 2026-09-15; the bar was built to replace that panel, not to sit beside it,
 * because a second place to reach a binding is a second thing to keep in step
 * (DECISIONS D-021). It left `nodeInstances.js` with it: nothing about a node
 * instance draws it any more.
 *
 * The markup is read back in three places, and a renamed class or attribute
 * fails there in silence: `core/controlBindingActions.js` reads the clicks,
 * `bindingsBar.js` and the `.bindings-bar` rules of `base.css` lay it out.
 */
import { escapeHtml } from './html.js';
import { controllerName } from './controllerNode.js';
import { controlSourcesOfNode, surfaceControlsOfNode, surfaceBoxOfNode } from '../midi/minilabControls.js';
import { CONTROLLER_NODE_IDS } from './systemNodes.js';
import { miniLabControlSurfaceHtml } from '../ui/miniLabControlSurface.js';

export function renderControlBindings(instance, hub, selectedControlId = null) {
  const pending = hub.control?.pendingLearn;
  // Every keyboard on the desk, cabled to this node or not, in the order they
  // loaded. The panel used to draw only the keyboards cabled to CTRL IN, and
  // greyed out every control without its own cable: cabling a knob in the Patch
  // Bay was the step before learning it. Learn plugs that cable now (see
  // ControlBindingManager), so any control of any keyboard can be learned from
  // here -- and a drawing that followed the cables would hide the very keyboard
  // the person is about to learn from. Loading order, not cable order, so that
  // the capture plugging a cable does not reshuffle the faceplates under the
  // mouse. Asked 2026-09-14.
  const drawnNodes = [...CONTROLLER_NODE_IDS];
  const sources = drawnNodes.flatMap((nodeId) => controlSourcesOfNode(nodeId));
  const states = {};
  sources.forEach((source) => {
    const status = hub.control?.bindingStatus(instance.id, source.id)
      || { state: 'unbound', binding: null };
    const isPending = pending?.nodeId === instance.id && pending.sourceControlId === source.id;
    // `unplugged`: learned, and its cable since pulled out in the Patch Bay. The
    // binding is kept (it is the person's work) and does nothing until a cable
    // or a new Learn brings the knob back; drawn as mapped, it would read as
    // working.
    states[source.id] = isPending ? 'learn-armed'
      : (!status.binding ? 'unmapped' : (status.state === 'disconnected' ? 'unplugged' : 'mapped'));
  });
  const selected = sources.find((source) => source.id === selectedControlId) || null;
  const selectedStatus = selected ? hub.control?.bindingStatus(instance.id, selected.id) : null;
  const isPending = selected && pending?.nodeId === instance.id && pending.sourceControlId === selected.id;
  const binding = selectedStatus?.binding;
  const target = binding
    ? `${binding.pluginName || binding.pluginInstanceId} · ${binding.parameterName || `ParamID ${binding.parameterId}`}`
    : 'Unmapped';
  // Named from its Patch Bay node, like the header and the sequencer's
  // messages: this sentence points at hardware the user has to touch, and it
  // used to point at a MiniLab whoever else's keyboard is on the desk. Escaped
  // because the name reaches innerHTML and now comes from a profile file.
  //
  // The node that is DRAWN, not "the controller": with two keyboards on the desk
  // `controllerName` answers null by design (D-022), and the sentence would send
  // the user to look at "the controller" while a named faceplate sat under it.
  // With several drawn, none of them is "the" one and the generic word is right.
  const nodeName = (nodeId) => hub.network?.getNode?.(nodeId)?.name || nodeId;
  const device = drawnNodes.length === 1 ? nodeName(drawnNodes[0]) : controllerName(hub.network);
  // The way out of this panel when the drawing is not the user's keyboard. It
  // used to be a dead end: the controls shown here come from the loaded profile,
  // and nothing on this page said where a profile is chosen. The device's own
  // page is that place, and it is named after the device rather than after
  // MiniHub's word for it.
  return `
    <div class="control-bindings-help muted">
      Click a control on ${device ? escapeHtml(device) : 'the controller'}, press Arm Learning, then move the plugin parameter it should control.
      <button type="button" class="btn btn-sm" id="control-open-controller">Not your keyboard?</button>
    </div>
    ${drawnNodes.map((nodeId) =>
      // One faceplate per keyboard, each named when there is more than one — an
      // unlabelled second panel is a drawing the user has to identify by
      // counting its knobs.
      (drawnNodes.length > 1
        ? `<div class="control-bindings-help muted">${escapeHtml(nodeName(nodeId))}</div>`
        : '')
      + miniLabControlSurfaceHtml({
        states,
        selectedId: selected?.id || null,
        controls: surfaceControlsOfNode(nodeId),
        box: surfaceBoxOfNode(nodeId)
      })).join('')}
    <div class="control-learn-toolbar" data-selected-source-control-id="${selected?.id || ''}">
      <strong>${selected?.label || 'Select a control'}</strong>
      <span class="control-binding-target">${escapeHtml(selected ? target : 'Choose an observable physical control above')}</span>
      <span class="spacer"></span>
      <button class="btn primary" data-control-action="${isPending ? 'cancel' : 'learn'}" data-source-control-id="${selected?.id || ''}"
        ${selected ? '' : 'disabled'}>${isPending ? 'Cancel Learning' : 'Arm Learning'}</button>
      <button class="btn" data-control-action="clear" data-source-control-id="${selected?.id || ''}"
        ${binding && !isPending ? '' : 'disabled'}>Clear</button>
    </div>`;
}
