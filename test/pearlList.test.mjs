import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindPearlLists } from '../src/renderer/js/ui/omniPearl.js';

/**
 * Contract: a faceplate select opens a list the PAGE draws.
 *
 * Chromium draws a select's own list in a window of its own, which on Windows
 * is white whatever the page's `color-scheme` and the application's theme say
 * -- both were tried, and the author saw white menus over the graphite plate
 * either way. So the page draws the list, and the select underneath keeps the
 * value, the keyboard and its `change` event.
 *
 * The DOM here is the small part `bindPearlLists` touches, written out rather
 * than emulated: anything it reaches for that is missing fails loudly.
 */

function element(tag) {
  const classes = new Set();
  const node = {
    tagName: tag.toUpperCase(),
    children: [],
    parentNode: null,
    attributes: {},
    dataset: {},
    textContent: '',
    disabled: false,
    isConnected: true,
    focused: 0,
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle: (name, force) => { if (force ?? !classes.has(name)) classes.add(name); else classes.delete(name); }
    },
    get className() { return [...classes].join(' '); },
    set className(value) { classes.clear(); for (const name of String(value).split(/\s+/).filter(Boolean)) classes.add(name); },
    setAttribute: (name, value) => { node.attributes[name] = String(value); },
    getAttribute: (name) => node.attributes[name],
    append: (...items) => { for (const item of items) { item.parentNode = node; node.children.push(item); } },
    remove: () => {
      const at = node.parentNode?.children.indexOf(node) ?? -1;
      if (at >= 0) node.parentNode.children.splice(at, 1);
      node.parentNode = null;
      node.isConnected = false;
    },
    focus: () => { node.focused += 1; },
    scrollIntoView: () => {},
    // `tag`, `.class`, `.a.b`, a list of them, and `:not([disabled])`.
    matches: (selector) => String(selector).split(',').some((part) => {
      const trimmed = part.trim();
      if (trimmed.endsWith(':not([disabled])')) {
        return !node.disabled && node.matches(trimmed.slice(0, -':not([disabled])'.length));
      }
      const pieces = trimmed.split('.').filter(Boolean);
      const tagPart = trimmed.startsWith('.') ? '' : pieces[0];
      const classParts = trimmed.startsWith('.') ? pieces : pieces.slice(1);
      if (tagPart && tagPart.toUpperCase() !== node.tagName) return false;
      return classParts.every((name) => classes.has(name));
    }),
    closest: (selector) => {
      let current = node;
      while (current) {
        if (current.matches(selector)) return current;
        current = current.parentNode;
      }
      return null;
    },
    contains: (other) => {
      let current = other;
      while (current) {
        if (current === node) return true;
        current = current.parentNode;
      }
      return false;
    },
    descendants: () => node.children.flatMap((child) => [child, ...child.descendants()]),
    querySelectorAll: (selector) => node.descendants().filter((child) => child.matches(selector)),
    querySelector: (selector) => node.querySelectorAll(selector)[0] ?? null,
    listeners: new Map(),
    addEventListener: (type, fn) => node.listeners.set(`${type}`, [...(node.listeners.get(type) ?? []), fn]),
    removeEventListener: (type, fn) => node.listeners.set(type, (node.listeners.get(type) ?? []).filter((item) => item !== fn)),
    dispatchEvent: (event) => { for (const fn of node.listeners.get(event.type) ?? []) fn(event); return true; }
  };
  return node;
}

function rig({ groups = false } = {}) {
  const root = element('div');
  globalThis.document = { createElement: element };
  globalThis.Event = class { constructor(type) { this.type = type; } };
  const plate = element('div');
  plate.className = 'omni-pearl';
  const box = element('span');
  box.className = 'op-select';
  const select = element('select');
  select.className = 'op-select-native';
  select.selectedIndex = 0;
  const option = (text, { disabled = false } = {}) => {
    const item = element('option');
    item.textContent = text;
    item.disabled = disabled;
    return item;
  };
  const options = [option('— No target —'), option('Mixer 1'), option('Arpeggiator 1', { disabled: true })];
  if (groups) {
    const group = element('optgroup');
    group.label = 'One Ring';
    group.append(option('One Ring · CH 01'));
    select.append(options[0], options[1], group);
    options.push(group.children[0]);
  } else {
    select.append(...options);
  }
  select.descendants().filter((item) => item.tagName === 'OPTION').forEach((item, index) => { item.index = index; });
  box.append(select);
  plate.append(box);
  root.append(plate);
  const changes = [];
  select.addEventListener('change', () => changes.push(select.selectedIndex));
  const unbind = bindPearlLists(root);
  const press = (target) => {
    let prevented = false;
    root.dispatchEvent({ type: 'pointerdown', target, preventDefault: () => { prevented = true; } });
    return prevented;
  };
  const key = (key2, target = select, extra = {}) => root.dispatchEvent({
    type: 'keydown', target, key: key2, preventDefault: () => {}, ...extra
  });
  const click = (target) => root.dispatchEvent({ type: 'click', target, preventDefault: () => {} });
  const list = () => box.querySelector('.op-list');
  return { root, box, select, changes, unbind, press, key, click, list };
}

test('a faceplate select opens a list of its own options, the browser\'s none', () => {
  const { select, press, list, box } = rig({ groups: true });
  assert.equal(list(), null, 'nothing is open to begin with');
  assert.equal(press(select), true, 'the press that would open the browser\'s list is taken');
  const rows = list().querySelectorAll('.op-list-row');
  assert.deepEqual(rows.map((row) => row.textContent), ['— No target —', 'Mixer 1', 'One Ring · CH 01']);
  assert.deepEqual(list().querySelectorAll('.op-list-group').map((row) => row.textContent), ['One Ring']);
  assert.equal(rows[0].classList.contains('is-selected'), true, 'the one the select holds');
  assert.equal(rows[0].getAttribute('aria-selected'), 'true');
  assert.equal(list().getAttribute('role'), 'listbox');
  assert.equal(box.classList.contains('is-open'), true);
  assert.equal(select.focused > 0, true, 'the select keeps the keyboard');
});

test('a row picked becomes the select\'s value, and says so once', () => {
  const { select, press, click, changes, list, box } = rig();
  press(select);
  const rows = list().querySelectorAll('.op-list-row');
  assert.equal(rows[2].disabled, true, 'an option no one may choose is a row no one may press');
  click(rows[1]);
  assert.equal(select.selectedIndex, 1);
  assert.deepEqual(changes, [1], 'the module hears `change`, as it did from the browser\'s list');
  assert.equal(list(), null, 'the list closes behind it');
  assert.equal(box.classList.contains('is-open'), false);

  press(select);
  click(list().querySelectorAll('.op-list-row')[1]);
  assert.deepEqual(changes, [1], 'the same value again changes nothing');
});

test('the keyboard opens it, walks it, takes one, and Escape leaves it alone', () => {
  const { select, key, changes, list } = rig();
  key('Enter');
  assert.ok(list(), 'Enter opens');
  const active = () => list().querySelector('.op-list-row.is-active').textContent;
  assert.equal(active(), '— No target —');
  key('ArrowDown');
  assert.equal(active(), 'Mixer 1');
  key('ArrowDown');
  assert.equal(active(), 'Mixer 1', 'a disabled row is not walked onto');
  key('Enter');
  assert.deepEqual(changes, [1]);
  assert.equal(list(), null);

  key('Enter');
  key('ArrowDown');
  key('Escape');
  assert.equal(list(), null, 'Escape closes');
  assert.deepEqual(changes, [1], 'and takes nothing');
});

test('a press elsewhere closes it, and unbinding leaves nothing listening', () => {
  const { root, select, press, list, unbind } = rig();
  press(select);
  assert.ok(list());
  press(root);
  assert.equal(list(), null);

  press(select);
  assert.ok(list());
  unbind();
  assert.equal(list(), null, 'unbinding takes the open list with it');
  assert.equal(press(select), false, 'and the press goes back to the browser');
  assert.equal([...root.listeners.values()].every((items) => items.length === 0), true);
});
