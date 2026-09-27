import { openContextMenu } from './contextMenu.js';

/**
 * File, Edit and View in the header, drawn by the page (D-055).
 *
 * The entries are main's (`describeAppMenu` in src/main/appMenu.js): this file
 * draws them with the shell's own menu (`ui/contextMenu.js`) and sends back
 * the one chosen, which the native item performs -- a command, or a role such
 * as Exit or Zoom In. Nothing here knows what an entry does.
 *
 * It behaves as a menu bar does on Windows: a click opens a menu under its
 * button and a second click on the same button closes it; while one is open,
 * moving over another button opens that one; Alt+F, Alt+E, Alt+V and Alt+H
 * open them from the keyboard.
 */

// A press on the open menu's own button closes it (the menu hears the press
// outside itself first); the click that follows must not open it again.
const REOPEN_GUARD_MS = 300;

export function installAppMenus({ api = globalThis.window?.hubAPI, root = globalThis.document } = {}) {
  const buttons = [...(root?.querySelectorAll?.('[data-app-menu]') || [])];
  if (!buttons.length || typeof api?.describeAppMenu !== 'function') return () => {};

  let described = null;
  let openId = null;
  let closed = { id: null, at: 0 };
  const byId = (id) => buttons.find((button) => button.dataset.appMenu === id);

  const describe = () => {
    if (!described) described = Promise.resolve(api.describeAppMenu()).catch(() => { described = null; return []; });
    return described;
  };

  async function open(id) {
    const button = byId(id);
    const menu = (await describe()).find((entry) => entry.id === id);
    if (!button || !menu) return;
    const box = button.getBoundingClientRect();
    const items = menu.items.map((item) => (item.separator
      ? { separator: true }
      : { label: item.label, hint: item.hint || '', action: () => api.invokeAppMenu(id, item.index) }));
    buttons.forEach((each) => each.classList.toggle('open', each === button));
    button.setAttribute('aria-expanded', 'true');
    openId = id;
    openContextMenu({
      x: box.left,
      y: box.bottom + 2,
      items,
      className: 'app-menu-popup',
      onClose: () => {
        button.classList.remove('open');
        button.setAttribute('aria-expanded', 'false');
        if (openId === id) openId = null;
        closed = { id, at: Date.now() };
      }
    });
  }

  const onClick = (event) => {
    const id = event.currentTarget.dataset.appMenu;
    if (closed.id === id && Date.now() - closed.at < REOPEN_GUARD_MS) return;
    open(id);
  };
  const onEnter = (event) => {
    const id = event.currentTarget.dataset.appMenu;
    if (openId && openId !== id) open(id);
  };
  const onKey = (event) => {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const id = { f: 'file', e: 'edit', v: 'view', h: 'help' }[String(event.key).toLowerCase()];
    if (!id || !byId(id)) return;
    event.preventDefault?.();
    open(id);
  };

  buttons.forEach((button) => {
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('click', onClick);
    button.addEventListener('pointerenter', onEnter);
  });
  root.addEventListener('keydown', onKey);
  return () => {
    buttons.forEach((button) => {
      button.removeEventListener('click', onClick);
      button.removeEventListener('pointerenter', onEnter);
    });
    root.removeEventListener('keydown', onKey);
  };
}
