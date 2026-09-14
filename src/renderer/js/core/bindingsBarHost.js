/**
 * Draws the bindings bars docked under the plugin editors, from this renderer.
 *
 * Main creates one bar per open plugin editor and keeps it under its frame
 * (src/main/bindingsBarWindows.js). What a bar shows is the Learn panel, and the
 * state that panel reads -- bindings, the armed Learn, the cables -- lives here,
 * so it is drawn here, by the same `renderControlBindings()` the VST node editor
 * uses, and sent across as markup. A click in a bar comes back as an action and
 * is carried out by the same module the node editor's clicks go through.
 * Nothing about a binding is decided in the bar. DECISIONS D-021.
 */
import { renderControlBindings } from './nodeInstances.js';
import { performControlBindingAction } from './controlBindingActions.js';
import { controllerModuleId } from './controllerNode.js';

const keyOf = (chainId, instanceId) => `${chainId}/${instanceId}`;

/**
 * Start answering bars. Returns a disposer, or null when this renderer runs
 * without main's bars (a test hub, an older preload).
 */
export function installBindingsBarHost(hub, api = hub.api, { contentElement = () => globalThis.document?.getElementById?.('content') } = {}) {
  if (typeof api?.bindingsBarRender !== 'function' || typeof api?.onBindingsBarWanted !== 'function') return null;
  // One entry per bar main has asked for. The selection is per bar: two editors
  // of the same node each have their own bar, and each may be on its own knob.
  const bars = new Map();

  function paint(bar) {
    const instance = hub.nodes?.get?.(bar.chainId);
    if (!instance || instance.type !== 'vst') return;
    const html = renderControlBindings(instance, hub, bar.selectedControlId);
    Promise.resolve(api.bindingsBarRender(bar.chainId, bar.instanceId, html))
      .then((delivered) => {
        // Main answers false for a bar that no longer exists: the editor closed.
        if (delivered === false && bars.get(bar.key) === bar) bars.delete(bar.key);
      })
      .catch(() => {});
  }

  function want(request) {
    const chainId = String(request?.chainId || '');
    const instanceId = String(request?.instanceId || '');
    if (!chainId || !instanceId) return;
    const key = keyOf(chainId, instanceId);
    if (!bars.has(key)) bars.set(key, { key, chainId, instanceId, selectedControlId: null });
    paint(bars.get(key));
  }

  function paintNode(nodeId) {
    for (const bar of bars.values()) {
      if (!nodeId || bar.chainId === nodeId) paint(bar);
    }
  }

  function act(action) {
    const bar = bars.get(keyOf(action?.chainId, action?.instanceId));
    if (!bar) return;
    if (action.kind === 'open-controller') {
      // The page is in the main window, so the person asked for that window:
      // it comes forward, which is D-040's rule and not an exception to it.
      const page = controllerModuleId(hub.modules);
      const content = contentElement();
      if (page && content) hub.modules.activate(page, content);
      Promise.resolve(api.focusMainWindow?.()).catch(() => {});
      return;
    }
    if (performControlBindingAction(hub, bar.chainId, action, bar)) paint(bar);
  }

  const unsubscribe = [
    api.onBindingsBarWanted(want),
    api.onBindingsBarAction?.(act),
    // The manager announces every change a panel can show: a capture, an armed
    // or ended Learn, a cable, a plugin that became ready or went away.
    hub.events.on('control:bindingsChanged', (change) => paintNode(change?.nodeId || null)),
    // An undo can bring back a binding without the manager hearing of it.
    hub.events.on('history:applied', () => paintNode(null))
  ];

  Promise.resolve(api.bindingsBarsOpen?.())
    .then((open) => { for (const bar of Array.isArray(open) ? open : []) want(bar); })
    .catch(() => {});

  return () => {
    for (const off of unsubscribe) if (typeof off === 'function') off();
    bars.clear();
  };
}
