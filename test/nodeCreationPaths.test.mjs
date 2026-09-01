import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHub } from './helpers.mjs';

/**
 * Contract: every UI route that creates a node produces an equivalent node.
 *
 * The Patch Bay toolbar ("+ New Node") and the canvas context menu
 * ("New Node > VST") must agree on naming, graph registration, layout
 * placement and selection. They used to disagree: the toolbar called
 * `hub.nodes.create()` directly, so its nodes were never placed and never
 * selected.
 */

import { makeEl, installDom, findClass, lastCreatedWithClass } from './domShim.mjs';

installDom();
const { createRoutingModule } = await import('../src/renderer/js/modules/routing/routingModule.js');
const { ModuleSystem } = await import('../src/renderer/js/core/moduleSystem.js');
const { NodeInstanceManager } = await import('../src/renderer/js/core/nodeInstances.js');

/**
 * A container whose `innerHTML` setter rebuilds the real toolbar controls, so
 * the toolbar path is exercised rather than silently skipped.
 */
function makeContainer() {
  const container = makeEl('div');
  const svg = makeEl('svg');
  svg.setAttribute('id', 'routing-svg');
  const newBtn = makeEl('button');
  newBtn.setAttribute('id', 'routing-new-node');
  const newType = makeEl('select');
  newType.setAttribute('id', 'routing-new-type');
  Object.defineProperty(container, 'innerHTML', {
    get: () => '',
    set: () => {
      container.children.length = 0;
      container.appendChild(svg);
      container.appendChild(newBtn);
      container.appendChild(newType);
    },
    configurable: true
  });
  return { container, svg, newBtn, newType };
}

function setupHub() {
  const hub = makeHub({ graphViewport: { x: 0, y: 0, zoom: 1 } });
  const modules = new ModuleSystem(hub);
  hub.modules = modules;
  hub.nodes = new NodeInstanceManager({
    events: hub.events, settings: hub.settings, graph: hub.graph, modules
  });
  return hub;
}

const nodeEl = (svg, id) =>
  findClass(svg, 'nodes').children.find((c) => c.dataset.nodeId === id);

function fireContextMenu(svg, clientX = 400, clientY = 300) {
  const evt = {
    target: svg, clientX, clientY, button: 2,
    preventDefault() {}, stopPropagation() {}
  };
  [...(svg._listeners['contextmenu'] || [])].forEach((fn) => fn(evt));
}

function clickMenuLabel(label) {
  const menu = lastCreatedWithClass('node-context-menu');
  const stack = [...menu.children];
  while (stack.length) {
    const n = stack.pop();
    if (n._classSet.has('ctx-item') && n.textContent === label) {
      [...n._listeners['click']].forEach((fn) => fn());
      return true;
    }
    stack.push(...n.children);
  }
  return false;
}

// ---- tests ------------------------------------------------------------------

test('the Patch Bay toolbar creates a placed, selected node', () => {
  const hub = setupHub();
  const { container, svg, newBtn, newType } = makeContainer();
  createRoutingModule(hub).mount(container);

  newType.value = 'vst';
  [...newBtn._listeners['click']].forEach((fn) => fn());

  const [instance] = hub.nodes.list();
  assert.ok(instance, 'the toolbar must actually create an instance');
  assert.equal(instance.name, 'VST 1');
  assert.ok(hub.graph.getNode(instance.id), 'registered in the routing graph');
  assert.ok(hub.settings.get('graphLayout')[instance.id], 'given a layout position');
  assert.ok(nodeEl(svg, instance.id)._classSet.has('selected'), 'and selected');
});

test('toolbar and context menu produce equivalent nodes', () => {
  const viaToolbar = (() => {
    const hub = setupHub();
    const { container, newBtn, newType } = makeContainer();
    createRoutingModule(hub).mount(container);
    newType.value = 'vst';
    [...newBtn._listeners['click']].forEach((fn) => fn());
    return hub;
  })();

  const viaMenu = (() => {
    const hub = setupHub();
    const { container, svg } = makeContainer();
    createRoutingModule(hub).mount(container);
    fireContextMenu(svg);
    assert.ok(clickMenuLabel('VST'), 'the New Node submenu must offer VST');
    return hub;
  })();

  const a = viaToolbar.nodes.list()[0];
  const b = viaMenu.nodes.list()[0];

  assert.equal(a.name, b.name, 'same display name');
  assert.equal(a.id, b.id, 'same stable id for the first node of a type');
  assert.equal(a.type, b.type);
  assert.deepEqual(a.content, b.content, 'same default content');
  assert.ok(viaToolbar.graph.getNode(a.id) && viaMenu.graph.getNode(b.id), 'both registered in the graph');
  assert.ok(viaToolbar.modules.get(a.id) && viaMenu.modules.get(b.id), 'both registered as modules');
  assert.ok(
    viaToolbar.settings.get('graphLayout')[a.id] && viaMenu.settings.get('graphLayout')[b.id],
    'both placed on the canvas'
  );
});

test('hierarchical OmniBox menu creates every registered functional family', () => {
  const expected = [
    ['Arpeggiator','arpeggiator',['midi-in'],['midi-out']],
    ['Sequencer','sequencer',['midi-in','audio-in'],['midi-out','audio-out']],
    ['Audio Input','audio-input',[],['audio-out']],
    ['Mixer','mixer',['audio-in-1'],['audio-out']],
    ['Morpher','morpher',['audio-in-1'],['audio-out']],
    ['VST','vst',['midi-in','audio-in','ctrl-in'],['audio-out']]
  ];
  for (const [label,type,inputs,outputs] of expected) {
    const hub=setupHub();const {container,svg}=makeContainer();createRoutingModule(hub).mount(container);
    fireContextMenu(svg,240,180);assert.ok(clickMenuLabel(label),`OmniBox hierarchy offers ${label}`);
    const instance=hub.nodes.list()[0], graphNode=hub.graph.getNode(instance.id);
    assert.equal(instance.type,type);assert.deepEqual(graphNode.inputs.map((p)=>p.id),inputs);assert.deepEqual(graphNode.outputs.map((p)=>p.id),outputs);
    assert.ok(hub.settings.get('graphLayout')[instance.id],`${label} uses context insertion positioning`);
  }
});

test('Arpeggiator menu creation uses native defaults and persisted instance model', () => {
  const hub=setupHub();const {container,svg}=makeContainer();createRoutingModule(hub).mount(container);
  fireContextMenu(svg,320,220);assert.ok(clickMenuLabel('Arpeggiator'));
  const arp=hub.nodes.list()[0], stored=hub.settings.get('nodeInstances').instances[0];
  assert.equal(arp.id,'arpeggiator-001');assert.equal(stored.type,'arpeggiator');
  assert.equal(arp.content.mode,'Up');assert.equal(arp.content.rate,'1/16');assert.equal(arp.content.customPattern.length,32);
  assert.deepEqual(stored.content,arp.content);
});

test('every node type can be created from the toolbar with correct naming', () => {
  const hub = setupHub();
  const { container, newBtn, newType } = makeContainer();
  createRoutingModule(hub).mount(container);

  for (const type of ['vst', 'video', 'image']) {
    newType.value = type;
    [...newBtn._listeners['click']].forEach((fn) => fn());
  }

  assert.deepEqual(
    hub.nodes.list().map((n) => n.name),
    ['VST 1', 'Video 1', 'Image 1']
  );
});
