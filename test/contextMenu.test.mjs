import { test } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';

import { fire, installDom, lastCreatedWithClass, makeEl } from './domShim.mjs';

installDom();
const { closeContextMenu, openContextMenu } = await import('../src/renderer/js/ui/contextMenu.js');

const menu = () => lastCreatedWithClass('ctx-menu');
const items = (element) => element.children.filter((child) => child._classSet.has('ctx-item'));
const labelOf = (button) => button.children.map((span) => span.textContent).join(' ');
const docListeners = (type) => globalThis.document._listeners[type]?.size || 0;

test('a menu is built from text nodes, so a clip name cannot inject markup', () => {
  let ran = 0;
  openContextMenu({
    x: 40, y: 60,
    items: [
      { label: '<img src=x onerror="alert(1)">' },
      { separator: true },
      { label: 'Delete', hint: 'Del', danger: true, action: () => { ran += 1; } },
      { label: 'Split at playhead', disabled: true, action: () => { ran += 100; } }
    ]
  });
  const element = menu();
  assert.ok(element, 'the menu is attached to the body');
  assert.equal(element.parentNode, globalThis.document.body);
  const rows = items(element);
  assert.equal(rows.length, 3);

  // The dangerous string arrives as text and stays text: there is no innerHTML
  // on this path at all, which is what makes invariant 9 structural here.
  assert.equal(labelOf(rows[0]), '<img src=x onerror="alert(1)">');
  assert.equal(rows[0].children.every((span) => span.children.length === 0), true);

  assert.equal(rows[0].disabled, true, 'a heading has no action, so it is inert');
  assert.equal(rows[2].disabled, true, 'and a disabled entry cannot be clicked');
  fire(rows[2], 'click');
  assert.equal(ran, 0);

  assert.equal(element.children.filter((child) => child._classSet.has('ctx-separator')).length, 1,
    'the separator borrows the Patch Bay menu class that already exists, rather than a second one');
  assert.equal(element.style.left, '40px');
  assert.equal(element.style.top, '60px');

  fire(rows[1], 'click');
  assert.equal(ran, 1, 'the action runs');
  assert.equal(element.parentNode, null, 'and the menu is gone before it runs');
});

test('a menu closes on everything, and leaves no listener behind', () => {
  const before = ['pointerdown', 'contextmenu', 'wheel', 'scroll', 'keydown'].map(docListeners);

  for (const [type, dispatch] of [
    ['Escape', () => [...globalThis.document._listeners.keydown].forEach((fn) => fn({ key: 'Escape', preventDefault() {} }))],
    ['a press anywhere', () => [...globalThis.document._listeners.pointerdown].forEach((fn) => fn({}))],
    ['a wheel', () => [...globalThis.document._listeners.wheel].forEach((fn) => fn({}))],
    ['a scroll', () => [...globalThis.document._listeners.scroll].forEach((fn) => fn({}))],
    ['another right-click', () => [...globalThis.document._listeners.contextmenu].forEach((fn) => fn({}))]
  ]) {
    let closes = 0;
    openContextMenu({ items: [{ label: 'Copy', action() {} }], onClose: () => { closes += 1; } });
    const element = menu();
    dispatch();
    assert.equal(element.parentNode, null, `${type} closes the menu`);
    assert.equal(closes, 1, `${type} reports the close once`);
    assert.deepEqual(['pointerdown', 'contextmenu', 'wheel', 'scroll', 'keydown'].map(docListeners), before,
      `${type} leaves no document listener behind`);
  }

  // Opening a second menu closes the first: two menus on screen is a menu
  // acting on something the user is no longer looking at.
  openContextMenu({ items: [{ label: 'First', action() {} }] });
  const first = menu();
  openContextMenu({ items: [{ label: 'Second', action() {} }] });
  assert.notEqual(menu(), first);
  assert.equal(first.parentNode, null);
  closeContextMenu();
  assert.equal(menu().parentNode, null);
  assert.deepEqual(['pointerdown', 'contextmenu', 'wheel', 'scroll', 'keydown'].map(docListeners), before);

  assert.equal(openContextMenu({ items: [] }), null, 'an empty menu is not opened');
  assert.equal(openContextMenu({ items: [{ separator: true }, { action() {} }] }), null,
    'nor one whose entries carry no label');
});

test('the menu never leaves the viewport', () => {
  // The shim reports no measured size, so a measurable menu has to be faked
  // to exercise the clamp at all -- and the unmeasured case is the other half
  // of what is being asserted here.
  const create = globalThis.document.createElement;
  globalThis.document.createElement = (tag) => {
    const element = create(tag);
    if (tag === 'div') { element.offsetWidth = 200; element.offsetHeight = 300; }
    return element;
  };
  globalThis.innerWidth = 1000;
  globalThis.innerHeight = 700;

  openContextMenu({ x: 990, y: 690, items: [{ label: 'Copy', action() {} }] });
  assert.deepEqual([menu().style.left, menu().style.top], ['792px', '392px'],
    'a menu opened at the bottom-right corner slides back inside');
  closeContextMenu();

  openContextMenu({ x: -40, y: -40, items: [{ label: 'Copy', action() {} }] });
  assert.deepEqual([menu().style.left, menu().style.top], ['8px', '8px'], 'and never off the top-left');
  closeContextMenu();

  globalThis.document.createElement = create;
  delete globalThis.innerWidth;
  delete globalThis.innerHeight;
  openContextMenu({ x: 40, y: 60, items: [{ label: 'Copy', action() {} }] });
  assert.deepEqual([menu().style.left, menu().style.top], ['40px', '60px'],
    'an unmeasurable viewport clamps nothing: folding a zero into it pins every menu to the corner');
  closeContextMenu();
});

test('the menu borrows the Patch Bay item style instead of redeclaring it', () => {
  // base.css is one sheet read top to bottom. A second bare `.ctx-item` block
  // for this module silently restyled the Patch Bay's two menus, because it
  // sat later in the file: they lost their padding, their font size and the
  // opacity on a disabled row. The reused vocabulary is the fix; this is what
  // stops it being reintroduced.
  const css = fs.readFileSync(new URL('../src/renderer/styles/base.css', import.meta.url), 'utf8');
  const bare = [...css.matchAll(/^\.ctx-item[^{]*\{/gm)].length;
  assert.equal(bare, 3, 'exactly the three unscoped .ctx-item rules the Patch Bay menu already had');
  assert.match(css, /\.ctx-menu \.ctx-item[ :.]/,
    'anything this module changes about a row is scoped to its own panel');

  const source = fs.readFileSync(new URL('../src/renderer/js/ui/contextMenu.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\.innerHTML\s*=/,
    'a clip name reaches these labels: there is no markup path for it to travel down');
  assert.match(source, /'ctx-separator'/);
});
