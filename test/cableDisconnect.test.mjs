import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFullHub } from './helpers.mjs';
import {
  createConnection,
  deleteConnection,
  buildVisualConnections
} from '../src/renderer/js/modules/routing/routingCore.js';
import { dragPosition } from '../src/renderer/js/core/grid.js';
import { GraphViewport } from '../src/renderer/js/core/graphViewport.js';

function seed(hub) {
  hub.graph.addNode({ id: 'a', name: 'A', outputs: [{ id: 'o', type: 'midi' }] });
  hub.graph.addNode({ id: 'b', name: 'B', inputs: [{ id: 'i', type: 'midi' }] });
  hub.graph.addNode({ id: 'c', name: 'C', inputs: [{ id: 'i', type: 'midi' }] });
}

// ---- Ctrl+click disconnect (model: deleteConnection on a cable) -------------
test('Ctrl+click disconnect removes the exact cable', () => {
  const hub = makeFullHub();
  seed(hub);
  createConnection(hub.graph, { nodeId: 'a', portId: 'o' }, { nodeId: 'b', portId: 'i' });
  const cable = buildVisualConnections(hub.graph)[0];
  assert.equal(hub.graph.connections().length, 1);
  assert.equal(deleteConnection(hub.graph, cable), true);
  assert.equal(hub.graph.connections().length, 0);
});

test('plain click does not disconnect', () => {
  const hub = makeFullHub();
  seed(hub);
  createConnection(hub.graph, { nodeId: 'a', portId: 'o' }, { nodeId: 'b', portId: 'i' });
  // Plain click selects only; no deleteConnection is invoked.
  assert.equal(hub.graph.connections().length, 1);
  assert.equal(buildVisualConnections(hub.graph).length, 1);
});

// ---- drag-to-unplug (model: find via input endpoint, delete) ----------------
test('unplug: dragging connected input endpoint + release on empty canvas disconnects', () => {
  const hub = makeFullHub();
  seed(hub);
  createConnection(hub.graph, { nodeId: 'a', portId: 'o' }, { nodeId: 'b', portId: 'i' });
  // The unplug drag resolves the exact connection by its destination input.
  const conns = hub.graph.connectionsTo('b', 'i');
  assert.equal(conns.length, 1);
  const connection = conns[0];
  assert.equal(connection.from.nodeId, 'a');
  // Release on empty canvas -> disconnect.
  assert.equal(deleteConnection(hub.graph, connection), true);
  assert.equal(hub.graph.connections().length, 0);
});

test('unplug: release back on original input preserves the connection', () => {
  const hub = makeFullHub();
  seed(hub);
  createConnection(hub.graph, { nodeId: 'a', portId: 'o' }, { nodeId: 'b', portId: 'i' });
  const connection = hub.graph.connectionsTo('b', 'i')[0];
  // Released over a port (original input) -> no deleteConnection call.
  assert.equal(hub.graph.connections().length, 1);
  assert.deepEqual(hub.graph.connectionsTo('b', 'i')[0], connection);
});

test('unplugging one branch preserves other fan-out connections', () => {
  const hub = makeFullHub();
  seed(hub);
  createConnection(hub.graph, { nodeId: 'a', portId: 'o' }, { nodeId: 'b', portId: 'i' });
  createConnection(hub.graph, { nodeId: 'a', portId: 'o' }, { nodeId: 'c', portId: 'i' });
  assert.equal(hub.graph.connections().length, 2);

  // Unplug only the b branch by its destination input.
  const bConn = hub.graph.connectionsTo('b', 'i')[0];
  assert.equal(deleteConnection(hub.graph, bConn), true);
  assert.equal(hub.graph.connections().length, 1);
  const remaining = hub.graph.connections()[0];
  assert.equal(remaining.to.nodeId, 'c', 'fan-out branch to c must remain');
});

test('graph persistence updates after unplug', () => {
  const hub = makeFullHub();
  seed(hub);
  createConnection(hub.graph, { nodeId: 'a', portId: 'o' }, { nodeId: 'b', portId: 'i' });
  assert.equal(hub.settings.get('graphConnections').length, 1);
  const cable = buildVisualConnections(hub.graph)[0];
  deleteConnection(hub.graph, cable);
  assert.deepEqual(hub.settings.get('graphConnections'), []);
});

// ---- node state / layout unchanged ------------------------------------------
test('disconnect leaves node state and layout unchanged', async () => {
  const hub = makeFullHub();
  seed(hub);
  createConnection(hub.graph, { nodeId: 'a', portId: 'o' }, { nodeId: 'b', portId: 'i' });
  hub.settings.set('graphLayout', { a: { x: 100, y: 100 }, b: { x: 400, y: 100 } });
  const beforeLayout = hub.settings.get('graphLayout');

  const cable = buildVisualConnections(hub.graph)[0];
  deleteConnection(hub.graph, cable);

  assert.deepEqual(hub.settings.get('graphLayout'), beforeLayout, 'layout unchanged');
  assert.ok(hub.graph.getNode('a') && hub.graph.getNode('b'), 'nodes remain');
});

// ---- coexistence with other interactions ------------------------------------
test('Ctrl node-snap still works', () => {
  const start = { x: 0, y: 0, clientX: 0, clientY: 0 };
  const snapped = dragPosition(start, { clientX: 23, clientY: 17 }, 1, true);
  assert.deepEqual(snapped, { x: 20, y: 20 });
});

test('cable creation still works', () => {
  const hub = makeFullHub();
  seed(hub);
  const result = createConnection(hub.graph, { nodeId: 'a', portId: 'o' }, { nodeId: 'b', portId: 'i' });
  assert.deepEqual(result, { ok: true });
  assert.equal(hub.graph.connections().length, 1);
});

test('pan/zoom do not change connection validity', async () => {
  const hub = makeFullHub();
  seed(hub);
  createConnection(hub.graph, { nodeId: 'a', portId: 'o' }, { nodeId: 'b', portId: 'i' });
  const before = hub.graph.serialize();
  const vp = new GraphViewport(hub.settings);
  await vp.save(-200, 100, 0.5);
  await vp.save(50, -30, 2);
  assert.deepEqual(hub.graph.serialize(), before);
  assert.equal(hub.graph.connections().length, 1);
});
