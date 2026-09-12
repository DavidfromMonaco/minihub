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
 * WHY AN EDITABLE TARGET IS LEFT ALONE
 * ------------------------------------
 * A text field has its own undo, the browser's, and it is the one the user
 * means while a caret is in it. Undoing a project edit because someone was
 * fixing a typo in a node name would be the feature's worst first impression.
 */

const EDITABLE = 'input,select,textarea,[contenteditable="true"]';

const isEditable = (target) => !!target?.closest?.(EDITABLE);

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
    if (!intent || isEditable(event.target)) return;
    if (!hub.history) return;
    event.preventDefault();
    if (intent === 'undo') hub.history.undo();
    else hub.history.redo();
  };
  target.addEventListener('keydown', onKeyDown);
  return () => target.removeEventListener('keydown', onKeyDown);
}
