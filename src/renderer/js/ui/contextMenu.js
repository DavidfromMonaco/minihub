/**
 * The context menu: the Sequencer's, and the Patch Bay's since 2026-09-25.
 *
 * The Patch Bay's two menus were built by hand inside `routingModule.js`, the
 * canvas one with three levels of hover submenus (OmniBox > family > type).
 * The author found them unergonomic; they now come from here, and the node
 * list became what node editors offer instead -- a flat list under family
 * headings, filtered by typing (`search`).
 *
 * Four things it has to get right, and they are why this is a module at all:
 *
 * - **It closes on everything outside it.** Escape, a pointer press or a
 *   right-click elsewhere, a wheel, a scroll, a resize, a blur -- and its
 *   callers close it on re-render and on `unmount`. A menu that outlives the
 *   page it describes is a menu that acts on a clip which is no longer there.
 *   A press INSIDE it is not one of those: the document hears a press in
 *   capture, before the menu does, and closing there removed the menu before
 *   its own click -- so no entry ever ran in the application, while a test
 *   that fired `click` directly passed.
 * - **It removes every listener it added.** Invariant 8 is about a module's
 *   `unmount()`, and a menu belongs to no module: it attaches to
 *   `document.body`, above everything. Closing has to be complete, and
 *   opening a second menu closes the first.
 * - **It is built with `createElement`, never `innerHTML`.** A clip name
 *   reaches these labels, and `textContent` cannot be made to inject -- so
 *   invariant 9 is satisfied by construction rather than by remembering to
 *   escape. Position goes through the CSSOM, since the CSP drops a `style`
 *   attribute in silence (invariant 10).
 * - **It answers the keyboard.** The arrows walk the entries, Enter takes one,
 *   and with `search` what is typed narrows the list and Enter takes the first
 *   entry left.
 *
 * `items` is a flat list of `{ label, hint, action, disabled, danger, keywords }`,
 * `{ heading: 'Family' }`, or `{ separator: true }`. An entry with no `action`
 * renders inert. `search` is `{ placeholder }`; `className` adds a class to
 * the menu for a caller's own sizing.
 */

let openMenu = null;

const VIEWPORT_MARGIN = 8;

export function closeContextMenu() {
  openMenu?.close();
}

/** Does `text` match what was typed? Every word typed, anywhere, any case. */
export function menuMatches(text, query) {
  const haystack = String(text || '').toLowerCase();
  return String(query || '').toLowerCase().split(/\s+/).filter(Boolean).every((word) => haystack.includes(word));
}

export function openContextMenu({ x = 0, y = 0, items = [], onClose, search = null, className = '' } = {}) {
  closeContextMenu();
  const entries = (Array.isArray(items) ? items : [])
    .filter((item) => item && (item.separator || item.heading || item.label));
  // A list of separators and headings is not a menu.
  if (!entries.some((item) => item.label)) return null;

  const element = document.createElement('div');
  element.setAttribute('class', className ? `ctx-menu ${className}` : 'ctx-menu');
  element.setAttribute('role', 'menu');

  let closed = false;
  const listeners = [];
  // Every row as drawn, with what search needs to show or hide it.
  const rows = [];
  const listen = (target, type, handler, options) => {
    if (!target?.addEventListener) return;
    target.addEventListener(type, handler, options);
    listeners.push(() => target.removeEventListener(type, handler, options));
  };
  const inside = (node) => {
    for (let current = node; current; current = current.parentNode) if (current === element) return true;
    return false;
  };

  function close() {
    if (closed) return;
    closed = true;
    for (const off of listeners) off();
    element.remove();
    if (openMenu?.element === element) openMenu = null;
    onClose?.();
  }

  let field = null;
  if (search) {
    field = document.createElement('input');
    field.setAttribute('class', 'ctx-search');
    field.setAttribute('type', 'text');
    field.setAttribute('placeholder', String(search.placeholder || 'Search'));
    field.setAttribute('aria-label', String(search.placeholder || 'Search'));
    field.setAttribute('spellcheck', 'false');
    element.appendChild(field);
  }

  let group = '';
  for (const item of entries) {
    if (item.separator) {
      const rule = document.createElement('div');
      rule.setAttribute('class', 'ctx-separator');
      rule.setAttribute('role', 'separator');
      element.appendChild(rule);
      rows.push({ kind: 'separator', element: rule });
      continue;
    }
    if (item.heading) {
      group = String(item.heading);
      const heading = document.createElement('div');
      heading.setAttribute('class', 'ctx-group');
      heading.textContent = group;
      element.appendChild(heading);
      rows.push({ kind: 'heading', element: heading });
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
    const run = () => {
      if (inert) return;
      close();
      item.action();
    };
    if (!inert) {
      listen(button, 'click', (event) => {
        event.preventDefault?.();
        event.stopPropagation?.();
        run();
      });
    }
    element.appendChild(button);
    rows.push({ kind: 'item', element: button, inert, run, text: [item.label, group, item.keywords].filter(Boolean).join(' ') });
  }

  const shown = (row) => row.element.hidden !== true;
  const choices = () => rows.filter((row) => row.kind === 'item' && !row.inert && shown(row));

  /**
   * Show the entries that match, and only the headings and separators that
   * still have something to head or separate. An empty query shows it all.
   */
  function filter(query) {
    const searching = String(query || '').trim() !== '';
    for (const row of rows) if (row.kind === 'item') row.element.hidden = searching && !menuMatches(row.text, query);
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (row.kind === 'item') continue;
      if (searching && row.kind === 'separator') { row.element.hidden = true; continue; }
      let next = index + 1;
      while (next < rows.length && rows[next].kind === 'item' && !shown(rows[next])) next += 1;
      row.element.hidden = !(next < rows.length && rows[next].kind === 'item');
    }
  }

  function step(from, delta) {
    const list = choices();
    if (!list.length) return;
    const at = list.findIndex((row) => row.element === from);
    const next = at < 0 ? (delta > 0 ? 0 : list.length - 1) : (at + delta + list.length) % list.length;
    list[next].element.focus?.();
  }

  if (field) {
    listen(field, 'input', () => filter(field.value));
    listen(field, 'keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault?.();
        choices()[0]?.run();
      } else if (event.key === 'ArrowDown') {
        event.preventDefault?.();
        step(null, 1);
      }
    });
  }
  listen(element, 'keydown', (event) => {
    if (event.target === field) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault?.();
      step(event.target, event.key === 'ArrowDown' ? 1 : -1);
    } else if (field && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      // Typing on an entry goes on typing in the search.
      field.focus?.();
    }
  });

  // The menu itself must not count as "a press anywhere".
  listen(element, 'pointerdown', (event) => event.stopPropagation?.());
  listen(element, 'contextmenu', (event) => { event.preventDefault?.(); event.stopPropagation?.(); });
  const outside = (event) => { if (!inside(event?.target)) close(); };
  listen(document, 'pointerdown', outside, true);
  listen(document, 'contextmenu', outside, true);
  listen(document, 'wheel', (event) => { if (!inside(event?.target)) close(); }, true);
  listen(document, 'scroll', (event) => { if (!inside(event?.target)) close(); }, true);
  listen(document, 'keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault?.(); event.stopPropagation?.(); close(); }
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
  if (field) field.focus?.();
  else choices()[0]?.element.focus?.();

  openMenu = { element, close };
  return close;
}
