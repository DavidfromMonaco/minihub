import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFullHub } from './helpers.mjs';
import { setupEditHistory } from '../src/renderer/js/core/editHistory.js';
import { applyHistorySnapshot } from '../src/renderer/js/core/editHistoryApply.js';

/**
 * Contract: Ctrl+Z puts the project back, in place.
 *
 * Asked 2026-09-12. The bounds are D-032 and INTENT §8 quinquies; what these
 * tests hold is the other half — that the state actually returns to the screen
 * without the renderer reloading, which is how every OTHER project change in
 * MiniHub works (`ProjectManager._replace`) and is absurd for an undo.
 */

// Longer than the rig's quiet window, so `tick()` means "the edit has settled".
const QUIET = 20;
const tick = () => new Promise((resolve) => setTimeout(resolve, QUIET * 3));

function rig() {
  const hub = makeFullHub({
    nodeInstances: { instances: [], idSeq: {} },
    networkConnections: [],
    networkLayout: {},
    networkViewport: null,
    transportBpm: 120,
    sequencerState: null,
    masterOutput: { gainDb: 0 }
  });
  hub.project = { markDirty() {} };
  // The real seam, reproduced: `SettingsStore.set` calls `onSet` on every
  // write, which is how the history learns that anything changed at all. The
  // helper's in-memory store does not, so it is given the same behaviour here.
  const write = hub.settings.set.bind(hub.settings);
  hub.settings.set = async (key, value) => {
    await write(key, value);
    hub.settings.onSet?.(key, value);
  };
  hub.settings.onSet = (key, value) => hub.history?.observe?.(key, value);
  setupEditHistory(hub, { apply: applyHistorySnapshot, quietMs: QUIET });
  hub.history.start();
  return hub;
}

// ---- a node you deleted comes back ---------------------------------------------

test('deleting a node and undoing brings it back under its own id', async () => {
  const hub = rig();
  const node = hub.nodes.create('vst');
  await tick();

  hub.nodes.delete(node.id);
  await tick();
  assert.ok(!hub.nodes.get(node.id), 'gone');

  await hub.history.undo();

  const back = hub.nodes.get(node.id);
  assert.ok(back, 'the node is back');
  assert.equal(back.id, node.id, 'under the id every cable and layout entry still names');
  assert.equal(back.ordinal, node.ordinal, 'and with the number it was displayed under');
});

test('redo deletes it again', async () => {
  const hub = rig();
  const node = hub.nodes.create('vst');
  await tick();
  hub.nodes.delete(node.id);
  await tick();

  await hub.history.undo();
  assert.ok(hub.nodes.get(node.id));
  await hub.history.redo();
  assert.ok(!hub.nodes.get(node.id));
});

test('a restored node does not collide with the next new one', async () => {
  const hub = rig();
  const first = hub.nodes.create('vst');
  await tick();
  hub.nodes.delete(first.id);
  await tick();
  await hub.history.undo();

  const second = hub.nodes.create('vst');
  assert.notEqual(second.id, first.id,
    'invariant 4: the sequence must not fall behind an id that exists again');
});

// ---- cables ---------------------------------------------------------------------

test('a cable drawn since the snapshot is cut by undo', async () => {
  const hub = rig();
  const a = hub.nodes.create('vst');
  const b = hub.nodes.create('mixer');
  await tick();

  hub.network.connect(a.id, 'audio-out', b.id, 'audio-in-1');
  await tick();
  assert.equal(hub.network.connections().length, 1);

  await hub.history.undo();
  assert.equal(hub.network.connections().length, 0,
    'restore() alone is additive; putting the canvas back has to cut too');

  await hub.history.redo();
  assert.equal(hub.network.connections().length, 1);
});

// ---- positions ------------------------------------------------------------------

test('moving a node and undoing puts it back where it was', async () => {
  const hub = rig();
  await hub.settings.set('networkLayout', { 'vst-001': { x: 100, y: 100 } });
  await tick();

  await hub.settings.set('networkLayout', { 'vst-001': { x: 800, y: 640 } });
  await tick();

  await hub.history.undo();
  assert.deepEqual(hub.settings.get('networkLayout'), { 'vst-001': { x: 100, y: 100 } });
});

test('the Patch Bay is told to drop its cached positions', async () => {
  const hub = rig();
  const applied = [];
  hub.events.on('history:applied', (msg) => applied.push(msg));

  await hub.settings.set('networkLayout', { 'vst-001': { x: 10, y: 10 } });
  await tick();
  await hub.history.undo();

  assert.equal(applied.length, 1,
    'without this the canvas keeps drawing the positions it cached and quietly disagrees with the project');
});

// ---- one gesture is one step ----------------------------------------------------

test('dragging a node through fifty positions is one undo, not fifty', async () => {
  const hub = rig();
  await hub.settings.set('networkLayout', { 'vst-001': { x: 0, y: 0 } });
  await tick();

  for (let x = 1; x <= 50; x += 1) {
    await hub.settings.set('networkLayout', { 'vst-001': { x, y: 0 } });
  }
  await tick();

  await hub.history.undo();
  assert.deepEqual(hub.settings.get('networkLayout'), { 'vst-001': { x: 0, y: 0 } },
    'a slider emits one write per pixel; without coalescing Ctrl+Z is useless');

  // One more takes us to the empty canvas the session opened on. If the drag
  // had been recorded per pixel, fifty more would.
  await hub.history.undo();
  assert.deepEqual(hub.settings.get('networkLayout'), {});
  assert.equal(hub.history.canUndo, false, 'the drag was one step, not fifty');
});

test('an edit still inside the quiet window is not stepped over', async () => {
  const hub = rig();
  await hub.settings.set('networkLayout', { 'a': { x: 1, y: 1 } });
  await tick();

  // No `tick()`: the edit has not settled when Ctrl+Z arrives.
  await hub.settings.set('networkLayout', { 'a': { x: 2, y: 2 } });
  await hub.history.undo();

  assert.deepEqual(hub.settings.get('networkLayout'), { 'a': { x: 1, y: 1 } },
    'undo flushes the pending step first, or it lands one state too far back');
});

// ---- what it must never touch ---------------------------------------------------

test('undo leaves the transport, the master and the viewport alone', async () => {
  const hub = rig();
  await hub.settings.set('networkLayout', { 'a': { x: 1, y: 1 } });
  await tick();

  // Performed state, changed after the edit.
  hub.settings.data.transportBpm = 174;
  hub.settings.data.masterOutput = { gainDb: -6 };
  hub.settings.data.networkViewport = { x: 500, y: 500, zoom: 2 };

  await hub.history.undo();

  assert.equal(hub.settings.get('transportBpm'), 174, 'rewinding an instrument is not undoing an edit');
  assert.deepEqual(hub.settings.get('masterOutput'), { gainDb: -6 });
  assert.deepEqual(hub.settings.get('networkViewport'), { x: 500, y: 500, zoom: 2 });
});

test('applying a restore does not record itself as a new edit', async () => {
  const hub = rig();
  await hub.settings.set('networkLayout', { 'a': { x: 1, y: 1 } });
  await tick();
  await hub.settings.set('networkLayout', { 'a': { x: 2, y: 2 } });
  await tick();

  await hub.history.undo();
  await tick();

  assert.equal(hub.history.canRedo, true,
    'the restore writing the same keys an edit writes must not end its own redo chain');
});

// ---- inside a node ---------------------------------------------------------------

/*
 * Reported from use on 2026-09-12: Ctrl+Z worked in the Patch Bay and nowhere
 * else. Half of that was the keyboard guard (see editHistoryKeyboard); the
 * other half was here — what you change in an arpeggiator is a node's CONTENT,
 * and content was not compared at all.
 *
 * The bound is narrower than that, and it is exactly one thing: a VST node's
 * PLUGIN LIST. A plugin is a running native instance, so putting the list back
 * means reconciling with the engine. Everything else inside a node is a
 * parameter the engine is simply told about again.
 */

test('drawing in the arpeggiator is a step, and Ctrl+Z puts the pattern back', async () => {
  const hub = rig();
  const node = hub.nodes.create('arpeggiator');
  await tick();
  const before = node.content.patternLength;

  node.content = { ...node.content, patternLength: 16 };
  await hub.nodes._persist();
  await tick();
  assert.notEqual(hub.nodes.get(node.id).content.patternLength, before);

  await hub.history.undo();
  assert.equal(hub.nodes.get(node.id).content.patternLength, before,
    'the pattern is back, and the node was never deleted to get there');
  assert.ok(hub.nodes.get(node.id), 'the node itself stayed');
});

test('restoring an arpeggiator republishes it to the engine', async () => {
  const hub = rig();
  const node = hub.nodes.create('arpeggiator');
  await tick();
  const republished = [];
  hub.events.on('nativeMidi:stateChanged', (msg) => republished.push(msg));

  node.content = { ...node.content, patternLength: 16 };
  await hub.nodes._persist();
  await tick();
  await hub.history.undo();

  assert.deepEqual(republished, [{ nodeId: node.id }],
    'the engine follows the model rather than being handed a reverse command');
});

test('a VST chain keeps its plugins through an undo', async () => {
  const hub = rig();
  const node = hub.nodes.create('vst');
  await tick();

  // A plugin is added, then something else entirely is undone.
  node.content = { ...node.content, plugins: [{ id: 'p1', pluginId: 'C:/x.vst3' }] };
  await hub.nodes._persist();
  await hub.settings.set('networkLayout', { [node.id]: { x: 5, y: 5 } });
  await tick();
  await hub.settings.set('networkLayout', { [node.id]: { x: 9, y: 9 } });
  await tick();

  await hub.history.undo();

  assert.deepEqual(hub.nodes.get(node.id).content.plugins, [{ id: 'p1', pluginId: 'C:/x.vst3' }],
    'the engine holds that instance; the model must not stop listing it');
  assert.deepEqual(hub.settings.get('networkLayout'), { [node.id]: { x: 5, y: 5 } });
});

test('adding a plugin does not claim an undo step of its own', async () => {
  const hub = rig();
  const node = hub.nodes.create('vst');
  await tick();
  assert.equal(hub.history.canUndo, true, 'creating the node was a step');

  node.content = { ...node.content, plugins: [{ id: 'p1', pluginId: 'C:/x.vst3' }] };
  await hub.nodes._persist();
  await tick();

  await hub.history.undo();
  assert.ok(!hub.nodes.get(node.id),
    'one undo goes back past the creation: the plugin list never claimed a step');
});

test('a node deleted after an edit comes back with the content it had', async () => {
  const hub = rig();
  const node = hub.nodes.create('arpeggiator');
  await tick();

  node.content = { ...node.content, patternLength: 32 };
  await hub.nodes._persist();
  await tick();

  hub.nodes.delete(node.id);
  await tick();
  await hub.history.undo();

  assert.equal(hub.nodes.get(node.id)?.content?.patternLength, 32);
});
