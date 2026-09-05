import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFullHub } from './helpers.mjs';
import { makeEl, installDom } from './domShim.mjs';

/**
 * Sidebar grouping contract (TASK 2).
 *
 * The sidebar must render three deterministic sections — HOME, SYSTEM, NODES —
 * driven by `navEntry.group` metadata. Empty sections are hidden, dynamic
 * nodes keep creation order, and active/selected state still works.
 */

installDom();
const { buildSidebar } = await import('../src/renderer/js/ui/sidebar.js');
const { homeModule } = await import('../src/renderer/js/modules/home/homeModule.js');
const { createMiniLabModule } = await import('../src/renderer/js/modules/minilab/minilabModule.js');
const { createRoutingModule } = await import('../src/renderer/js/modules/routing/routingModule.js');
const { createAudioOutputModule } = await import('../src/renderer/js/modules/audioOutput/audioOutputModule.js');

function setup() {
  const hub = makeFullHub();
  hub.modules.register(homeModule);
  hub.modules.register(createMiniLabModule(hub));
  hub.modules.register(createRoutingModule(hub));
  hub.modules.register(createAudioOutputModule(hub));
  const sidebarEl = makeEl('nav');
  buildSidebar(hub, sidebarEl, makeEl('main'));
  return { hub, sidebarEl };
}

function groupLabels(el) {
  return el.children
    .filter((c) => c._classSet.has('sidebar-group-label'))
    .map((c) => c.textContent);
}

/** Module ids of nav items that follow `label`'s header, up to the next header. */
function idsInGroup(el, label) {
  const start = el.children.findIndex(
    (c) => c._classSet.has('sidebar-group-label') && c.textContent === label
  );
  if (start === -1) return [];
  const out = [];
  for (let i = start + 1; i < el.children.length; i += 1) {
    const c = el.children[i];
    if (c._classSet.has('sidebar-group-label')) break;
    if (c._classSet.has('nav-item')) out.push(c.getAttribute('data-module-id'));
  }
  return out;
}

// ---- grouping ---------------------------------------------------------------

test('sidebar renders Home in its own group', () => {
  const { sidebarEl } = setup();
  assert.deepEqual(groupLabels(sidebarEl), ['HOME', 'SYSTEM', 'NODES']);
  assert.deepEqual(idsInGroup(sidebarEl, 'HOME'), ['home']);
});

test('MiniLab / Audio Output render in the system group', () => {
  const { sidebarEl } = setup();
  assert.deepEqual(idsInGroup(sidebarEl, 'SYSTEM'), ['controller-minilab-3', 'audio-output']);
});

test('Routing is the first entry in the node group', () => {
  const { sidebarEl } = setup();
  const ids = idsInGroup(sidebarEl, 'NODES');
  assert.deepEqual(ids, ['routing'], 'Routing leads NODES, before any dynamic nodes');
});

test('dynamic nodes render below Routing in creation order', () => {
  const { hub, sidebarEl } = setup();
  hub.nodes.create('vst');
  hub.nodes.create('vst');
  assert.deepEqual(groupLabels(sidebarEl), ['HOME', 'SYSTEM', 'NODES']);
  const ids = idsInGroup(sidebarEl, 'NODES');
  assert.deepEqual(ids.slice(0, 1), ['routing'], 'Routing stays first');
  assert.equal(ids.length, 3);
  assert.equal(hub.nodes.get(ids[1]).name, 'VST 1');
  assert.equal(hub.nodes.get(ids[2]).name, 'VST 2');
});

test('creating/deleting a VST updates only the dynamic-node area', () => {
  const { hub, sidebarEl } = setup();
  const homeBefore = idsInGroup(sidebarEl, 'HOME');
  const systemBefore = idsInGroup(sidebarEl, 'SYSTEM');

  const node = hub.nodes.create('vst');
  assert.deepEqual(idsInGroup(sidebarEl, 'HOME'), homeBefore, 'HOME untouched');
  assert.deepEqual(idsInGroup(sidebarEl, 'SYSTEM'), systemBefore, 'SYSTEM untouched');
  assert.deepEqual(idsInGroup(sidebarEl, 'NODES'), ['routing', node.id], 'Routing + new node in NODES');

  hub.nodes.delete(node.id);
  assert.deepEqual(idsInGroup(sidebarEl, 'NODES'), ['routing'], 'Routing remains after node delete');
  assert.deepEqual(idsInGroup(sidebarEl, 'HOME'), homeBefore, 'HOME untouched after delete');
  assert.deepEqual(idsInGroup(sidebarEl, 'SYSTEM'), systemBefore, 'SYSTEM untouched after delete');
});

test('fixed navigation items carry the nav-fixed class; dynamic nodes do not', () => {
  const { hub, sidebarEl } = setup();
  hub.nodes.create('vst');
  const fixedIds = sidebarEl.children
    .filter((c) => c._classSet.has('nav-item') && c._classSet.has('nav-fixed'))
    .map((c) => c.getAttribute('data-module-id'));
  assert.deepEqual(fixedIds, ['home', 'controller-minilab-3', 'audio-output', 'routing']);
  const dynamicIds = sidebarEl.children
    .filter((c) => c._classSet.has('nav-item') && !c._classSet.has('nav-fixed'))
    .map((c) => c.getAttribute('data-module-id'));
  assert.deepEqual(dynamicIds, [hub.nodes.list()[0].id]);
});

test('active nav state still highlights the selected module', () => {
  const { hub, sidebarEl } = setup();
  // This test owns only sidebar activation state. Activate without a content
  // container so it cannot swallow a Routing mount failure caused by the
  // deliberately minimal sidebar DOM shim.
  hub.modules.activate('routing');
  const active = sidebarEl.children.filter(
    (c) => c._classSet.has('nav-item') && c._classSet.has('active')
  );
  assert.equal(active.length, 1);
  assert.equal(active[0].getAttribute('data-module-id'), 'routing');
});
