/**
 * The list the plugin picker opens, drawn by the page, with a brand's plugins
 * folded into one row.
 *
 * WHY NOT THE ONE THE BROWSER DRAWS
 * ---------------------------------
 * A `<select>` can title its groups but never fold one: under any heading,
 * Kilohearts' 35 effects stayed 35 lines and buried every other effect (the
 * author, 2026-09-21). Its list is also a window Chromium draws on its own,
 * white on Windows whatever the page declares, which the faceplate met first
 * (`bindPearlLists` in ui/omniPearl.js).
 *
 * So, as there, the `<select>` stays the control. It holds the plugin id that
 * "+ Add VST" reads, keeps the arrows it always had and fires `change`. Only
 * what it opens is ours: the families as headings, and a brand with several
 * plugins in a family as one row whose plugins open beside it
 * (`pluginPickerSections` in core/vstChain.js).
 *
 * It borrows the menus' vocabulary (`.ctx-menu`, `.ctx-item`, `.ctx-hint`,
 * `.ctx-caret`) and keeps the promises ui/contextMenu.js keeps: it closes on
 * everything outside it, removes every listener it added, is built with
 * `createElement` so a plugin's name has no markup path (invariant 9), and
 * places itself through the CSSOM (invariant 10). Unlike a context menu it
 * scrolls, since a brand can hold more plugins than a screen has rows: a wheel
 * or a scroll inside it is its own and closes nothing.
 */

import { pluginPickerSections } from '../core/vstChain.js';

const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 4;
// A brand's plugins stay open this long after the pointer leaves its row, so
// crossing a neighbour on the way to them does not close them. The Patch Bay's
// New Node submenu waits as long.
const SUBMENU_CLOSE_MS = 180;
// Letters typed within this long of each other are one search, as in a select.
const TYPEAHEAD_MS = 700;
// Border and padding of a `.ctx-menu`: a brand's first plugin level with it.
const PANEL_INSET = 5;

let openMenu = null;

export function closePluginMenu() {
  openMenu?.close();
}

export function isPluginMenuOpenFor(anchor) {
  return Boolean(openMenu && anchor && openMenu.anchor === anchor);
}

/**
 * Open the list under `anchor`.
 *
 * `sections` is what `pluginPickerSections` returns, `pickedId` the plugin
 * chosen now. `onPick(plugin)` runs once the list has closed. Returns the
 * function that closes it, or null when there is nothing to list.
 */
export function openPluginMenu({ anchor, sections = [], pickedId = '', onPick, onClose } = {}) {
  closePluginMenu();
  const families = (Array.isArray(sections) ? sections : [])
    .filter((section) => section && Array.isArray(section.entries) && section.entries.length > 0);
  if (families.length === 0) return null;

  const doc = globalThis.document;
  const listeners = [];
  const listen = (target, type, handler, options, bucket = listeners) => {
    if (!target?.addEventListener) return;
    target.addEventListener(type, handler, options);
    bucket.push(() => target.removeEventListener(type, handler, options));
  };

  // Plain arrays and maps, never `element.children`: an HTMLCollection has no
  // `filter`, and an optional call on a missing method fails in silence.
  const mainRows = [];
  const pluginOfRow = new Map();
  const brandOfRow = new Map();
  const labelOfRow = new Map();
  let sub = null; // { panel, row, rows, off }
  let active = null;
  let closed = false;
  let typed = '';
  let subTimer = null;
  let typedTimer = null;

  const main = makePanel();

  function makePanel() {
    const element = doc.createElement('div');
    element.setAttribute('class', 'ctx-menu plugin-menu');
    element.setAttribute('role', 'menu');
    return element;
  }

  function makeSpan(text, className) {
    const element = doc.createElement('span');
    if (className) element.setAttribute('class', className);
    element.textContent = text;
    return element;
  }

  function makeRow(className, role, label, bucket) {
    const row = doc.createElement('button');
    row.setAttribute('type', 'button');
    row.setAttribute('class', className);
    row.setAttribute('role', role);
    labelOfRow.set(row, label);
    listen(row, 'pointerdown', (event) => event.preventDefault?.(), undefined, bucket);
    return row;
  }

  function pluginRow(plugin, text, bucket) {
    const picked = plugin.pluginId === pickedId;
    const row = makeRow(picked ? 'ctx-item is-picked' : 'ctx-item', 'menuitemradio', String(plugin.name ?? ''), bucket);
    row.setAttribute('aria-checked', picked ? 'true' : 'false');
    row.appendChild(makeSpan(text));
    pluginOfRow.set(row, plugin);
    listen(row, 'click', (event) => {
      event.preventDefault?.();
      event.stopPropagation?.();
      pick(plugin);
    }, undefined, bucket);
    return row;
  }

  function brandRow(entry) {
    const holdsPick = entry.plugins.some((plugin) => plugin.pluginId === pickedId);
    const row = makeRow(holdsPick ? 'ctx-item ctx-parent has-picked' : 'ctx-item ctx-parent', 'menuitem', entry.brand);
    row.setAttribute('aria-haspopup', 'menu');
    row.setAttribute('aria-expanded', 'false');
    row.appendChild(makeSpan(entry.brand));
    const trail = makeSpan('', 'ctx-trail');
    trail.appendChild(makeSpan(String(entry.plugins.length), 'ctx-hint'));
    trail.appendChild(makeSpan('›', 'ctx-caret'));
    row.appendChild(trail);
    brandOfRow.set(row, entry);
    listen(row, 'click', (event) => {
      event.preventDefault?.();
      event.stopPropagation?.();
      openBrand(row, false);
    });
    listen(row, 'pointerenter', () => openBrand(row, false));
    return row;
  }

  for (const family of families) {
    const heading = makeSpan(String(family.label ?? ''), 'ctx-group');
    heading.setAttribute('role', 'presentation');
    listen(heading, 'pointerenter', leaveBrand);
    main.appendChild(heading);
    for (const entry of family.entries) {
      let row = null;
      if (entry.plugin) {
        const brand = String(entry.plugin.manufacturer || '').trim();
        row = pluginRow(entry.plugin, `${entry.plugin.name ?? ''} · ${brand || '?'}`);
        listen(row, 'pointerenter', leaveBrand);
      } else if (entry.brand && Array.isArray(entry.plugins) && entry.plugins.length > 0) {
        row = brandRow(entry);
      }
      if (!row) continue;
      main.appendChild(row);
      mainRows.push(row);
    }
  }
  if (mainRows.length === 0) return null;

  // ---- a brand's plugins, beside its row ----

  function openBrand(row, focusInside) {
    clearTimeout(subTimer);
    subTimer = null;
    const entry = brandOfRow.get(row);
    if (!entry || closed) return;
    if (sub?.row !== row) {
      closeBrand();
      const panel = makePanel();
      const off = [];
      const rows = entry.plugins.map((plugin) => {
        const pluginButton = pluginRow(plugin, String(plugin.name ?? ''), off);
        panel.appendChild(pluginButton);
        return pluginButton;
      });
      listen(panel, 'pointerenter', () => { clearTimeout(subTimer); subTimer = null; }, undefined, off);
      doc.body.appendChild(panel);
      sub = { panel, row, rows, off };
      row.classList.add('is-open');
      row.setAttribute('aria-expanded', 'true');
      placeBeside(panel, row);
    }
    if (focusInside) focusRow(sub.rows.find((candidate) => pluginOfRow.get(candidate)?.pluginId === pickedId) ?? sub.rows[0]);
  }

  function closeBrand() {
    clearTimeout(subTimer);
    subTimer = null;
    if (!sub) return;
    for (const off of sub.off) off();
    for (const row of sub.rows) {
      pluginOfRow.delete(row);
      labelOfRow.delete(row);
    }
    sub.panel.remove();
    sub.row.classList.remove('is-open');
    sub.row.setAttribute('aria-expanded', 'false');
    if (sub.rows.includes(active)) active = null;
    sub = null;
  }

  function leaveBrand() {
    if (!sub || subTimer) return;
    subTimer = setTimeout(() => { subTimer = null; closeBrand(); }, SUBMENU_CLOSE_MS);
  }

  // ---- geometry, through the CSSOM ----

  function viewport() {
    return { width: Number(globalThis.innerWidth) || 0, height: Number(globalThis.innerHeight) || 0 };
  }

  // Under the select, or above it when the room is there and not below. Its
  // height is capped to the room it gets and the rest scrolls.
  function placeUnder(panel) {
    const rect = anchor?.getBoundingClientRect?.();
    if (!rect) return;
    const { width: vw, height: vh } = viewport();
    panel.style.minWidth = `${Math.round(rect.width)}px`;
    let top = rect.bottom + ANCHOR_GAP;
    if (vh > 0) {
      const natural = panel.offsetHeight || 0;
      const below = Math.max(0, vh - VIEWPORT_MARGIN - top);
      const above = Math.max(0, rect.top - ANCHOR_GAP - VIEWPORT_MARGIN);
      if (natural > below && above > below) {
        top = rect.top - ANCHOR_GAP - Math.min(natural, above);
        panel.style.maxHeight = `${Math.floor(above)}px`;
      } else {
        panel.style.maxHeight = `${Math.floor(below)}px`;
      }
    }
    const width = panel.offsetWidth || 0;
    const left = vw > 0 ? Math.max(VIEWPORT_MARGIN, Math.min(rect.left, vw - width - VIEWPORT_MARGIN)) : rect.left;
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
  }

  // To the right of the list, or to its left when the right has no room; its
  // first plugin level with the brand's row, slid up if it would run off.
  function placeBeside(panel, row) {
    const rowRect = row.getBoundingClientRect?.();
    const listRect = main.getBoundingClientRect?.();
    if (!rowRect || !listRect) return;
    const { width: vw, height: vh } = viewport();
    if (vh > 0) panel.style.maxHeight = `${Math.max(0, vh - 2 * VIEWPORT_MARGIN)}px`;
    const width = panel.offsetWidth || 0;
    const height = panel.offsetHeight || 0;
    // The Patch Bay's submenus overlap their parent by 2 px, so the pointer's
    // path between the two never crosses a gap.
    let left = listRect.right - 2;
    if (vw > 0 && left + width > vw - VIEWPORT_MARGIN) {
      const flipped = listRect.left - width + 2;
      left = flipped >= VIEWPORT_MARGIN ? flipped : Math.max(VIEWPORT_MARGIN, vw - width - VIEWPORT_MARGIN);
    }
    let top = rowRect.top - PANEL_INSET;
    if (vh > 0) top = Math.max(VIEWPORT_MARGIN, Math.min(top, vh - height - VIEWPORT_MARGIN));
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
  }

  // ---- focus and keys ----

  function focusRow(row) {
    if (!row) return;
    active = row;
    row.focus?.({ preventScroll: true });
    row.scrollIntoView?.({ block: 'nearest' });
  }

  function activate(row) {
    if (brandOfRow.has(row)) openBrand(row, true);
    else if (pluginOfRow.has(row)) pick(pluginOfRow.get(row));
  }

  function backToBrand() {
    const row = sub.row;
    closeBrand();
    focusRow(row);
  }

  function search(key, rows, at) {
    clearTimeout(typedTimer);
    typed += key.toLowerCase();
    typedTimer = setTimeout(() => { typed = ''; typedTimer = null; }, TYPEAHEAD_MS);
    typedTimer?.unref?.();
    // A first letter moves on from the row it is on; a longer search may stay.
    const start = typed.length === 1 ? at + 1 : Math.max(0, at);
    for (let step = 0; step < rows.length; step += 1) {
      const row = rows[(start + step) % rows.length];
      if (String(labelOfRow.get(row) ?? '').toLowerCase().startsWith(typed)) {
        focusRow(row);
        return;
      }
    }
  }

  function onKeyDown(event) {
    const inSub = Boolean(sub && sub.rows.includes(active));
    const rows = inSub ? sub.rows : mainRows;
    const at = rows.indexOf(active);
    const key = event.key;
    const take = () => {
      event.preventDefault?.();
      event.stopPropagation?.();
    };
    if (key === 'Tab') {
      close();
    } else if (key === 'ArrowDown' || key === 'ArrowUp') {
      take();
      const next = at < 0 ? 0 : at + (key === 'ArrowDown' ? 1 : -1);
      focusRow(rows[Math.min(rows.length - 1, Math.max(0, next))]);
    } else if (key === 'Home' || key === 'End') {
      take();
      focusRow(key === 'Home' ? rows[0] : rows[rows.length - 1]);
    } else if (key === 'ArrowRight') {
      take();
      if (!inSub && brandOfRow.has(active)) openBrand(active, true);
    } else if (key === 'ArrowLeft') {
      take();
      if (inSub) backToBrand();
    } else if (key === 'Escape') {
      take();
      if (inSub) backToBrand();
      else {
        close();
        anchor?.focus?.();
      }
    } else if (key === 'Enter' || (key === ' ' && !typed)) {
      take();
      activate(active);
    } else if (typeof key === 'string' && key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      take();
      search(key, rows, at);
    }
  }

  // ---- closing ----

  function within(node, element) {
    for (let current = node; current; current = current.parentNode) {
      if (current === element) return true;
    }
    return false;
  }

  const inside = (node) => within(node, main) || Boolean(sub && within(node, sub.panel));

  function pick(plugin) {
    close();
    anchor?.focus?.();
    onPick?.(plugin);
  }

  function close() {
    if (closed) return;
    closed = true;
    closeBrand();
    clearTimeout(typedTimer);
    for (const off of listeners) off();
    listeners.length = 0;
    main.remove();
    anchor?.setAttribute?.('aria-expanded', 'false');
    if (openMenu?.close === close) openMenu = null;
    onClose?.();
  }

  // A press on the select itself is its owner's to read: it closes the list
  // there, where it can tell a press that closes from one that opens.
  listen(doc, 'pointerdown', (event) => {
    if (!inside(event.target) && !within(event.target, anchor)) close();
  }, true);
  listen(doc, 'wheel', (event) => { if (!inside(event.target)) close(); }, true);
  listen(doc, 'scroll', (event) => { if (!inside(event.target)) close(); }, true);
  listen(doc, 'keydown', onKeyDown, true);
  listen(globalThis, 'blur', close);
  listen(globalThis, 'resize', close);

  doc.body.appendChild(main);
  placeUnder(main);
  anchor?.setAttribute?.('aria-expanded', 'true');
  openMenu = { anchor, close };
  focusRow(
    mainRows.find((row) => pluginOfRow.get(row)?.pluginId === pickedId)
      ?? mainRows.find((row) => brandOfRow.get(row)?.plugins.some((plugin) => plugin.pluginId === pickedId))
      ?? mainRows[0]
  );
  return close;
}

/**
 * Give every plugin picker under `root` the list above.
 *
 * A picker is a `select.plugin-pick` whose options are the catalogue's plugins;
 * `plugins()` returns that catalogue when the list opens. A select opens the
 * browser's list on a press and on some keys, so both are taken here, before
 * the browser acts on them. Returns what removes it all.
 */
export function bindPluginMenu(root, { plugins } = {}) {
  if (!root?.addEventListener) return () => {};

  const selectAt = (target) => target?.closest?.('select.plugin-pick') || null;
  const catalogue = () => {
    const list = typeof plugins === 'function' ? plugins() : plugins;
    return Array.isArray(list) ? list : [];
  };

  const show = (select) => {
    if (select.disabled) return;
    if (isPluginMenuOpenFor(select)) {
      closePluginMenu();
      return;
    }
    openPluginMenu({
      anchor: select,
      sections: pluginPickerSections(catalogue()),
      pickedId: select.value,
      onPick: (plugin) => choose(select, plugin?.pluginId)
    });
  };

  const onPointerDown = (event) => {
    const select = selectAt(event.target);
    if (!select || (event.button ?? 0) !== 0) return;
    event.preventDefault?.();
    show(select);
  };

  const onKeyDown = (event) => {
    const select = selectAt(event.target);
    if (!select || isPluginMenuOpenFor(select)) return;
    const opening = event.key === 'Enter' || event.key === ' ' || event.key === 'F4'
      || ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && event.altKey);
    if (!opening) return;
    event.preventDefault?.();
    show(select);
  };

  root.addEventListener('pointerdown', onPointerDown, true);
  root.addEventListener('keydown', onKeyDown, true);
  return () => {
    closePluginMenu();
    root.removeEventListener('pointerdown', onPointerDown, true);
    root.removeEventListener('keydown', onKeyDown, true);
  };
}

/** The select takes the plugin as if it had been picked from its own list. */
function choose(select, pluginId) {
  if (!pluginId || select.value === pluginId) return;
  select.value = pluginId;
  // Not one of its options: the list and the page no longer agree, and a
  // select given an unknown value quietly selects nothing at all.
  if (select.value !== pluginId) return;
  select.dispatchEvent?.(new Event('input', { bubbles: true }));
  select.dispatchEvent?.(new Event('change', { bubbles: true }));
}
