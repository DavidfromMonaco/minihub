/**
 * File, Edit and View drawn by the page (ui/appMenus.js, D-055): the entries
 * come from main's description, and a choice goes back as the entry's index.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fire, installDom, makeEl, menuEntries, entryLabel, openMenu, pickEntry } from './domShim.mjs';

installDom();
const { installAppMenus } = await import('../src/renderer/js/ui/appMenus.js');
const { closeContextMenu } = await import('../src/renderer/js/ui/contextMenu.js');

const DESCRIPTION = [
  { id: 'file', label: 'File', items: [
    { index: 0, label: 'New Project', hint: 'Ctrl+N' }, { separator: true }, { index: 2, label: 'Exit', hint: '' }
  ] },
  { id: 'edit', label: 'Edit', items: [{ index: 0, label: 'Undo', hint: 'Ctrl+Z' }] },
  { id: 'view', label: 'View', items: [{ index: 0, label: 'Zoom In', hint: 'Ctrl++' }] }
];

function fixture() {
  const buttons = ['file', 'edit', 'view'].map((id) => {
    const button = makeEl('button');
    button.dataset.appMenu = id;
    return button;
  });
  const root = makeEl('header');
  root.querySelectorAll = () => buttons;
  const invoked = [];
  const api = { describeAppMenu: async () => DESCRIPTION, invokeAppMenu: (menu, index) => invoked.push([menu, index]) };
  const dispose = installAppMenus({ api, root });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { buttons, root, invoked, dispose, settle };
}

test('a header button opens its menu, drawn with its entries and keystrokes', async () => {
  const { buttons, invoked, dispose, settle } = fixture();
  fire(buttons[0], 'click');
  await settle();
  assert.deepEqual(menuEntries().map(entryLabel), ['New Project', 'Exit']);
  assert.ok(openMenu()._classSet.has('app-menu-popup'));
  assert.ok(buttons[0]._classSet.has('open'));

  pickEntry('Exit');
  assert.deepEqual(invoked, [['file', 2]], 'the native item is named by its index, separators counted');
  assert.equal(openMenu(), null);
  assert.equal(buttons[0]._classSet.has('open'), false);
  dispose();
});

test('while a menu is open, moving onto the next button opens that one', async () => {
  const { buttons, dispose, settle } = fixture();
  fire(buttons[1], 'pointerenter');
  await settle();
  assert.equal(openMenu(), null, 'nothing opens on a mere hover');
  fire(buttons[0], 'click');
  await settle();
  fire(buttons[2], 'pointerenter');
  await settle();
  assert.deepEqual(menuEntries().map(entryLabel), ['Zoom In']);
  closeContextMenu();
  dispose();
});

test('Alt+E opens Edit; a click on the open menu\'s own button closes it for good', async () => {
  const { buttons, root, dispose, settle } = fixture();
  fire(root, 'keydown', { key: 'e', altKey: true });
  await settle();
  assert.deepEqual(menuEntries().map(entryLabel), ['Undo']);
  closeContextMenu();            // what the press outside does, first
  fire(buttons[1], 'click');     // then the click on the same button
  await settle();
  assert.equal(openMenu(), null, 'it stays closed');
  dispose();
  assert.equal(buttons[0]._listeners.click.size, 0, 'disposed');
});
