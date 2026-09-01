import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFullHub } from './helpers.mjs';
import { VstChain, VST_ROLES, getVstRole } from '../src/renderer/js/core/vstChain.js';
import { getNodeType } from '../src/renderer/js/core/nodeTypes.js';

// ---- VST role registry ------------------------------------------------------
test('VST role registry exposes all five roles', () => {
  const ids = Object.keys(VST_ROLES).sort();
  assert.deepEqual(ids, ['audioEffect', 'instrument', 'midiEffect', 'unknown', 'utility']);
  for (const id of ids) {
    assert.ok(VST_ROLES[id].label);
    assert.ok(VST_ROLES[id].accent);
    assert.ok(VST_ROLES[id].color);
  }
});

test('exact centralized role colors', () => {
  assert.equal(VST_ROLES.instrument.color, '#F5C451');
  assert.equal(VST_ROLES.audioEffect.color, '#EF6A5B');
  assert.equal(VST_ROLES.midiEffect.color, '#A78BFA');
  assert.equal(VST_ROLES.utility.color, '#48B8CC');
  assert.equal(VST_ROLES.unknown.color, '#94A3B8');
});

test('unknown-role fallback', () => {
  assert.equal(getVstRole('nope').id, 'unknown');
  assert.equal(getVstRole(undefined).id, 'unknown');
  assert.equal(getVstRole('instrument').id, 'instrument');
});

// ---- empty chain ------------------------------------------------------------
test('a VST node starts with an empty plugin chain', () => {
  const hub = makeFullHub();
  const inst = hub.nodes.create('vst');
  assert.deepEqual(inst.content, { plugins: [], controlBindings: [] });
  const chain = hub.nodes.getChain(inst.id);
  assert.ok(chain);
  assert.equal(chain.count(), 0);
});

test('non-VST instances have no chain', () => {
  const hub = makeFullHub();
  const video = hub.nodes.create('video');
  assert.equal(hub.nodes.getChain(video.id), null);
});

// ---- ordered chain model ----------------------------------------------------
test('append preserves processing order', () => {
  const hub = makeFullHub();
  const inst = hub.nodes.create('vst');
  const chain = hub.nodes.getChain(inst.id);
  chain.append({ name: 'Instrument', role: 'instrument' });
  chain.append({ name: 'EQ', role: 'audio-effect' });
  chain.append({ name: 'Reverb', role: 'audio-effect' });
  assert.deepEqual(chain.plugins.map((p) => p.name), ['Instrument', 'EQ', 'Reverb']);
  assert.equal(chain.count(), 3);
});

test('insert places a plugin at an index', () => {
  const hub = makeFullHub();
  const inst = hub.nodes.create('vst');
  const chain = hub.nodes.getChain(inst.id);
  chain.append({ name: 'A' });
  chain.append({ name: 'C' });
  chain.insert(1, { name: 'B' });
  assert.deepEqual(chain.plugins.map((p) => p.name), ['A', 'B', 'C']);
});

test('remove deletes a plugin by id', () => {
  const hub = makeFullHub();
  const inst = hub.nodes.create('vst');
  const chain = hub.nodes.getChain(inst.id);
  const a = chain.append({ name: 'A' });
  const b = chain.append({ name: 'B' });
  assert.equal(chain.remove(a.id), true);
  assert.deepEqual(chain.plugins.map((p) => p.name), ['B']);
  assert.equal(chain.remove('missing'), false);
});

test('reorder moves a plugin to a new index', () => {
  const hub = makeFullHub();
  const inst = hub.nodes.create('vst');
  const chain = hub.nodes.getChain(inst.id);
  const a = chain.append({ name: 'A' });
  const b = chain.append({ name: 'B' });
  const c = chain.append({ name: 'C' });
  chain.reorder(a.id, 2);
  assert.deepEqual(chain.plugins.map((p) => p.name), ['B', 'C', 'A']);
  chain.reorder(c.id, 0);
  assert.deepEqual(chain.plugins.map((p) => p.name), ['C', 'B', 'A']);
});

test('bypass toggles state', () => {
  const hub = makeFullHub();
  const inst = hub.nodes.create('vst');
  const chain = hub.nodes.getChain(inst.id);
  const a = chain.append({ name: 'A' });
  assert.equal(a.bypassed, false);
  assert.equal(chain.setBypass(a.id, true), true);
  assert.equal(a.bypassed, true);
  assert.equal(chain.setBypass(a.id, false), true);
  assert.equal(a.bypassed, false);
});

// ---- stable plugin instance IDs ---------------------------------------------
test('plugin instance IDs are unique and stable within a chain', () => {
  const hub = makeFullHub();
  const inst = hub.nodes.create('vst');
  const chain = hub.nodes.getChain(inst.id);
  const a = chain.append({ name: 'A' });
  const b = chain.append({ name: 'B' });
  const c = chain.append({ name: 'C' });
  const ids = chain.plugins.map((p) => p.id);
  assert.equal(new Set(ids).size, 3, 'ids must be unique');
  assert.equal(a.id, 'plugin-1');
  assert.equal(b.id, 'plugin-2');
  assert.equal(c.id, 'plugin-3');
});

// ---- persistence ------------------------------------------------------------
test('chain order and state persist across reload', async () => {
  const hub = makeFullHub();
  const inst = hub.nodes.create('vst');
  const chain = hub.nodes.getChain(inst.id);
  const a = chain.append({ name: 'Instrument', role: 'instrument' });
  chain.append({ name: 'EQ', role: 'audio-effect' });
  chain.append({ name: 'Reverb', role: 'audio-effect' });
  chain.setBypass(a.id, true);
  chain.reorder(a.id, 2);

  // Relaunch over the same settings.
  const hub2 = makeFullHub(hub.settings.data);
  await hub2.nodes.load();
  const inst2 = hub2.nodes.get(inst.id);
  assert.deepEqual(
    inst2.content.plugins.map((p) => p.name),
    ['EQ', 'Reverb', 'Instrument']
  );
  assert.equal(inst2.content.plugins[2].bypassed, true);
  assert.equal(inst2.content.plugins[2].id, a.id, 'plugin id stable across reload');

  // New appends after reload do not collide with existing ids.
  const chain2 = hub2.nodes.getChain(inst.id);
  const d = chain2.append({ name: 'Delay', role: 'audio-effect' });
  assert.equal(d.id, 'plugin-4');
});

test('deleted highest plugin id is tombstoned across remount and restart', async () => {
  const hub = makeFullHub();
  const inst = hub.nodes.create('vst');
  let chain = hub.nodes.getChain(inst.id);
  chain.append({ name: 'A' });
  chain.append({ name: 'B' });
  chain.append({ name: 'C' });
  chain.remove('plugin-3');

  chain = hub.nodes.getChain(inst.id); // a fresh wrapper must retain the mark
  assert.equal(chain.append({ name: 'D' }).id, 'plugin-4');
  chain.remove('plugin-4');

  const restarted = makeFullHub(hub.settings.data);
  await restarted.nodes.load();
  const restored = restarted.nodes.getChain(inst.id);
  assert.equal(restored.append({ name: 'E' }).id, 'plugin-5');
});

// ---- independence from Hub routing --------------------------------------------
test('internal chain changes never alter hub.graph', () => {
  const hub = makeFullHub();
  const inst = hub.nodes.create('vst');
  hub.graph.addNode({ id: 'src', name: 'Src', outputs: [{ id: 'midi', type: 'midi' }] });
  hub.graph.connect('src', 'midi', inst.id, 'midi-in');
  const before = hub.graph.serialize();

  const chain = hub.nodes.getChain(inst.id);
  chain.append({ name: 'A' });
  chain.append({ name: 'B' });
  chain.insert(1, { name: 'C' });
  chain.remove(chain.plugins[0].id);
  chain.setBypass(chain.plugins[0].id, true);

  assert.deepEqual(hub.graph.serialize(), before, 'graph must be unchanged');
  assert.equal(hub.graph.connections().length, 1);
  // The routing node still exposes the same structural ports.
  const node = hub.graph.getNode(inst.id);
  assert.deepEqual(node.inputs.map((p) => p.id), ['midi-in', 'audio-in', 'ctrl-in']);
  assert.deepEqual(node.outputs.map((p) => p.id), ['audio-out']);
});

// ---- VST family identity ----------------------------------------------------
test('VST node retains orange family identity regardless of internal roles', () => {
  const hub = makeFullHub();
  const inst = hub.nodes.create('vst');
  const chain = hub.nodes.getChain(inst.id);
  chain.append({ name: 'Instrument', role: 'instrument' });
  chain.append({ name: 'EQ', role: 'audio-effect' });
  chain.append({ name: 'Arp', role: 'midi-effect' });

  assert.equal(inst.type, 'vst');
  assert.equal(getNodeType('vst').accent, '--accent-vst');
  // The graph node keeps the VST family type.
  assert.equal(hub.graph.getNode(inst.id).type, 'vst');
});
