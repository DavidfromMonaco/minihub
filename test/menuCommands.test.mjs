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
      newFromBasicTemplate: () => calls.push('newFromBasicTemplate'),
      load: (filePath) => calls.push(`load:${filePath === undefined ? 'picker' : filePath}`),
      save: (as) => calls.push(`save:${as === true ? 'as' : 'here'}`)
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
    'newProject', 'newFromBasicTemplate', 'load:picker', 'save:here', 'save:as'
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
