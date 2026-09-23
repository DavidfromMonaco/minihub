import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeFullHub } from './helpers.mjs';
import { makeEl, installDom, fire } from './domShim.mjs';

/**
 * The NODES list is arranged by hand: press a node, drag it, let go where the
 * line is. Asked 2026-09-24 -- "just grab them and move them, no arrows to
 * click". What this holds: the order lives in `hub.nodes` and so in the
 * project, a click is still a click, and a node an undo brings back returns to
 * its place instead of the bottom of the list.
 */

installDom();
const { buildSidebar, dropPosition } = await import('../src/renderer/js/ui/sidebar.js');
const { createRoutingModule } = await import('../src/renderer/js/modules/routing/routingModule.js');

const ROW = 36;

/** A sidebar whose rows are laid out one under another, ROW px apart. */
function setup() {
  const hub = makeFullHub();
  hub.modules.register(createRoutingModule(hub));
  const sidebarEl = makeEl('nav');
  sidebarEl.getBoundingClientRect = () => ({ left: 0, top: 0, width: 220, height: 2000 });
  // What a click opens is recorded rather than mounted: mounting a node's
  // page is the page's business, and this shim has no engine to give it.
  hub.modules.activate = (id) => { hub.modules.activeId = id; return true; };
  buildSidebar(hub, sidebarEl, makeEl('main'));
  const layout = () => {
    sidebarEl.children.forEach((child, index) => {
      child.getBoundingClientRect = () => ({ left: 0, top: index * ROW, width: 200, height: ROW - 2 });
    });
  };
  return { hub, sidebarEl, layout };
}

const nodeItems = (sidebarEl) => sidebarEl.children
  .filter((child) => child._classSet.has('nav-item'))
  .map((child) => child.getAttribute('data-module-id'));
const itemFor = (sidebarEl, id) => sidebarEl.children.find((child) => child.getAttribute?.('data-module-id') === id);
const centreOf = (element) => {
  const rect = element.getBoundingClientRect();
  return rect.top + rect.height / 2;
};

test('a drop position is before the row under the pointer, and nothing for a move that moves nothing', () => {
  const items = ['a', 'b', 'c', 'd'].map((id, index) => ({ id, top: index * 10, height: 10 }));
  assert.deepEqual(dropPosition(items, 'd', 2), { beforeId: 'a', markId: 'a', edge: 'before' });
  assert.deepEqual(dropPosition(items, 'a', 38), { beforeId: null, markId: 'd', edge: 'after' }, 'below the last: after it');
  assert.deepEqual(dropPosition(items, 'a', 99), { beforeId: null, markId: 'd', edge: 'after' });
  assert.equal(dropPosition(items, 'b', 12), null, 'over itself');
  assert.equal(dropPosition(items, 'b', 22), null, 'just after itself is where it already is');
  assert.equal(dropPosition(items, 'x', 5), null, 'a node that is not in the list');
});

test('the order is kept by the node manager, and saved with the nodes', () => {
  const hub = makeFullHub();
  const a = hub.nodes.create('vst');
  const b = hub.nodes.create('mixer');
  const c = hub.nodes.create('vst');
  assert.equal(hub.nodes.move(c.id, a.id), true);
  assert.deepEqual(hub.nodes.list().map((node) => node.id), [c.id, a.id, b.id]);
  assert.deepEqual(hub.settings.get('nodeInstances').instances.map((entry) => entry.id), [c.id, a.id, b.id],
    'the project writes the nodes in the order they are listed');
  assert.equal(hub.nodes.move(c.id, null), true, 'null is the end of the list');
  assert.deepEqual(hub.nodes.list().map((node) => node.id), [a.id, b.id, c.id]);
  assert.equal(hub.nodes.move(c.id, null), false, 'already there');
  assert.equal(hub.nodes.move('nope', a.id), false);
  assert.equal(hub.nodes.move(a.id, 'nope'), false);
  assert.equal(c.name, 'VST 2', 'a node keeps its name wherever it is put');
});

test('dragging a node up the list puts it there, and the list redraws in that order', () => {
  const { hub, sidebarEl, layout } = setup();
  const [vst1, player, vst2] = [hub.nodes.create('vst'), hub.nodes.create('mixer'), hub.nodes.create('vst')];
  layout();
  assert.deepEqual(nodeItems(sidebarEl), ['routing', vst1.id, player.id, vst2.id]);

  const dragged = itemFor(sidebarEl, vst2.id);
  const above = itemFor(sidebarEl, vst1.id);
  fire(dragged, 'pointerdown', { button: 0, clientY: centreOf(dragged) });
  fire(globalThis.document, 'pointermove', { clientY: centreOf(above) - 8 });
  assert.ok(dragged._classSet.has('nav-dragging'), 'the node held is marked');
  assert.ok(above._classSet.has('nav-drop-before'), 'and a line is drawn above the node it will land before');
  fire(globalThis.document, 'pointerup', {});

  assert.deepEqual(nodeItems(sidebarEl), ['routing', vst2.id, vst1.id, player.id], 'Routing stays first');
  assert.deepEqual(hub.nodes.list().map((node) => node.id), [vst2.id, vst1.id, player.id]);
  assert.ok(!sidebarEl._classSet.has('nav-reordering'));
});

test('a press that barely moves is a click and opens the node', () => {
  const { hub, sidebarEl, layout } = setup();
  const [first, second] = [hub.nodes.create('vst'), hub.nodes.create('vst')];
  layout();
  const item = itemFor(sidebarEl, second.id);
  fire(item, 'pointerdown', { button: 0, clientY: centreOf(item) });
  fire(globalThis.document, 'pointermove', { clientY: centreOf(item) - 3 });
  fire(globalThis.document, 'pointerup', {});
  assert.deepEqual(hub.nodes.list().map((node) => node.id), [first.id, second.id], 'nothing moved');
  assert.ok(!item._classSet.has('nav-dragging'));
  fire(item, 'click', {});
  assert.equal(hub.modules.activeId, second.id, 'and the click still opens it');
});

test('the click after a drag does not open the node just moved, and Escape cancels', async () => {
  const { hub, sidebarEl, layout } = setup();
  const [first, second] = [hub.nodes.create('vst'), hub.nodes.create('vst')];
  layout();
  const item = itemFor(sidebarEl, second.id);
  fire(item, 'pointerdown', { button: 0, clientY: centreOf(item) });
  fire(globalThis.document, 'pointermove', { clientY: 0 });
  const listeners = globalThis.document._listeners;
  [...(listeners.keydown || [])].forEach((fn) => fn({ key: 'Escape' }));
  assert.deepEqual(hub.nodes.list().map((node) => node.id), [first.id, second.id], 'Escape leaves the list as it was');
  fire(item, 'click', {});
  assert.notEqual(hub.modules.activeId, second.id, 'the release of a drag is not a click');
  await new Promise((resolve) => setTimeout(resolve, 5));
  fire(item, 'click', {});
  assert.equal(hub.modules.activeId, second.id, 'the next real click is');
  assert.equal((listeners.pointermove || new Set()).size, 0, 'and the drag left nothing on the document');
});

test('Routing and the system pages cannot be dragged', () => {
  const { hub, sidebarEl } = setup();
  hub.nodes.create('vst');
  const movable = sidebarEl.children.filter((child) => child._classSet.has('nav-movable'))
    .map((child) => child.getAttribute('data-module-id'));
  assert.deepEqual(movable, [hub.nodes.list()[0].id]);
});

test('the drop line and the held node have a rule in the shell sheet', () => {
  const css = fs.readFileSync(new URL('../src/renderer/styles/base.css', import.meta.url), 'utf8');
  for (const rule of ['.nav-item.nav-dragging', '.nav-item.nav-drop-before', '.nav-item.nav-drop-after']) {
    assert.ok(css.includes(`${rule} {`), `${rule} is styled`);
  }
});

test('the arrangement toolbar wraps instead of widening the page', () => {
  const css = fs.readFileSync(new URL('../src/renderer/styles/base.css', import.meta.url), 'utf8');
  assert.match(css, /\.sequencer-page \{[^}]*grid-template-columns:minmax\(0,1fr\)/,
    'the page column is held to the window, not to its widest child');
  assert.match(css, /\.seq-toolbar > \.row:first-child \{ flex-wrap:wrap;/);
});
