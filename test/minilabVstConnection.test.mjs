import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFullHub } from './helpers.mjs';
import {
  createConnection,
  buildVisualConnections,
  buildVisualNodes
} from '../src/renderer/js/modules/routing/routingCore.js';
import { fitViewport } from '../src/renderer/js/core/viewportMath.js';
import { GraphViewport } from '../src/renderer/js/core/graphViewport.js';

function seedMiniLabAndVst(hub) {
  hub.graph.addNode({ id: 'minilab-3', name: 'MiniLab 3', outputs: [{ id: 'midi-out', type: 'midi' }] });
  return hub.nodes.create('vst'); // vst-001 with midi-in / audio-in / audio-out
}

// ---- the exact connection the Patch Bay must support -----------------------
test('MiniLab midi-out -> VST midi-in connects through the Patch Bay logic', () => {
  const hub = makeFullHub();
  seedMiniLabAndVst(hub);
  const result = createConnection(
    hub.graph,
    { nodeId: 'minilab-3', portId: 'midi-out' },
    { nodeId: 'vst-001', portId: 'midi-in' }
  );
  assert.deepEqual(result, { ok: true });
  assert.equal(hub.graph.connections().length, 1);
});

test('cable model appears after the connection', () => {
  const hub = makeFullHub();
  seedMiniLabAndVst(hub);
  createConnection(hub.graph, { nodeId: 'minilab-3', portId: 'midi-out' }, { nodeId: 'vst-001', portId: 'midi-in' });
  const cables = buildVisualConnections(hub.graph);
  assert.equal(cables.length, 1);
  assert.equal(cables[0].from.nodeId, 'minilab-3');
  assert.equal(cables[0].from.portId, 'midi-out');
  assert.equal(cables[0].to.nodeId, 'vst-001');
  assert.equal(cables[0].to.portId, 'midi-in');
});

test('incompatible MIDI -> AUDIO connection is rejected', () => {
  const hub = makeFullHub();
  seedMiniLabAndVst(hub);
  const result = createConnection(
    hub.graph,
    { nodeId: 'minilab-3', portId: 'midi-out' },
    { nodeId: 'vst-001', portId: 'audio-in' }
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'incompatible');
  assert.equal(hub.graph.connections().length, 0);
});

test('connection survives serialization and restoration', async () => {
  const hub = makeFullHub();
  seedMiniLabAndVst(hub);
  createConnection(hub.graph, { nodeId: 'minilab-3', portId: 'midi-out' }, { nodeId: 'vst-001', portId: 'midi-in' });
  const serialized = hub.graph.serialize();
  assert.equal(serialized.length, 1);

  // Relaunch over the same settings (instances + connections restored).
  const hub2 = makeFullHub(hub.settings.data);
  // Native MiniLab routing node is registered at startup (not a dynamic instance).
  hub2.graph.addNode({ id: 'minilab-3', name: 'MiniLab 3', outputs: [{ id: 'midi-out', type: 'midi' }] });
  await hub2.nodes.load();
  hub2.graph.restore(hub2.settings.get('graphConnections'));
  assert.equal(hub2.graph.connections().length, 1);
  const c = hub2.graph.connections()[0];
  assert.equal(c.from.nodeId, 'minilab-3');
  assert.equal(c.to.nodeId, 'vst-001');
  assert.equal(c.to.portId, 'midi-in');
});

test('deleting the dynamic VST node removes the connection', () => {
  const hub = makeFullHub();
  seedMiniLabAndVst(hub);
  createConnection(hub.graph, { nodeId: 'minilab-3', portId: 'midi-out' }, { nodeId: 'vst-001', portId: 'midi-in' });
  assert.equal(hub.graph.connections().length, 1);
  assert.equal(hub.nodes.delete('vst-001'), true);
  assert.equal(hub.graph.connections().length, 0);
});

test('zoom/pan do not change connection validity', async () => {
  const hub = makeFullHub();
  seedMiniLabAndVst(hub);
  createConnection(hub.graph, { nodeId: 'minilab-3', portId: 'midi-out' }, { nodeId: 'vst-001', portId: 'midi-in' });
  const before = hub.graph.serialize();

  // Pan/zoom via the viewport store must not touch routing.
  const vp = new GraphViewport(hub.settings);
  await vp.save(-300, 150, 0.5);
  await vp.save(40, -20, 2);
  assert.deepEqual(hub.graph.serialize(), before);
  assert.equal(hub.graph.connections().length, 1);

  // Fit-to-nodes is also viewport-only.
  const nodes = buildVisualNodes(hub.graph);
  const rects = nodes.map((n, i) => ({ x: i * 200, y: 0, width: 200, height: 80 }));
  fitViewport(rects, { width: 800, height: 600 });
  assert.deepEqual(hub.graph.serialize(), before);
});
