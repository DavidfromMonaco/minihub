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
  { command: 'project:save-as', label: 'Save &As…', accelerator: 'CmdOrCtrl+Shift+S' }
]);

/**
 * The commands this menu can send, in menu order. The renderer keeps the other
 * half of the pair (`core/menuCommands.js`); a test compares the two lists,
 * because a command nobody answers is a menu entry that does nothing at all.
 */
const MENU_COMMANDS = Object.freeze(
  PROJECT_ITEMS.filter((item) => item.command).map((item) => item.command)
);

const CHANNEL = 'menu:command';

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

module.exports = { CHANNEL, MENU_COMMANDS, appMenuTemplate, installAppMenu };
