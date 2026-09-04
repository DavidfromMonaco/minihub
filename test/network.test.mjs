import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHub } from './helpers.mjs';

function seed(hub) {
  hub.network.addNode({ id: 'a', name: 'A', outputs: [{ id: 'o', type: 'midi' }] });
  hub.network.addNode({ id: 'b', name: 'B', inputs: [{ id: 'i', type: 'midi' }] });
  hub.network.addNode({ id: 'c', name: 'C', inputs: [{ id: 'i', type: 'midi' }] });
}

test('addNode rejects missing/duplicate ids', () => {
  const hub = makeHub();
  assert.throws(() => hub.network.addNode({ id: '' }));
  hub.network.addNode({ id: 'a', name: 'A' });
  assert.throws(() => hub.network.addNode({ id: 'a', name: 'A2' }));
});

test('connect requires matching port types', () => {
  const hub = makeHub();
  hub.network.addNode({ id: 'a', outputs: [{ id: 'o', type: 'midi' }] });
  hub.network.addNode({ id: 'b', inputs: [{ id: 'i', type: 'audio' }] });
  assert.throws(() => hub.network.connect('a', 'o', 'b', 'i'), /Incompatible/);
});

test('connect rejects duplicates', () => {
  const hub = makeHub();
  seed(hub);
  hub.network.connect('a', 'o', 'b', 'i');
  assert.throws(() => hub.network.connect('a', 'o', 'b', 'i'), /already exists/);
});

test('connect rejects manual audio feedback cycles before native sync', () => {
  const hub = makeHub();
  for (const id of ['a', 'b', 'c']) hub.network.addNode({
    id,
    inputs: [{ id: 'audio-in', type: 'audio' }],
    outputs: [{ id: 'audio-out', type: 'audio' }]
  });
  hub.network.connect('a', 'audio-out', 'b', 'audio-in');
  hub.network.connect('b', 'audio-out', 'c', 'audio-in');
  assert.throws(
    () => hub.network.connect('c', 'audio-out', 'a', 'audio-in'),
    /AUDIO connection would create a feedback cycle/
  );
  assert.equal(hub.network.connections().length, 2,
    'rejected Patch Bay cable is neither visible nor persisted');
});

test('independent hardware MIDI source/sink ports do not form a false feedback cycle', () => {
  const hub = makeHub();
  const delivered = [];
  hub.network.addNode({
    id: 'minilab-3', type: 'midi-output',
    inputs: [{ id: 'midi-in', type: 'midi' }],
    outputs: [{ id: 'midi-out', type: 'midi' }],
    onInput: (_portId, data) => delivered.push(data)
  });
  hub.network.addNode({
    id: 'sequencer', type: 'sequencer',
    inputs: [{ id: 'midi-in', type: 'midi' }],
    outputs: [{ id: 'midi-out', type: 'midi' }],
    onInput: (_portId, data) => hub.network.emitData('sequencer', 'midi-out', data)
  });
  assert.equal(hub.network.connect('minilab-3', 'midi-out', 'sequencer', 'midi-in'), true);
  assert.equal(hub.network.connect('sequencer', 'midi-out', 'minilab-3', 'midi-in'), true);
  hub.network.emitData('minilab-3', 'midi-out', { raw: [0x90, 60, 100] });
  assert.deepEqual(delivered, [{ raw: [0x90, 60, 100] }],
    'route terminates at hardware sink without recursion');
});

test('fan-out is allowed (one output to many inputs)', () => {
  const hub = makeHub();
  seed(hub);
  hub.network.connect('a', 'o', 'b', 'i');
  hub.network.connect('a', 'o', 'c', 'i');
  assert.equal(hub.network.connections().length, 2);
});

test('disconnect removes a connection', () => {
  const hub = makeHub();
  seed(hub);
  hub.network.connect('a', 'o', 'b', 'i');
  assert.equal(hub.network.disconnect('a', 'o', 'b', 'i'), true);
  assert.equal(hub.network.connections().length, 0);
  assert.equal(hub.network.disconnect('a', 'o', 'b', 'i'), false);
});

test('removeNode drops its connections', () => {
  const hub = makeHub();
  seed(hub);
  hub.network.connect('a', 'o', 'b', 'i');
  hub.network.removeNode('a');
  assert.equal(hub.network.connections().length, 0);
});

test('emitData forwards to connected onInput handlers', () => {
  const hub = makeHub();
  seed(hub);
  hub.network.addNode({
    id: 'sink',
    inputs: [{ id: 'i', type: 'midi' }],
    onInput(portId, data) {
      received.push({ portId, data });
    }
  });
  const received = [];
  hub.network.connect('a', 'o', 'sink', 'i');
  hub.network.emitData('a', 'o', { note: 60 });
  assert.equal(received.length, 1);
  assert.equal(received[0].portId, 'i');
  assert.equal(received[0].data.note, 60);
});

test('restore skips invalid/stale connections', () => {
  const hub = makeHub();
  seed(hub);
  hub.network.restore([
    { from: { nodeId: 'a', portId: 'o' }, to: { nodeId: 'b', portId: 'i' } },
    { from: { nodeId: 'ghost', portId: 'o' }, to: { nodeId: 'b', portId: 'i' } }
  ]);
  assert.equal(hub.network.connections().length, 1);
});

test('connections persist to settings on change', async () => {
  const hub = makeHub();
  seed(hub);
  hub.network.connect('a', 'o', 'b', 'i');
  assert.deepEqual(hub.settings.get('networkConnections'), hub.network.serialize());
});
