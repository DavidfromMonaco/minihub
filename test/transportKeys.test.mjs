import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installTransportKeys, isTransportSpace } from '../src/renderer/js/ui/transportKeys.js';

/**
 * Contract: Space plays, and Space stops, on every page. Asked by the author
 * on 2026-09-25.
 */

const target = (tag, type) => ({ nodeType: 1, tagName: tag.toUpperCase(), type: type || '' });
const key = (over = {}) => ({
  key: ' ', code: 'Space', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false,
  target: null, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...over
});

test('Space alone, anywhere but a caret or a list, is the transport', () => {
  assert.equal(isTransportSpace(key()), true);
  assert.equal(isTransportSpace(key({ target: target('button') })), true, 'a focused button does not keep it');
  assert.equal(isTransportSpace(key({ target: target('input', 'checkbox') })), true);
  assert.equal(isTransportSpace(key({ target: target('input', 'text') })), false, 'a space typed in a name');
  assert.equal(isTransportSpace(key({ target: target('input', 'number') })), false);
  assert.equal(isTransportSpace(key({ target: target('textarea') })), false);
  assert.equal(isTransportSpace(key({ target: target('select') })), false, 'Space opens a list');
  assert.equal(isTransportSpace(key({ defaultPrevented: true })), false, 'a control that took it keeps it');
  assert.equal(isTransportSpace(key({ repeat: true })), false, 'held down, it does not flicker');
  assert.equal(isTransportSpace(key({ ctrlKey: true })), false);
  assert.equal(isTransportSpace(key({ shiftKey: true })), false);
  assert.equal(isTransportSpace(key({ key: 'a', code: 'KeyA' })), false);
});

function rig(state = {}) {
  const listeners = {};
  const win = {
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || new Set()).add(fn); },
    removeEventListener: (type, fn) => { listeners[type]?.delete(fn); }
  };
  const calls = [];
  const sequencer = {
    playing: false, recording: false, preCounting: false, ...state,
    playTransport() { calls.push('play'); this.playing = true; },
    stopTransport() { calls.push('stop'); this.playing = false; }
  };
  const remove = installTransportKeys({ sequencer }, { target: win });
  const press = (type, event) => { listeners[type]?.forEach((fn) => fn(event)); return event; };
  return { press, calls, sequencer, remove, listeners };
}

test('pressed twice, it plays and then stops', () => {
  const { press, calls } = rig();
  assert.equal(press('keydown', key()).defaultPrevented, true, 'the page does not scroll');
  press('keyup', key());
  press('keydown', key());
  assert.deepEqual(calls, ['play', 'stop']);
});

test('a take or a count-in is stopped, not played over', () => {
  for (const state of [{ recording: true }, { preCounting: true }]) {
    const { press, calls } = rig(state);
    press('keydown', key());
    assert.deepEqual(calls, ['stop']);
  }
});

test('the release of a Space it took does not press the focused button again', () => {
  const { press } = rig();
  press('keydown', key({ target: target('button') }));
  assert.equal(press('keyup', key({ target: target('button') })).defaultPrevented, true);
  assert.equal(press('keyup', key()).defaultPrevented, false, 'only that one release');
});

test('a space typed in a field is left to the field', () => {
  const { press, calls } = rig();
  const typed = press('keydown', key({ target: target('input', 'text') }));
  assert.equal(typed.defaultPrevented, false);
  assert.equal(press('keyup', key({ target: target('input', 'text') })).defaultPrevented, false);
  assert.deepEqual(calls, []);
});

test('removing it removes both listeners', () => {
  const { remove, listeners } = rig();
  remove();
  assert.equal(listeners.keydown.size, 0);
  assert.equal(listeners.keyup.size, 0);
});
