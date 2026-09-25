/**
 * Tooltips drawn by the page, in its typeface (D-055).
 *
 * A `title` attribute is a tooltip Windows draws, in Segoe UI, and MiniHub
 * has hundreds of them. Rather than rewrite each one, this reads them where
 * they are: while the pointer is over an element carrying a `title` (or a
 * `data-tip`), the text is taken off the attribute -- so Windows has nothing
 * to show -- and drawn in a small panel instead; when the pointer leaves, the
 * attribute is put back, so everything that reads a `title` still finds it.
 * A title set again while the pointer is on its element is taken off again.
 *
 * One listener set on the document, delegated, installed once per window.
 * The panel is built with `textContent` (invariant 9) and placed through the
 * CSSOM (invariant 10).
 */

const SHOW_DELAY_MS = 450;
// Moving from one tooltip to the next within this, the next shows at once,
// as a toolbar's tooltips do.
const WARM_MS = 400;
const GAP = 6;
const MARGIN = 8;

export function installTooltips(doc = globalThis.document) {
  if (!doc?.addEventListener) return () => {};
  const view = doc.defaultView || globalThis;
  let current = null;   // the element whose text is taken
  let panel = null;
  let timer = null;
  let hiddenAt = 0;

  const take = (el) => {
    const title = el.getAttribute('title');
    if (title === null) return;
    el.removeAttribute('title');
    if (title) el.setAttribute('data-tip-title', title);
    if (panel && current === el) panel.textContent = title;
  };
  const giveBack = (el) => {
    if (!el) return;
    const title = el.getAttribute('data-tip-title');
    if (title === null) return;
    el.removeAttribute('data-tip-title');
    if (!el.hasAttribute('title')) el.setAttribute('title', title);
  };
  const textOf = (el) => el.getAttribute('data-tip-title') || el.getAttribute('data-tip') || '';

  const hide = () => {
    clearTimeout(timer);
    timer = null;
    if (panel) {
      panel.remove();
      panel = null;
      hiddenAt = Date.now();
    }
  };

  const show = () => {
    timer = null;
    const el = current;
    const text = el && textOf(el);
    if (!text || !el.isConnected) return;
    panel = doc.createElement('div');
    panel.setAttribute('class', 'tooltip');
    panel.setAttribute('role', 'tooltip');
    panel.textContent = text;
    doc.body.appendChild(panel);
    const box = el.getBoundingClientRect();
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    const vw = Number(view.innerWidth) || 0;
    const vh = Number(view.innerHeight) || 0;
    let top = box.bottom + GAP;
    if (vh && top + height > vh - MARGIN) top = Math.max(MARGIN, box.top - GAP - height);
    let left = box.left + box.width / 2 - width / 2;
    if (vw) left = Math.max(MARGIN, Math.min(left, vw - width - MARGIN));
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
  };

  const leave = () => {
    hide();
    giveBack(current);
    current = null;
  };

  const onOver = (event) => {
    const el = event.target?.closest?.('[title], [data-tip-title], [data-tip]');
    if (el === current) {
      if (el) take(el);
      return;
    }
    leave();
    if (!el) return;
    current = el;
    take(el);
    if (!textOf(el)) return;
    timer = setTimeout(show, Date.now() - hiddenAt < WARM_MS ? 0 : SHOW_DELAY_MS);
  };
  const onOut = (event) => {
    if (!current) return;
    const to = event.relatedTarget;
    if (to && current.contains?.(to)) return;
    leave();
  };
  const onMove = () => { if (current?.hasAttribute('title')) take(current); };
  // A press, a key, a wheel or a scroll ends a tooltip, as on Windows; the
  // element keeps its text taken until the pointer leaves it.
  const dismiss = () => hide();

  const listeners = [
    ['pointerover', onOver], ['pointerout', onOut], ['pointermove', onMove],
    ['pointerdown', dismiss], ['keydown', dismiss], ['wheel', dismiss], ['scroll', dismiss]
  ];
  listeners.forEach(([type, fn]) => doc.addEventListener(type, fn, true));
  view.addEventListener?.('blur', leave);
  return () => {
    listeners.forEach(([type, fn]) => doc.removeEventListener(type, fn, true));
    view.removeEventListener?.('blur', leave);
    leave();
  };
}
