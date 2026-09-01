import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHub } from './helpers.mjs';
import { makeEl, installDom, fire, fireKey, findClass } from './domShim.mjs';

// ---- DOM shim (only what the routing module touches) ------------------------
function makeContainer() {
  const container = makeEl('div');
  const svg = makeEl('svg');
  svg.setAttribute('id', 'routing-svg');
  Object.defineProperty(container, 'innerHTML', {
    get() { return ''; },
    set() { container.children.length = 0; container.appendChild(svg); },
    configurable: true
  });
  return { container, svg };
}

// ---- module + core imports (after DOM globals are set) ---------------------
installDom();
const { createRoutingModule } = await import('../src/renderer/js/modules/routing/routingModule.js');
const { ModuleSystem } = await import('../src/renderer/js/core/moduleSystem.js');
const {
  buildVisualNodes,
  buildVisualConnections,
  createConnection,
  deleteConnection,
  canConnect,
  portTypeInfo
} = await import('../src/renderer/js/modules/routing/routingCore.js');
const { GraphLayout } = await import('../src/renderer/js/core/graphLayout.js');
const { GraphViewport } = await import('../src/renderer/js/core/graphViewport.js');
const { GRID_SIZE } = await import('../src/renderer/js/core/grid.js');
const { NodeInstanceManager } = await import('../src/renderer/js/core/nodeInstances.js');

test('Front/Rear view swaps cable layer order without changing topology', () => {
  const hub = makeHub({ graphViewport: { x: 0, y: 0, zoom: 1 } });
  seedGraph(hub);
  hub.graph.connect('src', 'midi-out', 'dst', 'midi-in');
  const { container, svg } = makeContainer();
  const mod = createRoutingModule(hub);
  mod.mount(container);
  const cables = findClass(svg, 'cables');
  const nodes = findClass(svg, 'nodes');
  assert.ok(svg.children.indexOf(cables) < svg.children.indexOf(nodes), 'Front keeps cables behind panels');
  const before = hub.graph.connections.length;
  assert.equal(mod.setRearView(true), true);
  assert.ok(svg.children.indexOf(cables) > svg.children.indexOf(nodes), 'Rear raises cables above panels');
  assert.equal(cables.classList.contains('rear'), true);
  assert.equal(hub.graph.connections.length, before, 'view swap does not mutate graph');
  mod.setRearView(false);
  assert.ok(svg.children.indexOf(cables) < svg.children.indexOf(nodes));
  mod.unmount();
});

// ---- fixtures ---------------------------------------------------------------
function seedGraph(hub) {
  hub.graph.addNode({
    id: 'src',
    name: 'Source',
    outputs: [
      { id: 'midi-out', type: 'midi', label: 'MIDI Out' },
      { id: 'audio-out', type: 'audio', label: 'Audio Out' }
    ]
  });
  hub.graph.addNode({
    id: 'dst',
    name: 'Target',
    inputs: [
      { id: 'midi-in', type: 'midi', label: 'MIDI In' },
      { id: 'ctrl-in', type: 'control', label: 'Ctrl In' }
    ]
  });
}

// ---- registration -----------------------------------------------------------
test('routing module registers through the module system', () => {
  const hub = makeHub();
  const modules = new ModuleSystem(hub);
  modules.register(createRoutingModule(hub));
  const mod = modules.get('routing');
  assert.ok(mod, 'module should be registered');
  assert.equal(mod.name, 'Routing');
  assert.ok(mod.navEntry, 'should have a nav entry');
  assert.equal(mod.navEntry.label, 'Routing');
  assert.equal(typeof mod.mount, 'function');
  assert.equal(typeof mod.unmount, 'function');
});

test('double-clicking a dynamic Patch Bay node opens its detailed editor', () => {
  const hub=makeHub({graphViewport:{x:0,y:0,zoom:1}});
  hub.modules=new ModuleSystem(hub);hub.nodes=new NodeInstanceManager(hub);
  const arp=hub.nodes.create('arpeggiator');
  const activated=[];hub.modules.activate=(id,el)=>activated.push([id,el]);
  const {container,svg}=makeContainer();const mod=createRoutingModule(hub);mod.mount(container);
  const nodes=findClass(svg,'nodes');
  const stack=[...nodes.children];let node=null;
  while(stack.length){const candidate=stack.pop();if(candidate.dataset?.nodeId===arp.id){node=candidate;break;}stack.push(...candidate.children);}
  assert.ok(node,'Arpeggiator visual node rendered');
  fire(nodes,'dblclick',{target:node});
  assert.deepEqual(activated,[[arp.id,container]]);
  mod.unmount();
});

function findNodeEl(svg,nodeId){
  const stack=[...findClass(svg,'nodes').children];
  while(stack.length){const candidate=stack.pop();
    if(candidate.dataset?.nodeId===nodeId)return candidate;
    stack.push(...candidate.children);}
  return null;
}
function findClassDeep(el,className){
  const stack=[...el.children];
  while(stack.length){const candidate=stack.pop();
    if(candidate._classSet?.has(className))return candidate;
    stack.push(...candidate.children);}
  return null;
}

test('an Arpeggiator card carries an OPEN control that reaches its editor in one click',()=>{
  const hub=makeHub({graphViewport:{x:0,y:0,zoom:1}});
  hub.modules=new ModuleSystem(hub);hub.nodes=new NodeInstanceManager(hub);
  const arp=hub.nodes.create('arpeggiator');
  const activated=[];hub.modules.activate=(id,el)=>activated.push([id,el]);
  const {container,svg}=makeContainer();const mod=createRoutingModule(hub);mod.mount(container);
  const node=findNodeEl(svg,arp.id);
  const open=findClassDeep(node,'node-open-control');
  assert.ok(open,'the card exposes an OPEN control');
  fire(svg,'pointerdown',{target:open,button:0,clientX:0,clientY:0});
  assert.deepEqual(activated,[[arp.id,container]],'one click opens the editor');
  mod.unmount();
});

// ---- VST OPEN button: contextual native-editor vs VST-page navigation -------
function makeVstHub(primaryStatus) {
  const hub = makeHub({ graphViewport: { x: 0, y: 0, zoom: 1 } });
  hub.modules = new ModuleSystem(hub);
  hub.nodes = new NodeInstanceManager(hub);
  const opened = [];
  hub.engine = {
    getInstanceStatus: () => primaryStatus,
    openEditor: (chainId, instanceId) => opened.push([chainId, instanceId])
  };
  return { hub, opened };
}

function openControlFor(svg, nodeId) {
  const node = findNodeEl(svg, nodeId);
  return findClassDeep(node, 'node-open-control');
}

test('VST OPEN with a ready primary plugin opens the native editor and stays on the Patch Bay', () => {
  const { hub, opened } = makeVstHub('ready');
  const vst = hub.nodes.create('vst');
  const chain = hub.nodes.getChain(vst.id);
  chain.append({ pluginId: 'analog-lab-v', name: 'Analog Lab V', role: 'instrument' });
  const activated = [];
  hub.modules.activate = (id, el) => activated.push([id, el]);
  const { container, svg } = makeContainer();
  const mod = createRoutingModule(hub); mod.mount(container);
  const open = openControlFor(svg, vst.id);
  fire(svg, 'pointerdown', { target: open, button: 0, clientX: 0, clientY: 0 });
  assert.deepEqual(opened, [[vst.id, chain.plugins[0].id]], 'native editor opened for the primary plugin');
  assert.deepEqual(activated, [], 'stays on Routing / Patch Bay (no navigation)');
  mod.unmount();
});

test('VST OPEN with an empty chain navigates to the VST page', () => {
  const { hub, opened } = makeVstHub('ready');
  const vst = hub.nodes.create('vst');
  const activated = [];
  hub.modules.activate = (id, el) => activated.push([id, el]);
  const { container, svg } = makeContainer();
  const mod = createRoutingModule(hub); mod.mount(container);
  const open = openControlFor(svg, vst.id);
  fire(svg, 'pointerdown', { target: open, button: 0, clientX: 0, clientY: 0 });
  assert.deepEqual(opened, [], 'no native editor opened for an empty chain');
  assert.deepEqual(activated, [[vst.id, container]], 'navigates to the VST page');
  mod.unmount();
});

test('VST OPEN with a not-ready primary plugin navigates to the VST page', () => {
  const { hub, opened } = makeVstHub('loading');
  const vst = hub.nodes.create('vst');
  const chain = hub.nodes.getChain(vst.id);
  chain.append({ pluginId: 'analog-lab-v', name: 'Analog Lab V', role: 'instrument' });
  const activated = [];
  hub.modules.activate = (id, el) => activated.push([id, el]);
  const { container, svg } = makeContainer();
  const mod = createRoutingModule(hub); mod.mount(container);
  const open = openControlFor(svg, vst.id);
  fire(svg, 'pointerdown', { target: open, button: 0, clientX: 0, clientY: 0 });
  assert.deepEqual(opened, [], 'no native editor opened for a non-ready plugin');
  assert.deepEqual(activated, [[vst.id, container]], 'navigates to the VST page');
  mod.unmount();
});

test('pressing a node without moving it twice opens the editor; a drag does not',()=>{
  const hub=makeHub({graphViewport:{x:0,y:0,zoom:1}});
  hub.modules=new ModuleSystem(hub);hub.nodes=new NodeInstanceManager(hub);
  const arp=hub.nodes.create('arpeggiator');
  const activated=[];hub.modules.activate=(id,el)=>activated.push([id,el]);
  const {container,svg}=makeContainer();const mod=createRoutingModule(hub);mod.mount(container);
  const node=findNodeEl(svg,arp.id);
  const press=()=>{fire(svg,'pointerdown',{target:node,button:0,clientX:10,clientY:10,pointerId:1});
    fire(svg,'pointerup',{target:node,button:0,clientX:10,clientY:10,pointerId:1});};
  press();
  assert.deepEqual(activated,[],'a single press only selects');
  press();
  assert.deepEqual(activated,[[arp.id,container]],'the second press opens the editor');
  // A press that MOVES the node is a drag, never a request to open it.
  activated.length=0;
  fire(svg,'pointerdown',{target:node,button:0,clientX:10,clientY:10,pointerId:1});
  fire(svg,'pointermove',{target:node,clientX:90,clientY:70,pointerId:1});
  fire(svg,'pointerup',{target:node,clientX:90,clientY:70,pointerId:1});
  fire(svg,'pointerdown',{target:node,button:0,clientX:90,clientY:70,pointerId:1});
  fire(svg,'pointermove',{target:node,clientX:150,clientY:120,pointerId:1});
  fire(svg,'pointerup',{target:node,clientX:150,clientY:120,pointerId:1});
  assert.deepEqual(activated,[],'dragging a node twice never opens it');
  mod.unmount();
});

// ---- graph -> visual mapping -------------------------------------------------
test('graph nodes map to visual nodes with typed ports', () => {
  const hub = makeHub();
  seedGraph(hub);
  const visual = buildVisualNodes(hub.graph);
  assert.equal(visual.length, 2);
  const src = visual.find((n) => n.id === 'src');
  assert.equal(src.name, 'Source');
  assert.equal(src.outputs[0].type, 'midi');
  assert.equal(src.outputs[1].type, 'audio');
  const dst = visual.find((n) => n.id === 'dst');
  assert.equal(dst.inputs[0].type, 'midi');
  assert.equal(dst.inputs[1].type, 'control');
});

test('graph connections map to visual cables', () => {
  const hub = makeHub();
  seedGraph(hub);
  hub.graph.connect('src', 'midi-out', 'dst', 'midi-in');
  const cables = buildVisualConnections(hub.graph);
  assert.equal(cables.length, 1);
  assert.equal(cables[0].from.nodeId, 'src');
  assert.equal(cables[0].from.portId, 'midi-out');
  assert.equal(cables[0].to.nodeId, 'dst');
  assert.equal(cables[0].to.portId, 'midi-in');
});

// ---- connection creation / rejection ----------------------------------------
test('compatible connection creation through UI logic', () => {
  const hub = makeHub();
  seedGraph(hub);
  const result = createConnection(hub.graph, { nodeId: 'src', portId: 'midi-out' }, { nodeId: 'dst', portId: 'midi-in' });
  assert.deepEqual(result, { ok: true });
  assert.equal(hub.graph.connections().length, 1);
});

test('incompatible connection is rejected', () => {
  const hub = makeHub();
  seedGraph(hub);
  const result = createConnection(hub.graph, { nodeId: 'src', portId: 'midi-out' }, { nodeId: 'dst', portId: 'ctrl-in' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'incompatible');
  assert.equal(hub.graph.connections().length, 0);
});

test('duplicate connection is rejected', () => {
  const hub = makeHub();
  seedGraph(hub);
  createConnection(hub.graph, { nodeId: 'src', portId: 'midi-out' }, { nodeId: 'dst', portId: 'midi-in' });
  const dup = createConnection(hub.graph, { nodeId: 'src', portId: 'midi-out' }, { nodeId: 'dst', portId: 'midi-in' });
  assert.equal(dup.ok, false);
  assert.equal(hub.graph.connections().length, 1);
});

test('unknown ports are rejected', () => {
  const hub = makeHub();
  seedGraph(hub);
  const result = createConnection(hub.graph, { nodeId: 'src', portId: 'nope' }, { nodeId: 'dst', portId: 'midi-in' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unknown-port');
});

test('port type compatibility helper', () => {
  assert.equal(canConnect({ type: 'midi' }, { type: 'midi' }), true);
  assert.equal(canConnect({ type: 'midi' }, { type: 'audio' }), false);
  assert.equal(canConnect({ type: 'audio' }, { type: 'audio' }), true);
  assert.equal(canConnect(null, { type: 'midi' }), false);
});

test('port type info provides shape + label (not color alone)', () => {
  assert.equal(portTypeInfo('midi').shape, 'square');
  assert.equal(portTypeInfo('audio').shape, 'circle');
  assert.equal(portTypeInfo('control').shape, 'triangle');
  assert.equal(portTypeInfo('midi').label, 'MIDI');
});

// ---- connection deletion -----------------------------------------------------
test('connection deletion through UI logic', () => {
  const hub = makeHub();
  seedGraph(hub);
  hub.graph.connect('src', 'midi-out', 'dst', 'midi-in');
  assert.equal(hub.graph.connections().length, 1);
  const cable = buildVisualConnections(hub.graph)[0];
  const removed = deleteConnection(hub.graph, cable);
  assert.equal(removed, true);
  assert.equal(hub.graph.connections().length, 0);
});

// ---- node position persistence ----------------------------------------------
test('node position persistence via graphLayout', async () => {
  const hub = makeHub();
  const layout = new GraphLayout(hub.settings);
  // Deterministic default when nothing stored.
  const def = layout.get('minilab-3', 0);
  assert.equal(typeof def.x, 'number');
  assert.equal(typeof def.y, 'number');
  // Persist.
  await layout.set('minilab-3', 120, 180);
  const stored = layout.get('minilab-3', 0);
  assert.deepEqual(stored, { x: 120, y: 180 });
  assert.deepEqual(hub.settings.get('graphLayout'), { 'minilab-3': { x: 120, y: 180 } });
});

test('routing graph is unchanged when moving nodes (view state only)', async () => {
  const hub = makeHub();
  seedGraph(hub);
  hub.graph.connect('src', 'midi-out', 'dst', 'midi-in');
  const before = hub.graph.serialize();
  const layout = new GraphLayout(hub.settings);
  await layout.set('src', 400, 500);
  await layout.set('dst', 900, 300);
  assert.deepEqual(hub.graph.serialize(), before, 'moving nodes must not alter routing');
  assert.equal(hub.graph.connections().length, 1);
});

// ---- graph updates propagate to the editor ----------------------------------
test('graph changes propagate to the mounted editor', () => {
  const hub = makeHub();
  seedGraph(hub);
  const { container, svg } = makeContainer();
  const mod = createRoutingModule(hub);
  mod.mount(container);

  const nodesLayer = findClass(svg, 'nodes');
  const cablesLayer = findClass(svg, 'cables');
  assert.ok(nodesLayer, 'nodes layer should exist');
  assert.ok(cablesLayer, 'cables layer should exist');
  const countCables = (layer) =>
    layer.children.filter((c) => c._classSet.has('cable') && !c._classSet.has('cable-hit')).length;

  assert.equal(nodesLayer.children.length, 2, 'two nodes rendered');
  assert.equal(countCables(cablesLayer), 0, 'no cables yet');

  // Simulate another part of the app creating a connection through the graph.
  hub.graph.connect('src', 'midi-out', 'dst', 'midi-in');
  assert.equal(countCables(cablesLayer), 1, 'editor re-rendered after graph:change');

  // Simulate removal elsewhere.
  hub.graph.disconnect('src', 'midi-out', 'dst', 'midi-in');
  assert.equal(countCables(cablesLayer), 0, 'editor updated after disconnect');

  // Simulate a node being added elsewhere.
  hub.graph.addNode({ id: 'extra', name: 'Extra', outputs: [{ id: 'o', type: 'midi' }] });
  assert.equal(nodesLayer.children.length, 3, 'editor updated after node add');

  mod.unmount();
});

test('routing module unmount cleans up', () => {
  const hub = makeHub();
  seedGraph(hub);
  const { container } = makeContainer();
  const mod = createRoutingModule(hub);
  mod.mount(container);
  mod.unmount();
  // Should not throw; container host class removed.
  assert.ok(true);
});

test('initial open fits nodes when no persisted viewport exists', () => {
  const hub = makeHub();
  hub.graph.addNode({ id: 'minilab-3', name: 'MiniLab 3', outputs: [{ id: 'midi-out', type: 'midi' }] });
  const { container, svg } = makeContainer();
  const mod = createRoutingModule(hub);
  mod.mount(container);
  const vb = svg.getAttribute('viewBox');
  // A fit (not the default 1:1 "0 0 800 600") means nodes were fitted into view.
  assert.ok(vb && vb !== '0 0 800 600', `viewBox should reflect a fit, got: ${vb}`);
  mod.unmount();
});

test('initial open restores a valid persisted viewport', async () => {
  const hub = makeHub();
  hub.graph.addNode({ id: 'minilab-3', name: 'MiniLab 3', outputs: [{ id: 'midi-out', type: 'midi' }] });
  const vp = new GraphViewport(hub.settings);
  await vp.save(123, 456, 1.25);
  const { container, svg } = makeContainer();
  const mod = createRoutingModule(hub);
  mod.mount(container);
  // Persisted pan (123,456) zoom 1.25 on a 800x600 canvas -> viewBox stays as-is
  // (not overwritten by a fit).
  assert.equal(svg.getAttribute('viewBox'), '123 456 640 480');
  mod.unmount();
});

test('visual grid pattern uses the shared GRID_SIZE', () => {
  const hub = makeHub();
  hub.graph.addNode({ id: 'minilab-3', name: 'MiniLab 3', outputs: [{ id: 'midi-out', type: 'midi' }] });
  const { container, svg } = makeContainer();
  const mod = createRoutingModule(hub);
  mod.mount(container);
  const minor = svg.querySelector('#grid-minor');
  assert.ok(minor, 'minor grid pattern should exist');
  assert.equal(minor.getAttribute('width'), String(GRID_SIZE));
  assert.equal(minor.getAttribute('height'), String(GRID_SIZE));
  mod.unmount();
});

test('dynamic nodes render with a type accent class in the Patch Bay', () => {
  const hub = makeHub();
  const modules = new ModuleSystem(hub);
  const nodes = new NodeInstanceManager({ events: hub.events, settings: hub.settings, graph: hub.graph, modules });
  hub.modules = modules;
  hub.nodes = nodes;
  nodes.create('vst');

  const { container, svg } = makeContainer();
  const mod = createRoutingModule(hub);
  mod.mount(container);
  const nodesLayer = findClass(svg, 'nodes');
  const vstNode = nodesLayer.children.find((c) => c._classSet.has('node-type-vst'));
  assert.ok(vstNode, 'VST node should render with its type accent class');
  mod.unmount();
});

test('port elements carry the correct node id for cable drag', () => {
  const hub = makeHub();
  const modules = new ModuleSystem(hub);
  const nodes = new NodeInstanceManager({ events: hub.events, settings: hub.settings, graph: hub.graph, modules });
  hub.modules = modules;
  hub.nodes = nodes;
  // Native MiniLab routing node + dynamic VST instance.
  hub.graph.addNode({ id: 'minilab-3', name: 'MiniLab 3', outputs: [{ id: 'midi-out', type: 'midi' }] });
  nodes.create('vst'); // vst-001 with midi-in

  const { container, svg } = makeContainer();
  const mod = createRoutingModule(hub);
  mod.mount(container);
  const nodesLayer = findClass(svg, 'nodes');
  const minilab = nodesLayer.children.find((c) => c.dataset.nodeId === 'minilab-3');
  const vst = nodesLayer.children.find((c) => c.dataset.nodeId === 'vst-001');
  assert.ok(minilab && vst, 'both nodes should render');
  const viewSwitch = findClass(minilab, 'view-side-switch');
  assert.ok(viewSwitch, 'Front/Rear control lives inside the MiniLab node');
  assert.equal(viewSwitch.children.find((child) => child._classSet.has('view-side-switch-label')).textContent, 'Rear View');
  fire(svg, 'pointerdown', { target: viewSwitch, button: 0 });
  assert.equal(mod.isRearView(), true, 'node-local control switches to Rear view');

  const minilabOut = minilab.children.find((c) => c.dataset.side === 'output');
  const vstIn = vst.children.find((c) => c.dataset.side === 'input');
  assert.ok(minilabOut, 'MiniLab output port should exist');
  assert.ok(vstIn, 'VST input port should exist');
  // These are what startCableDrag / endCableDrag read to build the connection.
  assert.equal(minilabOut.dataset.nodeId, 'minilab-3');
  assert.equal(minilabOut.dataset.portId, 'midi-out');
  assert.equal(vstIn.dataset.nodeId, 'vst-001');
  assert.equal(vstIn.dataset.portId, 'midi-in');
  mod.unmount();
});

test('cables render a visible path + wide hit path with endpoint metadata', () => {
  const hub = makeHub();
  hub.graph.addNode({ id: 'a', name: 'A', outputs: [{ id: 'o', type: 'midi' }] });
  hub.graph.addNode({ id: 'b', name: 'B', inputs: [{ id: 'i', type: 'midi' }] });
  hub.graph.connect('a', 'o', 'b', 'i');

  const { container, svg } = makeContainer();
  const mod = createRoutingModule(hub);
  mod.mount(container);
  const cablesLayer = findClass(svg, 'cables');

  const visible = cablesLayer.children.find((c) => c._classSet.has('cable') && !c._classSet.has('cable-hit'));
  const hit = cablesLayer.children.find((c) => c._classSet.has('cable-hit'));
  assert.ok(visible, 'visible cable path should exist');
  assert.ok(hit, 'wide hit path should exist');
  assert.equal(visible.dataset.cableId, hit.dataset.cableId);
  // Endpoint metadata drives findCableEl / unplug resolution.
  assert.equal(visible.dataset.fromNodeId, 'a');
  assert.equal(visible.dataset.fromPortId, 'o');
  assert.equal(visible.dataset.toNodeId, 'b');
  assert.equal(visible.dataset.toPortId, 'i');
  mod.unmount();
});
