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
 * The interface's layouts, at the top of View: the same choice as the two
 * keys in the header (ui/interfaceLayout.js), for whoever looks in a menu.
 */
const LAYOUT_ITEMS = Object.freeze([
  { command: 'view:layout-original', label: 'Interface: &Original' },
  { command: 'view:layout-hybrid-1', label: 'Interface: &Hybrid 1' }
]);

/**
 * The commands this menu can send, in menu order. The renderer keeps the other
 * half of the pair (`core/menuCommands.js`); a test compares the two lists,
 * because a command nobody answers is a menu entry that does nothing at all.
 */
const MENU_COMMANDS = Object.freeze(
  [...PROJECT_ITEMS, ...EDIT_ITEMS, ...LAYOUT_ITEMS].filter((item) => item.command).map((item) => item.command)
);

const CHANNEL = 'menu:command';

/**
 * The window has no native title bar since 2026-09-25 (D-055): the header is
 * drawn by the page and carries File, Edit and View as buttons, and the page
 * draws their menus too, in its own typeface -- a menu Windows drew was the
 * last Segoe UI on screen. It draws them FROM this file: `describeAppMenu`
 * reads the same lists the native menu is built from, and a choice comes back
 * as an index that `invokeAppMenu` clicks on the native item. One list of
 * entries, and the roles (Exit, Zoom, Full Screen) still performed by
 * Electron. The native menu stays installed, hidden: it is what answers the
 * accelerators.
 */
const DESCRIBE_CHANNEL = 'menu:describe';
const INVOKE_CHANNEL = 'menu:invoke';
const MENU_NAMES = Object.freeze(['file', 'edit', 'view']);

/**
 * The View menu's entries. Electron gives a role its label and its keystroke;
 * they are written here as well so the drawn menu shows what the native one
 * would, and `hint` is that keystroke as Windows spells it.
 */
const VIEW_ITEMS = Object.freeze([
  { role: 'resetZoom', label: 'Actual Size', hint: 'Ctrl+0' },
  { role: 'zoomIn', label: 'Zoom In', hint: 'Ctrl++' },
  { role: 'zoomOut', label: 'Zoom Out', hint: 'Ctrl+-' },
  { separator: true },
  { role: 'togglefullscreen', label: 'Toggle Full Screen', hint: 'F11' },
  { separator: true },
  { role: 'toggleDevTools', label: 'Toggle Developer Tools', hint: 'Ctrl+Shift+I' }
]);

function appMenuTemplate(send) {
  const commandItems = (items) => items.map((item) => (item.separator
    ? { type: 'separator' }
    : { label: item.label, accelerator: item.accelerator, click: () => send(item.command) }));
  return [
    {
      label: '&File',
      submenu: [...commandItems(PROJECT_ITEMS), { type: 'separator' }, { role: 'quit', label: 'E&xit' }]
    },
    {
      label: '&Edit',
      submenu: commandItems(EDIT_ITEMS)
    },
    {
      label: '&View',
      submenu: [...commandItems(LAYOUT_ITEMS), { type: 'separator' }, ...VIEW_ITEMS.map((item) => (item.separator
        ? { type: 'separator' }
        : { role: item.role, label: item.label }))]
    }
  ];
}

/** "CmdOrCtrl+Shift+S" as a Windows menu writes it: "Ctrl+Shift+S". */
function acceleratorHint(accelerator) {
  return String(accelerator || '').replace(/CmdOrCtrl|CommandOrControl/g, 'Ctrl');
}

/**
 * The three menus as the page draws them: names, then entries with their
 * label (without the `&` of an access key) and keystroke, in the native
 * menu's order, so an entry's index is the native item's.
 */
function describeAppMenu() {
  return appMenuTemplate(() => {}).map((top, i) => ({
    id: MENU_NAMES[i],
    label: top.label.replace('&', ''),
    items: top.submenu.map((item, index) => {
      if (item.type === 'separator') return { separator: true };
      const view = VIEW_ITEMS.find((entry) => entry.role && entry.role === item.role);
      return {
        index,
        label: String(item.label || '').replace('&', ''),
        hint: view ? view.hint : acceleratorHint(item.accelerator)
      };
    })
  }));
}

/**
 * Perform one entry the page chose: the native item's own click, which runs a
 * role or sends a command exactly as the menu bar did. Anything but a known
 * menu and an index that names a real entry is ignored.
 */
function invokeAppMenu({ menu, window, which, index }) {
  if (!menu || !window || window.isDestroyed?.()) return false;
  if (!MENU_NAMES.includes(which) || !Number.isSafeInteger(index) || index < 0) return false;
  const item = menu.items?.[MENU_NAMES.indexOf(which)]?.submenu?.items?.[index];
  if (!item || item.type === 'separator' || item.enabled === false || typeof item.click !== 'function') return false;
  item.click(undefined, window, window.webContents);
  return true;
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

module.exports = {
  CHANNEL, DESCRIBE_CHANNEL, INVOKE_CHANNEL, MENU_NAMES, MENU_COMMANDS,
  appMenuTemplate, describeAppMenu, installAppMenu, invokeAppMenu
};
