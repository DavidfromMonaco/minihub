'use strict';

/**
 * The application menu.
 *
 * Project actions used to be two buttons pinned in the header, which left
 * MiniHub with a Save the user could see and an Open they had to walk back to
 * Home to find. The menu is where a desktop application keeps both, under the
 * accelerators every other one uses.
 *
 * The menu decides nothing. It names a command and hands it to the renderer,
 * which owns the project state -- the dirty flag, the recording block, the
 * discard prompt. A menu that greyed its own items out would need a second copy
 * of that state up here, and the two copies would drift apart.
 *
 * Setting an application menu REPLACES Electron's default one, so anything the
 * default gave and MiniHub still wants is spelled out below. Two things are
 * deliberately not carried over: the Edit roles, because Chromium already
 * handles Ctrl+C/V/X/A inside a text field on Windows without a menu, and
 * Reload, because a renderer reload silently discards an unsaved project.
 */

const PROJECT_ITEMS = Object.freeze([
  { command: 'project:new', label: '&New Project', accelerator: 'CmdOrCtrl+N' },
  { command: 'project:template', label: 'New from &Template' },
  { separator: true },
  { command: 'project:open', label: '&Open Project…', accelerator: 'CmdOrCtrl+O' },
  { separator: true },
  { command: 'project:save', label: '&Save', accelerator: 'CmdOrCtrl+S' },
  { command: 'project:save-as', label: 'Save &As…', accelerator: 'CmdOrCtrl+Shift+S' },
  // No accelerator, deliberately. Saving a template is a decision taken once
  // for a setup, not a reflex like Ctrl+S, and a keystroke next to Save As is a
  // keystroke pressed by mistake.
  { command: 'project:save-as-template', label: 'Save as Te&mplate…' }
]);

/**
 * The two entries of the Edit menu.
 *
 * The Edit ROLES are still deliberately absent -- Chromium already answers
 * Ctrl+C/V/X/A inside a text field without a menu. These two are different:
 * nothing else in the application answers them, and the accelerators are
 * declared here so the menu SHOWS them. The renderer binds the same keystrokes
 * on `window` for the pages and windows a menu accelerator does not reach.
 */
const EDIT_ITEMS = Object.freeze([
  { command: 'edit:undo', label: '&Undo', accelerator: 'CmdOrCtrl+Z' },
  { command: 'edit:redo', label: '&Redo', accelerator: 'CmdOrCtrl+Shift+Z' }
]);

/**
 * The commands this menu can send, in menu order. The renderer keeps the other
 * half of the pair (`core/menuCommands.js`); a test compares the two lists,
 * because a command nobody answers is a menu entry that does nothing at all.
 */
const MENU_COMMANDS = Object.freeze(
  [...PROJECT_ITEMS, ...EDIT_ITEMS].filter((item) => item.command).map((item) => item.command)
);

const CHANNEL = 'menu:command';

/**
 * The window has no native title bar since 2026-09-25 (D-055): the header is
 * drawn by the page and carries File, Edit and View as buttons. A button opens
 * the SAME menu, popped up under it -- never a copy drawn in HTML, which would
 * be a second list of items to keep in step with this one, and would lose the
 * roles (Exit, Zoom, Full Screen) that only Electron can perform.
 */
const POPUP_CHANNEL = 'menu:popup';
const POPUP_MENUS = Object.freeze(['file', 'edit', 'view']);

function appMenuTemplate(send) {
  const projectItems = PROJECT_ITEMS.map((item) => (item.separator
    ? { type: 'separator' }
    : { label: item.label, accelerator: item.accelerator, click: () => send(item.command) }));
  return [
    {
      label: '&File',
      submenu: [...projectItems, { type: 'separator' }, { role: 'quit', label: 'E&xit' }]
    },
    {
      label: '&Edit',
      submenu: EDIT_ITEMS.map((item) => ({
        label: item.label, accelerator: item.accelerator, click: () => send(item.command)
      }))
    },
    {
      label: '&View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'toggleDevTools' }
      ]
    }
  ];
}

/**
 * Build the menu and hang it on the application.
 *
 * Commands always go to the main window, never to whichever window happens to
 * hold focus: Ctrl+S pressed over a Clip Editor still means "save the project",
 * and the project lives in the main renderer.
 */
function installAppMenu({ Menu, window }) {
  const send = (command) => {
    if (!window || window.isDestroyed?.()) return;
    window.webContents?.send(CHANNEL, command);
  };
  const menu = Menu.buildFromTemplate(appMenuTemplate(send));
  Menu.setApplicationMenu(menu);
  return menu;
}

/**
 * Pop one of the menu's three submenus at a point of the window.
 *
 * `x` and `y` come from the page in CSS pixels; the window's zoom (View > Zoom
 * In) makes those larger than the DIPs a popup is placed in, hence the factor.
 * Anything but a known menu name and two finite numbers is ignored: the page
 * asks, it does not describe a menu.
 */
function popupAppMenu({ menu, window, which, x, y, zoomFactor = 1 }) {
  if (!menu || !window || window.isDestroyed?.()) return false;
  if (!POPUP_MENUS.includes(which) || !Number.isFinite(x) || !Number.isFinite(y)) return false;
  const item = menu.items?.[POPUP_MENUS.indexOf(which)];
  if (!item?.submenu) return false;
  const factor = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  item.submenu.popup({ window, x: Math.round(x * factor), y: Math.round(y * factor) });
  return true;
}

module.exports = { CHANNEL, POPUP_CHANNEL, POPUP_MENUS, MENU_COMMANDS, appMenuTemplate, installAppMenu, popupAppMenu };
