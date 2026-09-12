import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historyIntent, installHistoryKeys } from '../src/renderer/js/ui/historyKeys.js';

/**
 * Contract: one Ctrl+Z, on every page.
 *
 * Asked 2026-09-12 — "globale, qui marche de partout". The Sequencer and the
 * Patch Bay each bind `document` keydown while mounted and own their own
 * shortcuts; undo is the application's, so it lives one bubble further out and
 * answers on the Home page as readily as on a canvas.
 */

const key = (over = {}) => ({
  key: 'z', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
  target: null, preventDefault() { this.defaultPrevented = true; }, ...over
});

// ---- which keystroke means what -------------------------------------------------

test('Ctrl+Z undoes and Ctrl+Shift+Z redoes', () => {
  assert.equal(historyIntent(key({ ctrlKey: true })), 'undo');
  assert.equal(historyIntent(key({ ctrlKey: true, shiftKey: true })), 'redo');
});

test('Cmd+Z works too, so the shortcut is not a platform assumption', () => {
  assert.equal(historyIntent(key({ metaKey: true })), 'undo');
  assert.equal(historyIntent(key({ metaKey: true, shiftKey: true })), 'redo');
});

test('Ctrl+Y is the other redo Windows users reach for', () => {
  assert.equal(historyIntent(key({ ctrlKey: true, key: 'y' })), 'redo');
  assert.equal(historyIntent(key({ ctrlKey: true, shiftKey: true, key: 'y' })), null);
});

test('Z alone, or with Alt, is not an undo', () => {
  assert.equal(historyIntent(key()), null);
  assert.equal(historyIntent(key({ ctrlKey: true, altKey: true })), null);
  assert.equal(historyIntent(key({ ctrlKey: true, key: 'c' })), null);
});

test('a capital Z is the same keystroke', () => {
  assert.equal(historyIntent(key({ ctrlKey: true, shiftKey: true, key: 'Z' })), 'redo');
});

// ---- what it does with it -------------------------------------------------------

function rig({ history = true } = {}) {
  const listeners = {};
  const target = {
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || new Set()).add(fn); },
    removeEventListener: (type, fn) => { listeners[type]?.delete(fn); }
  };
  const calls = [];
  const hub = history
    ? { history: { undo: () => { calls.push('undo'); }, redo: () => { calls.push('redo'); } } }
    : {};
  const remove = installHistoryKeys(hub, { target });
  const press = (event) => { listeners.keydown?.forEach((fn) => fn(event)); return event; };
  return { press, calls, remove, listeners };
}

test('the keystroke reaches the history and the browser does not also act on it', () => {
  const { press, calls } = rig();
  const event = press(key({ ctrlKey: true }));
  assert.deepEqual(calls, ['undo']);
  assert.equal(event.defaultPrevented, true);

  press(key({ ctrlKey: true, shiftKey: true }));
  assert.deepEqual(calls, ['undo', 'redo']);
});

test('a caret in a text field keeps its own undo', () => {
  const { press, calls } = rig();
  const field = { closest: (sel) => (sel.includes('input') ? field : null) };
  const event = press(key({ ctrlKey: true, target: field }));

  assert.deepEqual(calls, [], 'undoing a project edit because someone was fixing a typo is the worst first impression this could make');
  assert.equal(event.defaultPrevented, undefined, 'and the field still gets the keystroke');
});

test('before the history exists, the keystroke does nothing rather than throwing', () => {
  const { press } = rig({ history: false });
  assert.doesNotThrow(() => press(key({ ctrlKey: true })));
});

test('the listener can be removed', () => {
  const { press, calls, remove } = rig();
  remove();
  press(key({ ctrlKey: true }));
  assert.deepEqual(calls, [], 'invariant 8, even for something that lives as long as the window');
});
