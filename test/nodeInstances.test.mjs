import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/renderer/js/core/eventBus.js';
import { Graph } from '../src/renderer/js/core/graph.js';
import { ModuleSystem } from '../src/renderer/js/core/moduleSystem.js';
import { NodeInstanceManager } from '../src/renderer/js/core/nodeInstances.js';
import { getNodeType, listNodeTypes, NODE_TYPES } from '../src/renderer/js/core/nodeTypes.js';

function mockSettings(initial = {}) {
  const data = { ...initial };
  return {
    data,
    get(key) { return data[key]; },
    async set(key, value) { data[key] = value; }
  };
}

function makeFullHub(settingsData = {}) {
  const settings = mockSettings(settingsData);
  const events = new EventBus();
  const graph = new Graph(events, settings);
  const modules = new ModuleSystem({ events, settings, graph });
  const nodes = new NodeInstanceManager({ events, settings, graph, modules });
  return { events, settings, graph, modules, nodes };
}

// ---- Node Type Registry -----------------------------------------------------
test('registry exposes the four initial types', () => {
  const ids = listNodeTypes().map((t) => t.id).sort();
  assert.deepEqual(ids, ['image', 'sequencer', 'video', 'vst']);
  assert.ok(getNodeType('vst'));
  assert.equal(getNodeType('nope'), null);
});

test('VST type uses the centralized orange accent', () => {
  assert.equal(getNodeType('vst').accent, '--accent-vst');
  assert.equal(NODE_TYPES.vst.accent, '--accent-vst');
});

test('VST type declares MIDI IN, AUDIO IN, AUDIO OUT', () => {
  const ports = getNodeType('vst').ports;
  assert.deepEqual(ports.inputs.map((p) => p.id), ['midi-in', 'audio-in']);
  assert.deepEqual(ports.outputs.map((p) => p.id), ['audio-out']);
});

test('video/image/sequencer declare no speculative ports yet', () => {
  for (const id of ['video', 'image', 'sequencer']) {
    assert.deepEqual(getNodeType(id).ports.inputs, []);
    assert.deepEqual(getNodeType(id).ports.outputs, []);
  }
});

// ---- creating instances -----------------------------------------------------
test('creating multiple instances of the same type yields unique names/ids', () => {
  const hub = makeFullHub();
  const a = hub.nodes.create('vst');
  const b = hub.nodes.create('vst');
  assert.equal(a.name, 'VST 1');
  assert.equal(b.name, 'VST 2');
  assert.equal(a.id, 'vst-001');
  assert.equal(b.id, 'vst-002');
  assert.notEqual(a.id, b.id);
});

test('display names are deterministic per type', () => {
  const hub = makeFullHub();
  assert.equal(hub.nodes.create('video').name, 'Video 1');
  assert.equal(hub.nodes.create('image').name, 'Image 1');
  assert.equal(hub.nodes.create('sequencer').name, 'Sequencer 1');
});

test('IDs are never reused after deletion', () => {
  const hub = makeFullHub();
  hub.nodes.create('vst'); // vst-001
  hub.nodes.create('vst'); // vst-002
  hub.nodes.delete('vst-001');
  const c = hub.nodes.create('vst');
  // Identity keeps moving forward...
  assert.equal(c.id, 'vst-003');
  // ...while the display number fills the hole left by the deleted VST 1.
  assert.equal(c.name, 'VST 1');
  assert.equal(c.ordinal, 1);
});

test('node type is immutable', () => {
  const hub = makeFullHub();
  const inst = hub.nodes.create('vst');
  assert.equal(inst.type, 'vst');
  assert.equal(getNodeType(inst.type).id, 'vst');
  // A VST instance starts with an empty plugin chain.
  assert.deepEqual(inst.content, { plugins: [] });
});

// ---- Hub integration --------------------------------------------------------
test('dynamic instances register a module with a nav entry', () => {
  const hub = makeFullHub();
  const inst = hub.nodes.create('vst');
  const mod = hub.modules.get(inst.id);
  assert.ok(mod);
  assert.equal(mod.name, 'VST 1');
  assert.equal(mod.navEntry.label, 'VST 1');
  assert.equal(mod.navEntry.accent, 'vst');
  assert.equal(typeof mod.mount, 'function');
});

test('VST instance registers a routing node with the type ports', () => {
  const hub = makeFullHub();
  const inst = hub.nodes.create('vst');
  const node = hub.graph.getNode(inst.id);
  assert.ok(node);
  assert.equal(node.type, 'vst');
  assert.deepEqual(node.inputs.map((p) => p.id), ['midi-in', 'audio-in']);
  assert.deepEqual(node.outputs.map((p) => p.id), ['audio-out']);
});

// ---- deletion ---------------------------------------------------------------
test('deleting an instance removes module, routing node, and connections', () => {
  const hub = makeFullHub();
  const inst = hub.nodes.create('vst');
  hub.graph.addNode({ id: 'src', name: 'Src', outputs: [{ id: 'o', type: 'midi' }] });
  hub.graph.connect('src', 'o', inst.id, 'midi-in');
  assert.equal(hub.graph.connections().length, 1);

  const removed = hub.nodes.delete(inst.id);
  assert.equal(removed, true);
  assert.equal(hub.modules.get(inst.id), undefined);
  assert.equal(hub.graph.getNode(inst.id), undefined);
  assert.equal(hub.graph.connections().length, 0);
});

test('native MiniLab cannot be deleted through dynamic-node deletion', () => {
  const hub = makeFullHub();
  hub.graph.addNode({ id: 'minilab-3', name: 'MiniLab 3', outputs: [{ id: 'midi-out', type: 'midi' }] });
  assert.equal(hub.nodes.delete('minilab-3'), false);
  assert.ok(hub.graph.getNode('minilab-3'));
});

// ---- duplication (copy/paste model) ----------------------------------------
test('duplicate creates a new unique instance with a deterministic next name', () => {
  const hub = makeFullHub();
  hub.nodes.create('vst'); // vst-001
  const dup = hub.nodes.duplicate('vst-001');
  assert.ok(dup);
  assert.equal(dup.id, 'vst-002');
  assert.equal(dup.name, 'VST 2');
  assert.notEqual(dup.id, 'vst-001');
});

test('duplicate regenerates VST plugin IDs but preserves order/role/bypass', () => {
  const hub = makeFullHub();
  const src = hub.nodes.create('vst');
  const chain = hub.nodes.getChain(src.id);
  const p1 = chain.append({ name: 'A', role: 'instrument' });
  const p2 = chain.append({ name: 'B', role: 'utility' });
  chain.setBypass(p1.id, true);

  const dup = hub.nodes.duplicate(src.id);
  const srcPlugins = src.content.plugins;
  const dupPlugins = dup.content.plugins;
  assert.equal(dupPlugins.length, 2);
  assert.equal(dupPlugins[0].name, 'A');
  assert.equal(dupPlugins[1].name, 'B');
  assert.equal(dupPlugins[0].role, 'instrument');
  assert.equal(dupPlugins[1].role, 'utility');
  assert.equal(dupPlugins[0].bypassed, true);
  assert.equal(dupPlugins[1].bypassed, false);
  // Plugin instance IDs are regenerated (independent copy).
  assert.notEqual(dupPlugins[0].id, srcPlugins[0].id);
  assert.notEqual(dupPlugins[1].id, srcPlugins[1].id);
  // The copy is independent: mutating the source chain does not affect it.
  chain.remove(p1.id);
  assert.equal(dupPlugins.length, 2);
});

test('createFromSnapshot creates an independent instance from a snapshot', () => {
  const hub = makeFullHub();
  hub.nodes.create('vst'); // vst-001
  const snapshot = { type: 'vst', content: { plugins: [{ id: 'plugin-1', name: 'X', role: 'instrument', bypassed: true, state: null }] } };
  const inst = hub.nodes.createFromSnapshot(snapshot);
  assert.ok(inst);
  assert.equal(inst.id, 'vst-002');
  assert.equal(inst.name, 'VST 2');
  assert.equal(inst.content.plugins.length, 1);
  assert.equal(inst.content.plugins[0].name, 'X');
  assert.notEqual(inst.content.plugins[0].id, 'plugin-1');
});

test('createFromSnapshot rejects unknown types and empty snapshots', () => {
  const hub = makeFullHub();
  assert.equal(hub.nodes.createFromSnapshot(null), null);
  assert.equal(hub.nodes.createFromSnapshot({ type: 'nope', content: null }), null);
  assert.equal(hub.nodes.duplicate('ghost'), null);
});

test('duplicate does not copy external graph connections', () => {
  const hub = makeFullHub();
  hub.graph.addNode({ id: 'src', name: 'Src', outputs: [{ id: 'o', type: 'midi' }] });
  const inst = hub.nodes.create('vst');
  hub.graph.connect('src', 'o', inst.id, 'midi-in');
  assert.equal(hub.graph.connections().length, 1);
  const dup = hub.nodes.duplicate(inst.id);
  assert.equal(hub.graph.connections().length, 1, 'no copied connections');
  assert.equal(hub.graph.connectionsTo(dup.id).length, 0);
});

// ---- persistence / reload ---------------------------------------------------
test('instances persist and reload', async () => {
  const hub = makeFullHub();
  hub.nodes.create('vst');
  hub.nodes.create('video');
  const persisted = hub.settings.get('nodeInstances');
  assert.equal(persisted.instances.length, 2);
  assert.ok(persisted.idSeq.vst >= 1);

  // Simulate relaunch over the same settings data.
  const hub2 = makeFullHub(hub.settings.data);
  await hub2.nodes.load();
  assert.equal(hub2.nodes.list().length, 2);
  assert.ok(hub2.modules.get('vst-001'));
  assert.ok(hub2.modules.get('video-001'));
  assert.ok(hub2.graph.getNode('vst-001'));
  assert.equal(hub2.graph.getNode('vst-001').type, 'vst');
});

test('reload continues the ID counter (no reuse across sessions)', async () => {
  const hub = makeFullHub();
  hub.nodes.create('vst'); // vst-001
  hub.nodes.delete('vst-001');
  const hub2 = makeFullHub(hub.settings.data);
  await hub2.nodes.load();
  const c = hub2.nodes.create('vst');
  assert.equal(c.id, 'vst-002');
});

// ---- separation of concerns -------------------------------------------------
test('instance state is separate from routing and layout', () => {
  const hub = makeFullHub();
  hub.nodes.create('vst');
  assert.equal(hub.graph.connections().length, 0);
  assert.equal(hub.settings.get('graphConnections'), undefined);
  assert.equal(hub.settings.get('graphLayout'), undefined);
  assert.ok(hub.settings.get('nodeInstances'));
});

test('creating empty dynamic nodes does not alter existing MIDI routing', () => {
  const hub = makeFullHub();
  hub.graph.addNode({ id: 'minilab-3', name: 'MiniLab 3', outputs: [{ id: 'midi-out', type: 'midi' }] });
  hub.graph.addNode({ id: 'dst', name: 'Dst', inputs: [{ id: 'midi-in', type: 'midi' }] });
  hub.graph.connect('minilab-3', 'midi-out', 'dst', 'midi-in');
  const before = hub.graph.serialize();

  hub.nodes.create('vst');
  hub.nodes.create('video');
  hub.nodes.create('image');
  hub.nodes.create('sequencer');

  assert.deepEqual(hub.graph.serialize(), before);
  assert.equal(hub.graph.connections().length, 1);
});
