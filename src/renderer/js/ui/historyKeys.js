/**
 * `Ctrl+Z` and `Ctrl+Shift+Z`, on every page of the shell.
 *
 * WHY ON `window` AND NOT PER MODULE
 * ----------------------------------
 * Two modules already bind `document` keydown while they are mounted -- the
 * Sequencer and the Patch Bay -- and each owns its own shortcuts. Undo is not
 * theirs: it is the application's, it must answer on the Home page as readily
 * as on a canvas, and a per-module copy would be three copies to keep in step
 * and one page where it silently does nothing.
 *
 * A `window` listener sees the event AFTER the `document` listeners, because it
 * is one bubble further out. Neither module claims Z, so nothing is being taken
 * from them -- and if one ever does, it can call `stopPropagation()` and win,
 * which is the right way round.
 *
 * WHY ONLY A TEXT FIELD IS LEFT ALONE
 * -----------------------------------
 * A text field has its own undo, the browser's, and it is the one the user
 * means while a caret is in it. Undoing a project edit because someone was
 * fixing a typo in a node name would be the feature's worst first impression.
 *
 * `input, select, textarea` was the first guess and it was WRONG, reported from
 * use on 2026-09-12: Ctrl+Z worked in the Patch Bay and nowhere else. The Patch
 * Bay is SVG with no form control in it; every other surface is built out of
 * real ones -- that is the whole point of Omni Pearl, a faceplate drawn around
 * a genuine `<select>` or `<input>` so the keyboard and screen readers keep
 * working. So focus sat on a control almost always, and the guard ate the
 * keystroke almost always.
 *
 * The browser only has an undo where there is TEXT to undo. A select, a
 * checkbox, a radio, a slider, a button have none, so the application's undo is
 * the only one that means anything there.
 */

/** `<input>` types the browser gives a text-editing undo to. */
const TEXT_INPUT_TYPES = new Set([
  'text', 'search', 'url', 'tel', 'email', 'password', 'number', ''
]);

function isTextField(element) {
  if (!element || element.nodeType !== 1) return false;
  const tag = String(element.tagName || '').toLowerCase();
  if (tag === 'textarea') return true;
  if (tag === 'input') return TEXT_INPUT_TYPES.has(String(element.type || '').toLowerCase());
  return false;
}

/**
 * Is the caret somewhere the browser owns Ctrl+Z?
 *
 * `closest` is used for `contenteditable` because the target can be a node
 * INSIDE an editable region; a form control is the target itself.
 */
export const isTextEditingTarget = (target) =>
  isTextField(target) || !!target?.closest?.('[contenteditable="true"],[contenteditable=""]');

/**
 * @returns {'undo'|'redo'|null} what this keystroke asks for.
 *
 * `Ctrl+Y` is here because it is the other redo every Windows application
 * answers, and a user who reaches for it is not wrong.
 */
export function historyIntent(event) {
  if (!event || event.altKey) return null;
  if (!(event.ctrlKey || event.metaKey)) return null;
  const key = String(event.key || '').toLowerCase();
  if (key === 'z') return event.shiftKey ? 'redo' : 'undo';
  if (key === 'y' && !event.shiftKey) return 'redo';
  return null;
}

/**
 * Install the shortcut. Returns the function that removes it -- invariant 8,
 * even for something that lives as long as the window.
 */
export function installHistoryKeys(hub, { target = globalThis.window } = {}) {
  if (!target?.addEventListener) return () => {};
  const onKeyDown = (event) => {
    const intent = historyIntent(event);
    if (!intent || isTextEditingTarget(event.target)) return;
    if (!hub.history) return;
    event.preventDefault();
    if (intent === 'undo') hub.history.undo();
    else hub.history.redo();
  };
  target.addEventListener('keydown', onKeyDown);
  return () => target.removeEventListener('keydown', onKeyDown);
}
