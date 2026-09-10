/**
 * A reusable context menu.
 *
 * **It is not the first menu in MiniHub** -- the Patch Bay has had two since
 * before this file, built by hand inside `routingModule.js`: one on a node
 * (Copy, Delete Node) and one on the canvas (a New Node submenu, Paste). The
 * ROADMAP said otherwise and was wrong; the code is what settled it.
 *
 * So this module exists to stop the sequencer's menu from becoming a THIRD
 * hand-rolled one, and it deliberately borrows the Patch Bay's existing
 * vocabulary -- `.ctx-item`, `.ctx-separator` -- rather than inventing a
 * second look. Adopting it inside `routingModule.js` and deleting the copy
 * there is worth doing and is NOT done here: the canvas menu carries a
 * submenu (the New Node family hierarchy) that this module has no concept of,
 * so it is a piece of work with a design question in it, not a move.
 *
 * Three things it has to get right, and they are why this is a module at all:
 *
 * - **It closes on everything.** Escape, a pointer press or a right-click
 *   anywhere, a wheel, a scroll, a resize, a blur -- and its callers close it
 *   on re-render and on `unmount`. A menu that outlives the page it describes
 *   is a menu that acts on a clip which is no longer there.
 * - **It removes every listener it added.** Invariant 8 is about a module's
 *   `unmount()`, and a menu belongs to no module: it attaches to
 *   `document.body`, above everything. Closing has to be complete, and
 *   opening a second menu closes the first.
 * - **It is built with `createElement`, never `innerHTML`.** A clip name
 *   reaches these labels, and `textContent` cannot be made to inject -- so
 *   invariant 9 is satisfied by construction rather than by remembering to
 *   escape. Position goes through the CSSOM, since the CSP drops a `style`
 *   attribute in silence (invariant 10).
 *
 * `items` is a flat list of `{ label, hint, action, disabled, danger }`, or
 * `{ separator: true }`. An entry with no `action` renders inert, which is
 * what makes a heading possible without inventing a second concept.
 */

let openMenu = null;

const VIEWPORT_MARGIN = 8;

export function closeContextMenu() {
  openMenu?.close();
}

export function openContextMenu({ x = 0, y = 0, items = [], onClose } = {}) {
  closeContextMenu();
  const entries = (Array.isArray(items) ? items : []).filter((item) => item && (item.separator || item.label));
  // A list of separators is not a menu.
  if (!entries.some((item) => !item.separator)) return null;

  const element = document.createElement('div');
  element.setAttribute('class', 'ctx-menu');
  element.setAttribute('role', 'menu');

  let closed = false;
  const listeners = [];
  const buttons = [];
  const listen = (target, type, handler, options) => {
    if (!target?.addEventListener) return;
    target.addEventListener(type, handler, options);
    listeners.push(() => target.removeEventListener(type, handler, options));
  };

  function close() {
    if (closed) return;
    closed = true;
    for (const off of listeners) off();
    element.remove();
    if (openMenu?.element === element) openMenu = null;
    onClose?.();
  }

  for (const item of entries) {
    if (item.separator) {
      const rule = document.createElement('div');
      rule.setAttribute('class', 'ctx-separator');
      rule.setAttribute('role', 'separator');
      element.appendChild(rule);
      continue;
    }
    const button = document.createElement('button');
    button.setAttribute('class', `ctx-item${item.danger ? ' danger' : ''}`);
    button.setAttribute('role', 'menuitem');
    const inert = item.disabled === true || typeof item.action !== 'function';
    if (inert) button.disabled = true;
    const label = document.createElement('span');
    label.textContent = String(item.label);
    button.appendChild(label);
    if (item.hint) {
      const hint = document.createElement('span');
      hint.setAttribute('class', 'ctx-hint');
      hint.textContent = String(item.hint);
      button.appendChild(hint);
    }
    if (!inert) {
      listen(button, 'click', (event) => {
        event.preventDefault?.();
        event.stopPropagation?.();
        close();
        item.action();
      });
    }
    element.appendChild(button);
    buttons.push(button);
  }

  // The menu itself must not count as "a press anywhere".
  listen(element, 'pointerdown', (event) => event.stopPropagation?.());
  listen(element, 'contextmenu', (event) => { event.preventDefault?.(); event.stopPropagation?.(); });
  listen(document, 'pointerdown', close, true);
  listen(document, 'contextmenu', close, true);
  listen(document, 'wheel', close, true);
  listen(document, 'scroll', close, true);
  listen(document, 'keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault?.(); close(); }
  }, true);
  listen(globalThis, 'blur', close);
  listen(globalThis, 'resize', close);

  document.body.appendChild(element);
  // Positioned after insertion, because staying on screen needs the measured
  // size. Through the CSSOM like every other dynamic geometry in the renderer.
  // No measurement, no clamp. Folding an unknown viewport into the arithmetic
  // pins every menu to the top-left corner, which is worse than not clamping.
  const fit = (value, size, limit) => (limit > 0
    ? Math.max(VIEWPORT_MARGIN, Math.min(value, Math.max(VIEWPORT_MARGIN, limit - size - VIEWPORT_MARGIN)))
    : Math.max(0, value));
  element.style.left = `${fit(x, element.offsetWidth || 0, Number(globalThis.innerWidth) || 0)}px`;
  element.style.top = `${fit(y, element.offsetHeight || 0, Number(globalThis.innerHeight) || 0)}px`;
  // A plain array, not `element.children`: an HTMLCollection has no `find`,
  // and an optional call on a missing method fails silently rather than
  // loudly -- which is how focus would have quietly stopped working.
  buttons.find((button) => !button.disabled)?.focus?.();

  openMenu = { element, close };
  return close;
}
