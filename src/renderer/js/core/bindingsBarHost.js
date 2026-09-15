/**
 * Draws the bindings bars docked under the plugin editors, from this renderer.
 *
 * Main creates one bar per open plugin editor and keeps it under its frame
 * (src/main/bindingsBarWindows.js). What a bar shows is the Learn panel, and the
 * state that panel reads -- bindings, the armed Learn, the cables -- lives here,
 * so it is drawn here, by `renderControlBindings()`, and sent across as markup. A
 * click in a bar comes back as an action and is carried out by
 * `core/controlBindingActions.js`. Nothing about a binding is decided in the bar.
 * Since 2026-09-15 the bar is the panel's only host: the VST node's editor no
 * longer draws it. DECISIONS D-021.
 *
 * Since 2026-09-14 a bar also shows where each bound parameter stands, and a
 * knob dragged in it moves that parameter. The positions travel on their own
 * channel, a value at a time, because redrawing the markup at the rate a knob
 * turns would replace the very element the mouse is dragging. See
 * `core/controlValues.js`.
 */
import { renderControlBindings } from './controlBindingsPanel.js';
import { performControlBindingAction } from './controlBindingActions.js';
import { controllerModuleId } from './controllerNode.js';
import { ControlValues } from './controlValues.js';

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
  const values = new ControlValues(hub);

  function sendValues(bar, entries, replace) {
    if (typeof api.bindingsBarValues !== 'function') return;
    Promise.resolve(api.bindingsBarValues(bar.chainId, bar.instanceId, entries, replace)).catch(() => {});
  }

  function forget(bar) {
    if (bars.get(bar.key) !== bar) return;
    bars.delete(bar.key);
    values.unwatch(bar.chainId);
  }

  function paint(bar) {
    const instance = hub.nodes?.get?.(bar.chainId);
    if (!instance || instance.type !== 'vst') return;
    const html = renderControlBindings(instance, hub, bar.selectedControlId);
    Promise.resolve(api.bindingsBarRender(bar.chainId, bar.instanceId, html))
      .then((delivered) => {
        // Main answers false for a bar that no longer exists: the editor closed.
        if (delivered === false) forget(bar);
      })
      .catch(() => {});
    // After the markup, on the same road, so the positions land on the controls
    // they belong to.
    sendValues(bar, values.snapshot(bar.chainId), true);
  }

  function want(request) {
    const chainId = String(request?.chainId || '');
    const instanceId = String(request?.instanceId || '');
    if (!chainId || !instanceId) return;
    const key = keyOf(chainId, instanceId);
    if (!bars.has(key)) {
      bars.set(key, { key, chainId, instanceId, selectedControlId: null });
      values.watch(chainId);
    }
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
    if (action.kind === 'turn') {
      // The same road as the knob on the keyboard: the binding, its cable, the
      // plugin it points at. A control with no working binding moves nothing.
      hub.control?.route(bar.chainId, {
        type: 'control', sourceControlId: action.controlId, normalizedValue: action.normalizedValue
      });
      return;
    }
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
    hub.events.on('history:applied', () => paintNode(null)),
    hub.events.on('control:value', (change) => {
      for (const bar of bars.values()) {
        if (bar.chainId === change.nodeId) sendValues(bar, { [change.sourceControlId]: change.normalizedValue }, false);
      }
    }),
    hub.events.on('control:values', (change) => {
      for (const bar of bars.values()) {
        if (bar.chainId === change.nodeId) sendValues(bar, values.snapshot(bar.chainId), true);
      }
    })
  ];

  Promise.resolve(api.bindingsBarsOpen?.())
    .then((open) => { for (const bar of Array.isArray(open) ? open : []) want(bar); })
    .catch(() => {});

  return () => {
    for (const off of unsubscribe) if (typeof off === 'function') off();
    values.dispose();
    bars.clear();
  };
}
