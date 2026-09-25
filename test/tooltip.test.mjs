/**
 * Tooltips drawn by the page (ui/tooltip.js, D-055): a `title` is taken off
 * its element while the pointer is on it -- so Windows has nothing to draw --
 * shown in the shell's own panel, and given back when the pointer leaves.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installTooltips } from '../src/renderer/js/ui/tooltip.js';

/** Just what the module touches: attributes, parents, listeners, a body. */
function fakeDocument() {
  const listeners = {};
  const make = (tag) => {
    const el = {
      tagName: tag, attrs: {}, children: [], parent: null, style: {}, textContent: '',
      isConnected: true, offsetWidth: 120, offsetHeight: 24,
      getAttribute: (k) => (k in el.attrs ? el.attrs[k] : null),
      setAttribute: (k, v) => { el.attrs[k] = String(v); },
      removeAttribute: (k) => { delete el.attrs[k]; },
      hasAttribute: (k) => k in el.attrs,
      appendChild: (child) => { child.parent = el; el.children.push(child); return child; },
      remove: () => { if (el.parent) el.parent.children.splice(el.parent.children.indexOf(el), 1); el.parent = null; },
      contains: (other) => { for (let n = other; n; n = n.parent) if (n === el) return true; return false; },
      closest: () => {
        for (let n = el; n; n = n.parent) {
          if (['title', 'data-tip-title', 'data-tip'].some((k) => k in n.attrs)) return n;
        }
        return null;
      },
      getBoundingClientRect: () => ({ left: 100, top: 10, width: 30, height: 28, bottom: 38, right: 130 })
    };
    return el;
  };
  const view = { innerWidth: 1200, innerHeight: 800, addEventListener() {}, removeEventListener() {} };
  const doc = {
    defaultView: view,
    body: make('body'),
    createElement: make,
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener: (t, fn) => { listeners[t] = (listeners[t] || []).filter((f) => f !== fn); },
    fire: (t, event) => (listeners[t] || []).forEach((fn) => fn(event))
  };
  return { doc, make };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('the title is taken while hovered, drawn in the panel, and given back', async () => {
  const { doc, make } = fakeDocument();
  const button = doc.body.appendChild(make('button'));
  button.setAttribute('title', 'Back to the start');
  const icon = button.appendChild(make('svg'));
  const dispose = installTooltips(doc);

  doc.fire('pointerover', { target: icon });
  assert.equal(button.getAttribute('title'), null, 'Windows has nothing left to draw');
  await wait(500);
  const panel = doc.body.children.find((child) => child.attrs.class === 'tooltip');
  assert.ok(panel, 'the shell draws it instead');
  assert.equal(panel.textContent, 'Back to the start');
  assert.equal(panel.style.top, '44px', 'under the element');

  doc.fire('pointerout', { target: icon, relatedTarget: doc.body });
  assert.equal(button.getAttribute('title'), 'Back to the start', 'given back on the way out');
  assert.equal(doc.body.children.includes(panel), false);
  dispose();
});

test('a title the code sets while hovered is taken too, and a press dismisses', async () => {
  const { doc, make } = fakeDocument();
  const button = doc.body.appendChild(make('button'));
  button.setAttribute('title', 'Play');
  const dispose = installTooltips(doc);
  doc.fire('pointerover', { target: button });
  await wait(500);
  button.setAttribute('title', 'Pause — a One Ring keeps running');
  doc.fire('pointermove', { target: button });
  const panel = doc.body.children.find((child) => child.attrs.class === 'tooltip');
  assert.equal(panel.textContent, 'Pause — a One Ring keeps running');
  assert.equal(button.getAttribute('title'), null);

  doc.fire('pointerdown', { target: button });
  assert.equal(doc.body.children.some((child) => child.attrs.class === 'tooltip'), false);
  doc.fire('pointerout', { target: button, relatedTarget: null });
  assert.equal(button.getAttribute('title'), 'Pause — a One Ring keeps running', 'the latest text is the one given back');
  dispose();
});

test('an SVG part names its tip with data-tip, which is never removed', async () => {
  const { doc, make } = fakeDocument();
  const chip = doc.body.appendChild(make('g'));
  chip.setAttribute('data-tip', 'Open VST 1');
  const dispose = installTooltips(doc);
  doc.fire('pointerover', { target: chip });
  await wait(500);
  assert.equal(doc.body.children.find((child) => child.attrs.class === 'tooltip')?.textContent, 'Open VST 1');
  doc.fire('pointerout', { target: chip, relatedTarget: null });
  assert.equal(chip.getAttribute('data-tip'), 'Open VST 1');
  dispose();
});
