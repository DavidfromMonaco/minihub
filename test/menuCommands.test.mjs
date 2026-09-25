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

test('the header pops the menu\'s own submenu under the button, and nothing else', () => {
  const popped = [];
  const submenu = (name) => ({ popup: (options) => popped.push({ name, ...options }) });
  const menu = { items: mainMenu.POPUP_MENUS.map((name) => ({ submenu: submenu(name) })) };
  const window = { isDestroyed: () => false };

  assert.deepEqual(mainMenu.POPUP_MENUS, ['file', 'edit', 'view'], 'in the order the template builds them');
  assert.equal(mainMenu.popupAppMenu({ menu, window, which: 'edit', x: 100.4, y: 36, zoomFactor: 1.25 }), true);
  assert.deepEqual(popped, [{ name: 'edit', window, x: 126, y: 45 }], 'CSS pixels scaled by the zoom, then rounded');

  for (const which of ['help', '__proto__', '', undefined]) {
    assert.equal(mainMenu.popupAppMenu({ menu, window, which, x: 0, y: 0 }), false, `refuses ${String(which)}`);
  }
  assert.equal(mainMenu.popupAppMenu({ menu, window, which: 'file', x: Number.NaN, y: 0 }), false, 'refuses a point that is not one');
  assert.equal(popped.length, 1);
});

test('the three popup names are the template\'s three menus', () => {
  const labels = mainMenu.appMenuTemplate(() => {}).map((item) => item.label.replace('&', '').toLowerCase());
  assert.deepEqual(labels, mainMenu.POPUP_MENUS);
});
