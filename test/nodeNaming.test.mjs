import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFullHub } from './helpers.mjs';

/**
 * Contract: stable internal IDs and user-facing display numbers are two
 * different things.
 *
 *   id       never reused, monotonic per type, safe for routing/persistence
 *   ordinal  lowest positive number free in that type family, display only
 *
 * Existing nodes are never renumbered; new nodes fill the holes.
 */

const namesOf = (hub, type) =>
  hub.nodes.list().filter((n) => n.type === type).map((n) => n.name);

// ---- the reported case ------------------------------------------------------

test('after deleting VST 2..10, the next VST is named "VST 2" (not "VST 11")', () => {
  const hub = makeFullHub();
  const created = [];
  for (let i = 0; i < 10; i += 1) created.push(hub.nodes.create('vst'));
  assert.deepEqual(created.map((n) => n.name), [
    'VST 1', 'VST 2', 'VST 3', 'VST 4', 'VST 5',
    'VST 6', 'VST 7', 'VST 8', 'VST 9', 'VST 10'
  ]);

  for (const node of created.slice(1)) hub.nodes.delete(node.id);
  assert.deepEqual(namesOf(hub, 'vst'), ['VST 1']);

  const next = hub.nodes.create('vst');
  assert.equal(next.name, 'VST 2', 'must take the lowest free display number');
  // ...and identity must NOT be recycled to achieve that.
  assert.equal(next.id, 'vst-011');
  assert.ok(!created.some((n) => n.id === next.id), 'internal IDs are never reused');
});

test('a new node fills the lowest hole, not the end of the range', () => {
  const hub = makeFullHub();
  const [a, b, c] = [hub.nodes.create('vst'), hub.nodes.create('vst'), hub.nodes.create('vst')];
  hub.nodes.create('vst'); // VST 4
  hub.nodes.delete(b.id);  // free 2
  assert.deepEqual(namesOf(hub, 'vst'), ['VST 1', 'VST 3', 'VST 4']);

  const filled = hub.nodes.create('vst');
  assert.equal(filled.name, 'VST 2');
  assert.equal(filled.id, 'vst-005', 'the ID sequence keeps advancing');
  assert.ok(a.name === 'VST 1' && c.name === 'VST 3', 'existing nodes are never renumbered');
});

test('display numbers are tracked per type family, independently', () => {
  const hub = makeFullHub();
  const vst1 = hub.nodes.create('vst');   // VST 1
  hub.nodes.create('vst');                // VST 2
  hub.nodes.create('image');              // Image 1

  hub.nodes.delete(vst1.id);

  assert.equal(hub.nodes.create('image').name, 'Image 2', 'images are unaffected by a VST delete');
  assert.equal(hub.nodes.create('vst').name, 'VST 1', 'the freed VST number is reused');
});

test('Image 1, 2, 4 -> next Image is Image 3', () => {
  const hub = makeFullHub();
  const created = [1, 2, 3, 4].map(() => hub.nodes.create('image'));
  hub.nodes.delete(created[2].id); // remove Image 3
  assert.deepEqual(namesOf(hub, 'image'), ['Image 1', 'Image 2', 'Image 4']);
  assert.equal(hub.nodes.create('image').name, 'Image 3');
});

test('every node type family numbers itself from 1', () => {
  const hub = makeFullHub();
  assert.equal(hub.nodes.create('vst').name, 'VST 1');
  assert.equal(hub.nodes.create('video').name, 'Video 1');
  assert.equal(hub.nodes.create('image').name, 'Image 1');
});

// ---- every creation path obeys the same rule --------------------------------

test('duplicate and paste take the lowest free number, like plain creation', () => {
  const hub = makeFullHub();
  const a = hub.nodes.create('vst'); // VST 1
  const b = hub.nodes.create('vst'); // VST 2
  hub.nodes.create('vst');           // VST 3
  hub.nodes.delete(b.id);            // free 2

  const duplicated = hub.nodes.duplicate(a.id);
  assert.equal(duplicated.name, 'VST 2');

  hub.nodes.delete(duplicated.id); // free 2 again
  const pasted = hub.nodes.createFromSnapshot({ type: 'vst', content: a.content });
  assert.equal(pasted.name, 'VST 2', 'paste must not use a different rule than create');
  assert.notEqual(pasted.id, duplicated.id, 'but identity is still fresh');
});

test('a pasted node is fully independent of its source', () => {
  const hub = makeFullHub();
  const source = hub.nodes.create('vst');
  hub.nodes.getChain(source.id).append({ pluginId: 'P', name: 'Dexed', role: 'instrument' });
  hub.graph.addNode({ id: 'src', name: 'Src', outputs: [{ id: 'midi-out', type: 'midi' }] });
  hub.graph.connect('src', 'midi-out', source.id, 'midi-in');

  const pasted = hub.nodes.createFromSnapshot({
    type: source.type,
    content: JSON.parse(JSON.stringify(source.content))
  });

  assert.notEqual(pasted.id, source.id);
  assert.equal(hub.graph.connectionsTo(pasted.id).length, 0, 'external routing is never copied');
  assert.equal(pasted.content.plugins.length, 1, 'internal chain is copied');
  assert.notEqual(pasted.content.plugins[0].id, source.content.plugins[0].id,
    'chain plugin instance ids are regenerated');

  hub.nodes.getChain(pasted.id).append({ pluginId: 'Q', name: 'Vital', role: 'instrument' });
  assert.equal(source.content.plugins.length, 1, 'editing the copy must not touch the source');
});

// ---- persistence ------------------------------------------------------------

test('display numbers survive a reload and stay stable', async () => {
  const hub = makeFullHub();
  hub.nodes.create('vst');
  const second = hub.nodes.create('vst');
  hub.nodes.create('vst');
  hub.nodes.delete(second.id);

  const hub2 = makeFullHub(hub.settings.data);
  await hub2.nodes.load();
  assert.deepEqual(namesOf(hub2, 'vst'), ['VST 1', 'VST 3'], 'names are restored as they were');

  const next = hub2.nodes.create('vst');
  assert.equal(next.name, 'VST 2', 'the hole is still fillable after a reload');
  assert.equal(next.id, 'vst-004', 'and identity continues from the persisted sequence');
});

test('the display number is not persisted as part of identity', () => {
  const hub = makeFullHub();
  hub.nodes.create('vst');
  const [entry] = hub.settings.get('nodeInstances').instances;
  assert.equal(entry.id, 'vst-001');
  assert.equal(entry.ordinal, 1);
  assert.ok(!('name' in entry), 'the name is derived, never stored alongside the ordinal');
});

test('an install persisted before ordinals existed keeps its visible names', async () => {
  // Pre-ordinal schema: names were stored, the ID sequence lived under `counts`.
  const legacy = {
    nodeInstances: {
      instances: [
        { id: 'vst-001', type: 'vst', name: 'VST 1', content: { plugins: [] } },
        { id: 'vst-003', type: 'vst', name: 'VST 3', content: { plugins: [] } }
      ],
      counts: { vst: 3 }
    }
  };
  const hub = makeFullHub(legacy);
  await hub.nodes.load();

  assert.deepEqual(namesOf(hub, 'vst'), ['VST 1', 'VST 3']);
  const next = hub.nodes.create('vst');
  assert.equal(next.name, 'VST 2', 'the hole in a legacy install is filled too');
  assert.equal(next.id, 'vst-004', 'the legacy `counts` sequence is honoured, so no id collision');
});

test('a corrupt persisted ID sequence cannot produce a colliding node id', async () => {
  const corrupt = {
    nodeInstances: {
      instances: [
        { id: 'vst-001', type: 'vst', ordinal: 1, content: { plugins: [] } },
        { id: 'vst-002', type: 'vst', ordinal: 2, content: { plugins: [] } }
      ],
      idSeq: {} // lost
    }
  };
  const hub = makeFullHub(corrupt);
  await hub.nodes.load();

  const next = hub.nodes.create('vst');
  assert.equal(next.id, 'vst-003');
  assert.equal(hub.nodes.list().length, 3);
});

test('two live nodes never share a display number, even from corrupt data', async () => {
  const corrupt = {
    nodeInstances: {
      instances: [
        { id: 'vst-001', type: 'vst', ordinal: 1, content: { plugins: [] } },
        { id: 'vst-002', type: 'vst', ordinal: 1, content: { plugins: [] } }
      ],
      idSeq: { vst: 2 }
    }
  };
  const hub = makeFullHub(corrupt);
  await hub.nodes.load();

  const ordinals = hub.nodes.list().map((n) => n.ordinal);
  assert.equal(new Set(ordinals).size, ordinals.length, 'duplicate ordinals are resolved on load');
});

// ---- corrupt persisted data ---------------------------------------------------

test('a corrupt instance entry costs that node, not the whole startup', async () => {
  const hub = makeFullHub({
    nodeInstances: {
      instances: [
        null,
        'garbage',
        { type: 'vst' },                                    // no id
        { id: 'vst-001', type: 'nope', ordinal: 1 },        // unknown type
        { id: 'vst-002', type: 'vst', ordinal: 1, content: { plugins: [] } },
        { id: 'vst-002', type: 'vst', ordinal: 5, content: { plugins: [] } } // duplicate id
      ],
      idSeq: { vst: 2 }
    }
  });

  await hub.nodes.load();

  assert.deepEqual(hub.nodes.list().map((n) => n.id), ['vst-002'], 'only the valid entry survives');
  assert.equal(hub.nodes.list()[0].name, 'VST 1');
  assert.equal(hub.nodes.create('vst').id, 'vst-003', 'and the ID sequence is still sane');
});

test('a VST node with a corrupt content blob still loads with an empty chain', async () => {
  const hub = makeFullHub({
    nodeInstances: {
      instances: [{ id: 'vst-001', type: 'vst', ordinal: 1, content: 'not-an-object' }],
      idSeq: { vst: 1 }
    }
  });
  await hub.nodes.load();
  assert.deepEqual(hub.nodes.get('vst-001').content, { plugins: [], controlBindings: [] });
  assert.equal(hub.nodes.getChain('vst-001').count(), 0);
});
