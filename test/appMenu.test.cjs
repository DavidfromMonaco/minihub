'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CHANNEL, MENU_COMMANDS, appMenuTemplate, installAppMenu } = require('../src/main/appMenu');

/** Flatten a template down to the items that actually do something. */
function commandItems(template) {
  return template
    .flatMap((menu) => menu.submenu || [])
    .filter((item) => typeof item.click === 'function');
}

function findItem(template, label) {
  return template.flatMap((menu) => menu.submenu || []).find((item) => item.label === label);
}

test('the File menu carries every project command, once', () => {
  const template = appMenuTemplate(() => {});
  const file = template.find((menu) => menu.label === '&File');
  assert.ok(file, 'a desktop application has a File menu');
  const sent = [];
  const withSend = appMenuTemplate((command) => sent.push(command));
  commandItems(withSend).forEach((item) => item.click());
  assert.deepEqual(sent, [...MENU_COMMANDS], 'every command is reachable, in menu order');
  assert.equal(new Set(sent).size, sent.length, 'and no command is listed twice');
});

test('Save and Save As keep the accelerators every application uses', () => {
  const template = appMenuTemplate(() => {});
  assert.equal(findItem(template, '&Save').accelerator, 'CmdOrCtrl+S');
  assert.equal(findItem(template, 'Save &As…').accelerator, 'CmdOrCtrl+Shift+S');
  assert.equal(findItem(template, '&Open Project…').accelerator, 'CmdOrCtrl+O');
  assert.equal(findItem(template, '&New Project').accelerator, 'CmdOrCtrl+N');
});

test('no Reload item: a reload drops an unsaved project without asking', () => {
  const roles = appMenuTemplate(() => {})
    .flatMap((menu) => menu.submenu || [])
    .map((item) => item.role)
    .filter(Boolean);
  assert.equal(roles.includes('reload'), false);
  assert.equal(roles.includes('forceReload'), false);
});

test('a command reaches the main window, whatever holds focus', () => {
  const sent = [];
  const window = {
    isDestroyed: () => false,
    webContents: { send: (channel, command) => sent.push([channel, command]) }
  };
  let installed = null;
  const Menu = {
    buildFromTemplate: (template) => ({ template }),
    setApplicationMenu: (menu) => { installed = menu; }
  };
  const menu = installAppMenu({ Menu, window });
  assert.ok(installed, 'the menu is hung on the application, not just built');
  commandItems(menu.template).forEach((item) => item.click());
  assert.deepEqual(sent.map(([channel]) => channel), MENU_COMMANDS.map(() => CHANNEL));
  assert.deepEqual(sent.map(([, command]) => command), [...MENU_COMMANDS]);
});

test('a destroyed window is not written to', () => {
  const Menu = { buildFromTemplate: (template) => ({ template }), setApplicationMenu: () => {} };
  const menu = installAppMenu({
    Menu,
    window: {
      isDestroyed: () => true,
      webContents: { send: () => assert.fail('a closed window must not be sent a command') }
    }
  });
  commandItems(menu.template).forEach((item) => item.click());
});
