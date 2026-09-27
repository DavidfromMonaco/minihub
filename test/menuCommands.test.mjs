import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { MENU_COMMANDS, bindMenuCommands } from '../src/renderer/js/core/menuCommands.js';

const require = createRequire(import.meta.url);
const mainMenu = require('../src/main/appMenu.js');

/** A hub reduced to what the menu commands touch: the project manager. */
function makeHub() {
  const calls = [];
  return {
    calls,
    project: {
      newProject: () => calls.push('newProject'),
      newFromTemplate: () => calls.push('newFromTemplate'),
      load: (filePath) => calls.push(`load:${filePath === undefined ? 'picker' : filePath}`),
      save: (as) => calls.push(`save:${as === true ? 'as' : 'here'}`),
      saveAsTemplate: () => calls.push('saveAsTemplate')
    }
  };
}

/** The preload's `onMenuCommand`, with the send side exposed to the test. */
function makeApi() {
  let listener = null;
  return {
    onMenuCommand: (callback) => { listener = callback; return () => { listener = null; }; },
    send: (command) => listener?.(command),
    get bound() { return listener !== null; }
  };
}

test('the menu and the renderer answer the same list of commands', () => {
  assert.deepEqual([...MENU_COMMANDS], [...mainMenu.MENU_COMMANDS]);
});

test('each command runs its project action', () => {
  const hub = makeHub();
  const api = makeApi();
  bindMenuCommands(hub, api);
  MENU_COMMANDS.forEach((command) => api.send(command));
  assert.deepEqual(hub.calls, [
    'newProject', 'newFromTemplate', 'load:picker', 'save:here', 'save:as', 'saveAsTemplate'
  ]);
});

test('Save asks the project manager to save in place, Save As to pick a name', () => {
  const hub = makeHub();
  const api = makeApi();
  bindMenuCommands(hub, api);
  api.send('project:save');
  api.send('project:save-as');
  assert.deepEqual(hub.calls, ['save:here', 'save:as']);
});

test('an unknown command does nothing at all', () => {
  const hub = makeHub();
  const api = makeApi();
  bindMenuCommands(hub, api);
  api.send('project:burn-it-down');
  api.send('constructor');
  api.send('__proto__');
  assert.deepEqual(hub.calls, []);
});

test('unsubscribing stops the menu, and no API is not a crash', () => {
  const hub = makeHub();
  const api = makeApi();
  const unbind = bindMenuCommands(hub, api);
  unbind();
  api.send('project:save');
  assert.deepEqual(hub.calls, [], 'a page that unbound is no longer driven by the menu');
  assert.equal(typeof bindMenuCommands(hub, {}), 'function', 'a preload without the channel is survivable');
});

// ---- the header's File / Edit / View (D-055) ---------------------------------

test('the drawn menus are described from the native template, entry for entry', () => {
  const described = mainMenu.describeAppMenu();
  const template = mainMenu.appMenuTemplate(() => {});
  assert.deepEqual(described.map((menu) => menu.id), mainMenu.MENU_NAMES);
  assert.deepEqual(described.map((menu) => menu.label), ['File', 'Edit', 'View', 'Help'], 'without the access-key ampersand');
  described.forEach((menu, m) => {
    assert.equal(menu.items.length, template[m].submenu.length, `${menu.id}: one entry per native item`);
    menu.items.forEach((item, i) => {
      if (template[m].submenu[i].type === 'separator') assert.deepEqual(item, { separator: true });
      else assert.equal(item.index, i, 'an entry names its native item by position');
    });
  });
  const file = described[0].items;
  assert.deepEqual(file.find((item) => item.label === 'Save As…'), { index: 6, label: 'Save As…', hint: 'Ctrl+Shift+S' });
  assert.equal(file.at(-1).label, 'Exit');
  assert.equal(described[2].items.find((item) => item.label === 'Zoom In').hint, 'Ctrl++', 'a role shows its keystroke too');
});

test('a chosen entry is performed by the native item, and nothing else is', () => {
  const clicked = [];
  const item = (name, extra = {}) => ({ type: 'normal', click: (...args) => clicked.push([name, ...args]), ...extra });
  const window = { isDestroyed: () => false, webContents: { id: 1 } };
  const menu = { items: [
    { submenu: { items: [item('new'), { type: 'separator' }, item('open')] } },
    { submenu: { items: [item('undo', { enabled: false })] } },
    { submenu: { items: [item('zoom')] } }
  ] };
  assert.equal(mainMenu.invokeAppMenu({ menu, window, which: 'file', index: 2 }), true);
  assert.deepEqual(clicked, [['open', undefined, window, window.webContents]], 'with the window, as the menu bar would');
  for (const [which, index] of [['file', 1], ['edit', 0], ['help', 0], ['file', 9], ['file', -1], ['file', 1.5], ['__proto__', 0]]) {
    assert.equal(mainMenu.invokeAppMenu({ menu, window, which, index }), false, `refuses ${which} ${index}`);
  }
  assert.equal(clicked.length, 1);
});
