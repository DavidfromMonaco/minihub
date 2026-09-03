/**
 * Node editor registry: `typeId` -> how that node type renders and binds.
 *
 * Adding a node type used to mean editing `nodeInstances.js` in a dozen places:
 * one more branch in the render ternary, then an `if (type.id !== 'x') return;`
 * guard inside each of seven DOM handlers shared by four unrelated editors
 * (ROADMAP §4). The failure mode is that the shared handlers make every type a
 * co-owner of every other type's bugs — a VST change breaks the arpeggiator.
 *
 * This registry is the seam that stops the bleeding: a new node type ships as
 * its own folder plus one `registerNodeEditor()` call, never enters the shared
 * handlers, and owns its teardown through `createDisposers()`.
 *
 * The four editors that predate the registry (VST, Arpeggiator, Mixer, Morpher)
 * are registered from `nodeInstances.js` and still use the shared handlers.
 * That is deliberate: moving them out is ROADMAP §4, not this seam.
 */

/**
 * @typedef {object} NodeEditorContext
 * @property {object} instance the node instance being edited
 * @property {object} type its immutable node type (`nodeTypes.js`)
 * @property {object} hub
 * @property {Map<string, string>} statusMap live engine status per plugin instance
 * @property {Map<string, string>} editorNotes last native-editor feedback line
 */

/**
 * @typedef {object} NodeEditor
 * @property {(context: NodeEditorContext) => string} render
 *   HTML for the editor body. External values must already be escaped
 *   (invariant 9) and carry no inline style (invariant 10).
 * @property {(container: Element, context: NodeEditorContext) => (() => void)|void} [bind]
 *   Optional. Attaches this editor's own listeners and returns its teardown,
 *   which `unmount()` runs (invariant 8).
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
