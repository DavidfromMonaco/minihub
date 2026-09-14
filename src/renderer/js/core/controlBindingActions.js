/**
 * What a click in the Learn panel means, and what doing it takes.
 *
 * Split in two because the two halves now run in two windows. The panel drawn by
 * `renderControlBindings()` is clicked in the bindings bar docked under a plugin
 * editor, which holds no binding state at all; the bindings, the armed Learn and
 * the cables live in the main window's renderer. So the bar reads the click
 * (`controlBindingActionOf`) and the main renderer carries it out
 * (`performControlBindingAction`). DECISIONS D-021.
 *
 * This file imports nothing, so the bar can load it without the profile the rest
 * of `core/` reads at import.
 */

const PANEL_ACTIONS = new Set(['learn', 'cancel', 'clear']);

/**
 * The action a click inside the panel asks for, or null.
 *
 * Reads only the markup `renderControlBindings()` writes: a control on the
 * faceplate selects it, the toolbar's buttons carry `data-control-action`, and
 * "Not your keyboard?" has its id.
 */
export function controlBindingActionOf(target) {
  if (!target || typeof target.closest !== 'function') return null;
  if (target.closest('#control-open-controller')) return { kind: 'open-controller' };
  const control = target.closest('[data-minilab-control-id]');
  if (control?.dataset?.minilabControlId) return { kind: 'select', controlId: control.dataset.minilabControlId };
  // The toolbar's buttons hold text and nothing else, so the click lands on the
  // button itself.
  const kind = target.dataset?.controlAction;
  const controlId = target.dataset?.sourceControlId;
  if (PANEL_ACTIONS.has(kind) && controlId) return { kind, controlId };
  return null;
}

/**
 * Carry one action out on `nodeId`. True when it was one of this panel's.
 *
 * The selection is not the manager's business -- two bars on the same node may
 * each have a different control selected -- so it lives on `panel`, owned by
 * whoever draws that panel. `open-controller` is not handled here: where the
 * controller page opens depends on the window the panel is in.
 */
export function performControlBindingAction(hub, nodeId, action, panel) {
  switch (action?.kind) {
    case 'select':
      panel.selectedControlId = action.controlId;
      return true;
    case 'learn':
      hub.control.armLearn(nodeId, action.controlId);
      return true;
    case 'cancel':
      hub.control.cancelLearn(nodeId, action.controlId, 'cancelled');
      return true;
    case 'clear':
      hub.control.clear(nodeId, action.controlId);
      return true;
    default:
      return false;
  }
}
