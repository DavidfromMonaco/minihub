import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditHistory, AUTHORED_KEYS, PERFORMED_KEYS } from '../src/renderer/js/core/editHistory.js';
import { PROJECT_KEYS } from '../src/renderer/js/core/projectKeys.js';

/**
 * Contract: the history undoes what you authored, never what you performed.
 *
 * DECISIONS.md D-032 and INTENT.md §8 quinquies draw that line, and it is the
 * whole design: rewinding an instrument is not undoing an edit. These tests are
 * the line, written down twice so a key added to a project has to be classified
 * rather than swept in.
 */

function rig(initial = {}) {
  const data = {
    nodeInstances: { instances: [], idSeq: {} },
    networkConnections: [],
    networkLayout: {},
    networkViewport: { x: 0, y: 0, zoom: 1 },
    transportBpm: 120,
    sequencerState: null,
    masterOutput: { gainDb: 0 },
    ...initial
  };
  const hub = {
    settings: { data, get: (key) => data[key], set: async (key, value) => { data[key] = value; } },
    sequencer: null
  };
  return { hub, data, history: new EditHistory(hub).start() };
}

// ---- the line ------------------------------------------------------------------

test('every project key is classified, on one side or the other', () => {
  const classified = new Set([...AUTHORED_KEYS, ...Object.keys(PERFORMED_KEYS)]);
  for (const key of PROJECT_KEYS) {
    assert.ok(classified.has(key), `${key} is a project key nobody decided about`);
  }
  assert.equal(classified.size, PROJECT_KEYS.length, 'and nothing is classified twice or invented');
});

test('the performed half is named, with the transport and the master among it', () => {
  assert.ok(Object.hasOwn(PERFORMED_KEYS, 'transportBpm'));
  assert.ok(Object.hasOwn(PERFORMED_KEYS, 'masterOutput'));
  assert.ok(Object.hasOwn(PERFORMED_KEYS, 'networkViewport'));
  assert.equal(AUTHORED_KEYS.includes('transportBpm'), false);
});

test('changing the tempo is not an edit', () => {
  const { data, history } = rig();
  data.transportBpm = 174;
  assert.equal(history.record(), false, 'the tempo is performed, not authored');
  assert.equal(history.canUndo, false);
});

test('moving the master fader is not an edit', () => {
  const { data, history } = rig();
  data.masterOutput = { gainDb: -6 };
  assert.equal(history.record(), false);
});

test('panning the Patch Bay is not an edit', () => {
  const { data, history } = rig();
  data.networkViewport = { x: 900, y: 400, zoom: 2 };
  assert.equal(history.record(), false, 'undo must never move the canvas under the cursor');
});

test('drawing a cable is an edit', () => {
  const { data, history } = rig();
  data.networkConnections = [{ from: { nodeId: 'a', portId: 'midi-out' }, to: { nodeId: 'b', portId: 'midi-in' } }];
  assert.equal(history.record(), true);
  assert.equal(history.canUndo, true);
});

test('moving a node is an edit', () => {
  const { data, history } = rig();
  data.networkLayout = { 'vst-001': { x: 400, y: 120 } };
  assert.equal(history.record(), true);
});

// ---- one line, backwards and forwards ------------------------------------------

test('undo returns the state before the edit, redo returns the state after', () => {
  const { data, history } = rig();

  data.networkConnections = [{ id: 'first' }];
  history.record();
  data.networkConnections = [{ id: 'first' }, { id: 'second' }];
  history.record();

  const back = history.undo();
  assert.deepEqual(back.networkConnections, [{ id: 'first' }]);
  const backAgain = history.undo();
  assert.deepEqual(backAgain.networkConnections, []);
  assert.equal(history.canUndo, false, 'the start of the session is the end of the line');

  assert.deepEqual(history.redo().networkConnections, [{ id: 'first' }]);
  assert.deepEqual(history.redo().networkConnections, [{ id: 'first' }, { id: 'second' }]);
  assert.equal(history.canRedo, false);
});

test('undoing at the start, or redoing at the end, answers null rather than guessing', () => {
  const { history } = rig();
  assert.equal(history.undo(), null);
  assert.equal(history.redo(), null);
});

test('a new edit ends the redo chain', () => {
  const { data, history } = rig();
  data.networkConnections = [{ id: 'a' }];
  history.record();
  history.undo();
  assert.equal(history.canRedo, true);

  data.networkConnections = [{ id: 'b' }];
  history.record();
  assert.equal(history.canRedo, false, 'one line forwards, so a new branch replaces the old one');
});

test('a restore does not record itself', async () => {
  const { data, history } = rig();
  data.networkConnections = [{ id: 'a' }];
  history.record();

  await history.duringApply(async () => {
    data.networkConnections = [];
    assert.equal(history.record(), false, 'the restore observing its own writes');
  });
  assert.equal(history.canUndo, true, 'and the step it was undoing is still there');
});

test('the depth is capped, and it is the oldest step that goes', () => {
  const { data, history } = rig();
  const deep = new EditHistory(history.hub, { depth: 3 }).start();
  for (let i = 1; i <= 6; i += 1) {
    data.networkConnections = [{ id: i }];
    deep.record();
  }
  assert.equal(deep.past.length, 3);
  assert.deepEqual(deep.past[0].networkConnections, [{ id: 3 }], 'the three most recent, not the three first');
});

test('a snapshot is detached from the live objects', () => {
  const { data, history } = rig();
  data.networkLayout = { 'vst-001': { x: 1, y: 1 } };
  history.record();
  data.networkLayout['vst-001'].x = 999;

  assert.equal(history.present.networkLayout['vst-001'].x, 1,
    'a history that shares its objects with the live state remembers nothing');
});

test('clearing forgets the line entirely', () => {
  const { data, history } = rig();
  data.networkConnections = [{ id: 'a' }];
  history.record();
  history.clear();

  assert.equal(history.canUndo, false);
  assert.equal(history.canRedo, false);
  assert.equal(history.present, null, 'switching project never leaves a step pointing at the old one');
});

// ---- the sequencer keeps its music and its own view ----------------------------

const sequencerRig = () => {
  const state = {
    version: 1, tracks: [], loop: { enabled: false, startPpq: 0, endPpq: 16 },
    snap: '1/16', zoom: 60, scrollPpq: 0, selectedClipId: null, selectedClipIds: [],
    selectionAnchorClipId: null, focusedTrackId: null
  };
  const data = {
    nodeInstances: { instances: [], idSeq: {} }, networkConnections: [], networkLayout: {},
    networkViewport: null, transportBpm: 120, sequencerState: state, masterOutput: { gainDb: 0 }
  };
  const hub = {
    settings: { data, get: (key) => data[key], set: async (key, value) => { data[key] = value; } },
    sequencer: { model: { snapshot: () => JSON.parse(JSON.stringify(data.sequencerState)) } }
  };
  return { hub, data, history: new EditHistory(hub).start() };
};

test('adding a track is an edit; scrolling the timeline is not', () => {
  const { data, history } = sequencerRig();

  data.sequencerState = { ...data.sequencerState, scrollPpq: 512, zoom: 180 };
  assert.equal(history.record(), false, 'zoom and scroll are where you are looking');

  data.sequencerState = { ...data.sequencerState, tracks: [{ id: 't1', type: 'midi', clips: [] }] };
  assert.equal(history.record(), true);
});

test('undo puts the music back and leaves the view where it is', () => {
  const { data, history } = sequencerRig();
  data.sequencerState = { ...data.sequencerState, tracks: [{ id: 't1', type: 'midi', clips: [] }] };
  history.record();

  // The user scrolls and selects after the edit, then presses Ctrl+Z.
  data.sequencerState = { ...data.sequencerState, scrollPpq: 4096, zoom: 240, selectedClipId: 'clip-9' };

  const back = history.undo();
  assert.deepEqual(back.sequencerState.tracks, [], 'the track is gone again');
  assert.equal(back.sequencerState.scrollPpq, 4096, 'and the timeline did not jump');
  assert.equal(back.sequencerState.zoom, 240);
  assert.equal(back.sequencerState.selectedClipId, 'clip-9');
});

test('the live model wins over the settings copy, which can be a beat behind', () => {
  const { data, hub, history } = sequencerRig();
  // The model has the new track; settings has not been written yet.
  const live = { ...data.sequencerState, tracks: [{ id: 't9', type: 'midi', clips: [] }] };
  hub.sequencer.model.snapshot = () => JSON.parse(JSON.stringify(live));

  assert.equal(history.record(), true);
  assert.deepEqual(history.present.sequencerState.tracks, [{ id: 't9', type: 'midi', clips: [] }]);
});
