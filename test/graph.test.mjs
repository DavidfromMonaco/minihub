import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHub } from './helpers.mjs';

function seed(hub) {
  hub.graph.addNode({ id: 'a', name: 'A', outputs: [{ id: 'o', type: 'midi' }] });
  hub.graph.addNode({ id: 'b', name: 'B', inputs: [{ id: 'i', type: 'midi' }] });
  hub.graph.addNode({ id: 'c', name: 'C', inputs: [{ id: 'i', type: 'midi' }] });
}

test('addNode rejects missing/duplicate ids', () => {
  const hub = makeHub();
  assert.throws(() => hub.graph.addNode({ id: '' }));
  hub.graph.addNode({ id: 'a', name: 'A' });
  assert.throws(() => hub.graph.addNode({ id: 'a', name: 'A2' }));
});

test('connect requires matching port types', () => {
  const hub = makeHub();
  hub.graph.addNode({ id: 'a', outputs: [{ id: 'o', type: 'midi' }] });
  hub.graph.addNode({ id: 'b', inputs: [{ id: 'i', type: 'audio' }] });
  assert.throws(() => hub.graph.connect('a', 'o', 'b', 'i'), /Incompatible/);
});

test('connect rejects duplicates', () => {
  const hub = makeHub();
  seed(hub);
  hub.graph.connect('a', 'o', 'b', 'i');
  assert.throws(() => hub.graph.connect('a', 'o', 'b', 'i'), /already exists/);
});

test('fan-out is allowed (one output to many inputs)', () => {
  const hub = makeHub();
  seed(hub);
  hub.graph.connect('a', 'o', 'b', 'i');
  hub.graph.connect('a', 'o', 'c', 'i');
  assert.equal(hub.graph.connections().length, 2);
});

test('disconnect removes a connection', () => {
  const hub = makeHub();
  seed(hub);
  hub.graph.connect('a', 'o', 'b', 'i');
  assert.equal(hub.graph.disconnect('a', 'o', 'b', 'i'), true);
  assert.equal(hub.graph.connections().length, 0);
  assert.equal(hub.graph.disconnect('a', 'o', 'b', 'i'), false);
});

test('removeNode drops its connections', () => {
  const hub = makeHub();
  seed(hub);
  hub.graph.connect('a', 'o', 'b', 'i');
  hub.graph.removeNode('a');
  assert.equal(hub.graph.connections().length, 0);
});

test('emitData forwards to connected onInput handlers', () => {
  const hub = makeHub();
  seed(hub);
  hub.graph.addNode({
    id: 'sink',
    inputs: [{ id: 'i', type: 'midi' }],
    onInput(portId, data) {
      received.push({ portId, data });
    }
  });
  const received = [];
  hub.graph.connect('a', 'o', 'sink', 'i');
  hub.graph.emitData('a', 'o', { note: 60 });
  assert.equal(received.length, 1);
  assert.equal(received[0].portId, 'i');
  assert.equal(received[0].data.note, 60);
});

test('restore skips invalid/stale connections', () => {
  const hub = makeHub();
  seed(hub);
  hub.graph.restore([
    { from: { nodeId: 'a', portId: 'o' }, to: { nodeId: 'b', portId: 'i' } },
    { from: { nodeId: 'ghost', portId: 'o' }, to: { nodeId: 'b', portId: 'i' } }
  ]);
  assert.equal(hub.graph.connections().length, 1);
});

test('connections persist to settings on change', async () => {
  const hub = makeHub();
  seed(hub);
  hub.graph.connect('a', 'o', 'b', 'i');
  assert.deepEqual(hub.settings.get('graphConnections'), hub.graph.serialize());
});
