/**
 * Node editor registry: `typeId` -> how that node type's page renders and binds.
 *
 * Adding a node type used to mean editing `nodeInstances.js` in a dozen places:
 * one more branch in the render ternary, then an `if (type.id !== 'x') return;`
 * guard inside each of the DOM handlers shared by four unrelated editors. The
 * failure mode was that the shared handlers made every type a co-owner of every
 * other type's bugs -- a VST change broke the arpeggiator.
 *
 * Every page now lives in its own folder under `modules/` and is installed by
 * one `registerNodeEditor()` call from `app.js`. `nodeInstances.js` knows none
 * of them: its `mount()` draws what the registry hands back, deletes the node
 * when `#node-delete` is clicked, and redraws after an undo.
 */

/**
 * @typedef {object} NodeEditorContext
 * @property {object} instance the node instance being edited
 * @property {object} type its immutable node type (`nodeTypes.js`)
 * @property {object} hub
 * @property {object} manager the NodeInstanceManager that owns the instance
 * @property {object} state empty at each mount and the editor's own: what one
 *   opening of the page remembers that the model does not (a VST plugin's last
 *   engine status, the arpeggiator step under the pointer). `render`, `bind`
 *   and `refresh` all receive the same object.
 */

/**
 * @typedef {object} NodeEditor
 * @property {(context: NodeEditorContext) => string} render
 *   HTML for the editor body. External values must already be escaped
 *   (invariant 9) and carry no inline style (invariant 10).
 * @property {(container: Element, context: NodeEditorContext) => (() => void)|void} [bind]
 *   Optional. Attaches this editor's own listeners and returns its teardown,
 *   which `unmount()` runs (invariant 8).
 * @property {(container: Element, context: NodeEditorContext) => void} [refresh]
 *   Optional. An undo or a redo changed the node under the open page. Without
 *   it the page is drawn again from `render`; an editor provides it when a
 *   whole redraw would lose something the person is looking at -- a scroll
 *   position, a status line.
 */

/** @type {Map<string, NodeEditor>} */
const editors = new Map();

/**
 * Register the editor for a node type. Returns its unregister function, so a
 * test can install a fake editor without leaking it into the next test — the
 * same contract as `hub.events.on()`.
 *
 * A duplicate registration throws rather than overwriting: two editors claiming
 * one type means one of them is silently dead, which is exactly the class of
 * bug this registry exists to make impossible.
 */
export function registerNodeEditor(typeId, editor) {
  if (typeof typeId !== 'string' || !typeId) {
    throw new Error('Node editor must declare a string type id');
  }
  if (!editor || typeof editor.render !== 'function') {
    throw new Error(`Node editor for '${typeId}' must provide render()`);
  }
  if (editors.has(typeId)) {
    throw new Error(`Node editor already registered: ${typeId}`);
  }
  editors.set(typeId, editor);
  return () => {
    if (editors.get(typeId) === editor) editors.delete(typeId);
  };
}

/**
 * The editor for a type, or `null` when the type has none and falls back to the
 * generic shell (`video`, `image`, `audio-input`…).
 */
export function getNodeEditor(typeId) {
  return editors.get(typeId) || null;
}

/**
 * Redraw an open page when something other than its own controls writes its
 * node: a command from a plugin's or a One Ring's CTRL OUT (nodeCommands.js),
 * or an agent's `set-node-content`. The sound followed and the page did not
 * (D-042 left it so).
 *
 * Once a frame at most -- a sequence may send a command every sixteenth -- and
 * not while a pointer is held on the page, so a slider being dragged is not
 * replaced under the hand; the redraw waits for the release.
 *
 * Returns the teardown, for `bind` to hand back.
 */
export function followContentWrites(container, hub, nodeId, redraw) {
  let queued = false;
  let waiting = false;
  let held = false;
  const repaint = () => {
    queued = false;
    if (held) {
      waiting = true;
      return;
    }
    redraw();
  };
  const queue = () => {
    if (queued) return;
    queued = true;
    if (typeof globalThis.requestAnimationFrame === 'function') globalThis.requestAnimationFrame(repaint);
    else repaint();
  };
  const press = () => { held = true; };
  const release = () => {
    if (!held) return;
    held = false;
    if (waiting) {
      waiting = false;
      queue();
    }
  };
  container.addEventListener('pointerdown', press);
  document.addEventListener('pointerup', release);
  document.addEventListener('pointercancel', release);
  const off = hub.events.on('nodes:contentWritten', ({ nodeId: written } = {}) => {
    if (written === nodeId) queue();
  });
  return () => {
    container.removeEventListener('pointerdown', press);
    document.removeEventListener('pointerup', release);
    document.removeEventListener('pointercancel', release);
    off();
  };
}
