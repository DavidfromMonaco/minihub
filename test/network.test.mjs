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

test('restore connects what it can and does not route what it cannot', () => {
  const hub = makeHub();
  seed(hub);
  hub.network.restore([
    { from: { nodeId: 'a', portId: 'o' }, to: { nodeId: 'b', portId: 'i' } },
    { from: { nodeId: 'ghost', portId: 'o' }, to: { nodeId: 'b', portId: 'i' } }
  ]);
  assert.equal(hub.network.connections().length, 1,
    'a cable naming an absent node must never enter the routing list');
});

/**
 * The cable whose node is not here is REMEMBERED.
 *
 * This is the defect the profile-import workstream found: `restore()` used to
 * warn and move on, and the next `_persist()` wrote the file without the cable.
 * The controller node's id is the loaded profile's id, so opening a project with
 * another profile loaded pointed every keyboard cable at a node that did not
 * exist -- and one save later they were gone. Specification section 6.1, applied
 * to cables instead of bindings.
 */
test('a cable waiting for an absent node is written back, not lost', () => {
  const hub = makeHub();
  seed(hub);
  const saved = [
    { from: { nodeId: 'a', portId: 'o' }, to: { nodeId: 'b', portId: 'i' } },
    { from: { nodeId: 'ghost', portId: 'o' }, to: { nodeId: 'b', portId: 'i' } }
  ];
  hub.network.restore(saved);

  assert.equal(hub.network.unresolvedConnections().length, 1);
  assert.deepEqual(hub.network.serialize(), saved,
    'the file must come back out holding every cable it went in with');
});

test('a waiting cable connects the day its node arrives', () => {
  const hub = makeHub();
  seed(hub);
  hub.network.restore([
    { from: { nodeId: 'ghost', portId: 'o' }, to: { nodeId: 'b', portId: 'i' } }
  ]);
  assert.equal(hub.network.connections().length, 0);

  hub.network.addNode({ id: 'ghost', name: 'Ghost', outputs: [{ id: 'o', type: 'midi' }] });

  assert.equal(hub.network.connections().length, 1, 'the cable should have been made');
  assert.equal(hub.network.unresolvedConnections().length, 0, 'and stopped waiting');
  assert.deepEqual(hub.settings.get('networkConnections'), hub.network.serialize());
});

test('a waiting cable does not carry data', () => {
  const hub = makeHub();
  seed(hub);
  const received = [];
  hub.network.addNode({
    id: 'sink',
    inputs: [{ id: 'i', type: 'midi' }],
    onInput: (portId, data) => received.push({ portId, data })
  });
  hub.network.restore([
    { from: { nodeId: 'a', portId: 'ghost-port' }, to: { nodeId: 'sink', portId: 'i' } }
  ]);
  hub.network.emitData('a', 'ghost-port', { note: 60 });
  hub.network.emitData('a', 'o', { note: 61 });
  assert.equal(received.length, 0, 'nothing may flow through a cable that is only remembered');
});

/**
 * Absent is remembered; wrong is dropped. A cable whose endpoints are all here
 * and which still cannot be made describes something that will never become
 * valid, and keeping it would preserve garbage in the file for ever.
 */
test('a cable that is wrong rather than waiting is dropped', () => {
  const hub = makeHub();
  hub.network.addNode({ id: 'a', outputs: [{ id: 'o', type: 'midi' }] });
  hub.network.addNode({ id: 'b', inputs: [{ id: 'i', type: 'audio' }] });
  hub.network.restore([
    { from: { nodeId: 'a', portId: 'o' }, to: { nodeId: 'b', portId: 'i' } },
    { from: { nodeId: 'a' }, to: { nodeId: 'b', portId: 'i' } }
  ]);
  assert.equal(hub.network.connections().length, 0, 'incompatible types stay refused');
  assert.equal(hub.network.unresolvedConnections().length, 0,
    'neither the incompatible cable nor the malformed one is worth remembering');
});

test('deleting a node forgets the cables waiting for it', () => {
  const hub = makeHub();
  seed(hub);
  hub.network.restore([
    { from: { nodeId: 'ghost', portId: 'o' }, to: { nodeId: 'b', portId: 'i' } }
  ]);
  assert.equal(hub.network.unresolvedConnections().length, 1);
  hub.network.removeNode('b');
  assert.equal(hub.network.unresolvedConnections().length, 0,
    'a node id is never reused, so a cable waiting for a deleted node waits for nothing');
});

/**
 * The acceptance criterion of the whole thing, in the shape the user will meet
 * it: another profile is loaded, so the controller node is a different id; the
 * project opens, is saved, and the original profile comes back.
 */
test('loading another controller profile and coming back returns the cables', () => {
  const first = makeHub();
  first.network.addNode({ id: 'minilab-3', outputs: [{ id: 'control-k1', type: 'control' }] });
  first.network.addNode({ id: 'vst-011', inputs: [{ id: 'ctrl-in', type: 'control' }] });
  first.network.connect('minilab-3', 'control-k1', 'vst-011', 'ctrl-in');
  const saved = first.settings.get('networkConnections');

  // Same project, another keyboard: the controller node carries the other
  // profile's id, and nothing in the file matches it.
  const other = makeHub();
  other.network.addNode({ id: 'vega-49', outputs: [{ id: 'control-dial-one', type: 'control' }] });
  other.network.addNode({ id: 'vst-011', inputs: [{ id: 'ctrl-in', type: 'control' }] });
  other.network.restore(saved);
  assert.equal(other.network.connections().length, 0, 'nothing routes from a keyboard that is not loaded');
  // A save happens -- this is the step that used to make the loss permanent.
  other.network.connect('vega-49', 'control-dial-one', 'vst-011', 'ctrl-in');
  const savedAgain = other.settings.get('networkConnections');

  const back = makeHub();
  back.network.addNode({ id: 'minilab-3', outputs: [{ id: 'control-k1', type: 'control' }] });
  back.network.addNode({ id: 'vst-011', inputs: [{ id: 'ctrl-in', type: 'control' }] });
  back.network.restore(savedAgain);

  assert.deepEqual(back.network.connections(), saved,
    'the original cable must come back exactly as it was saved');
  assert.equal(back.network.unresolvedConnections().length, 1,
    'and the other keyboard\'s cable now waits in its turn');
});

test('connections persist to settings on change', async () => {
  const hub = makeHub();
  seed(hub);
  hub.network.connect('a', 'o', 'b', 'i');
  assert.deepEqual(hub.settings.get('networkConnections'), hub.network.serialize());
});
