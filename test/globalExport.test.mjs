import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, makeEl, fire, fireDocumentKey } from './domShim.mjs';
import { EventBus } from '../src/renderer/js/core/eventBus.js';
import { Network } from '../src/renderer/js/core/network.js';
import { SequencerController } from '../src/renderer/js/core/sequencerController.js';
import { defaultSequencerState } from '../src/renderer/js/core/sequencerModel.js';
import { AudioPlayerNodes } from '../src/renderer/js/core/audioPlayers.js';
import { AUDIO_PLAYER_TYPE } from '../src/renderer/js/core/audioPlayerState.js';
import { clockText, exportStatusText, installExportPanel, spanLabel } from '../src/renderer/js/ui/exportPanel.js';

/**
 * Contract (D-056): the export is the Audio Output's, reached from the header,
 * and it lasts as long as what Play plays -- the Audio Players included.
 *
 * Reported 2026-09-25: a file processed in the Patch Bay alone, Audio Player
 * into a VST into the Audio Output, exported as four seconds instead of three
 * minutes and more, because the length came from the arrangement, which was
 * empty.
 */

function controllerRig({ playerSeconds = 0, scope = 'all' } = {}) {
  const data = { sequencerState: defaultSequencerState(), playScope: scope };
  const events = new EventBus();
  const settings = { get: (key) => data[key], set: async (key, value) => { data[key] = value; } };
  const exports = [];
  const hub = {
    events, settings,
    network: new Network(events, settings),
    engine: {
      syncSequencer: () => {}, setTransport: () => {}, setPlayScope: () => {}, selectMidiOutput: () => {},
      setSequencerTrackControl: () => {}, sequencerPanic: () => {},
      sequencerExport: async (options) => { exports.push(options); return { ok: true }; }, sequencerCancelExport: async () => ({ ok: true }) },
    api: { audioPickSave: async (_name, format) => `C:\\out\\mix.${format}` },
    project: { currentProjectName: 'Test' },
    audioPlayers: { longestHeardSeconds: () => playerSeconds }
  };
  const controller = new SequencerController(hub).load();
  hub.sequencer = controller;
  return { hub, controller, exports };
}

// ---- how long ---------------------------------------------------------------

test('an empty arrangement with a player lasts as long as its file', () => {
  const { controller } = controllerRig({ playerSeconds: 228 });
  assert.deepEqual(controller.exportSpan('full'), { startPpq: 0, endPpq: 456, source: 'players' },
    '228 s at 120 BPM is 456 quarters, not one bar');
});

test('nothing to play is still one bar, as before', () => {
  const { controller } = controllerRig();
  assert.deepEqual(controller.exportSpan('full'), { startPpq: 0, endPpq: 4, source: 'empty' });
});

test('the later of the arrangement and the players wins', () => {
  const { controller } = controllerRig({ playerSeconds: 4 });
  const track = controller.model.addTrack('midi');
  controller.model.addMidiClip(track.id, 0, 16);
  assert.equal(controller.exportSpan('full').source, 'arrangement', '16 quarters beat 8');
  controller.tempo = 60;
  assert.equal(controller.exportSpan('full').source, 'arrangement', 'still 16 against 4');
  controller.tempo = 300;
  assert.deepEqual(controller.exportSpan('full'), { startPpq: 0, endPpq: 20, source: 'players' });
});

test('only what Play plays is measured', () => {
  const { controller } = controllerRig({ playerSeconds: 60, scope: 'sequencer' });
  const track = controller.model.addTrack('midi');
  controller.model.addMidiClip(track.id, 0, 8);
  assert.equal(controller.exportSpan('full').endPpq, 8, 'Sequencer: the players do not play');
  controller.setPlayScope('players');
  assert.equal(controller.exportSpan('full').endPpq, 120, 'Players: the clips do not sound');
});

test('the loop is exported as it is set', () => {
  const { controller } = controllerRig({ playerSeconds: 600 });
  controller.model.state.loop = { enabled: true, startPpq: 8, endPpq: 24 };
  assert.deepEqual(controller.exportSpan('loop'), { startPpq: 8, endPpq: 24, source: 'loop' });
});

test('the export command carries the players\' length', async () => {
  const { controller, exports } = controllerRig({ playerSeconds: 228 });
  assert.equal(await controller.exportMaster('full', { filePath: 'C:\\out\\a.wav' }), true);
  assert.equal(exports[0].startPpq, 0);
  assert.equal(exports[0].endPpq, 456);
});

// ---- which players count -----------------------------------------------------

test('a player counts when its file is read, it is cabled, and it is not muted', () => {
  const events = new EventBus();
  const settings = { get: () => undefined, set: async () => {} };
  const network = new Network(events, settings);
  const contents = {
    'player-a': { filePath: 'a.wav' }, 'player-b': { filePath: 'b.wav' },
    'player-c': { filePath: 'c.wav', muted: true }, 'player-d': { filePath: 'd.wav' }
  };
  const nodes = Object.keys(contents).map((id) => ({ id, type: AUDIO_PLAYER_TYPE, content: contents[id] }));
  for (const node of nodes) network.addNode({ id: node.id, name: node.id, type: AUDIO_PLAYER_TYPE, inputs: [], outputs: [{ id: 'audio-out', type: 'audio' }] });
  network.addNode({ id: 'audio-output', name: 'Audio Output', type: 'audio-output', inputs: [{ id: 'audio-in', type: 'audio' }], outputs: [] });
  const hub = { events, network, nodes: { list: () => nodes, get: (id) => nodes.find((node) => node.id === id) } };
  const players = new AudioPlayerNodes(hub);
  network.connect('player-a', 'audio-out', 'audio-output', 'audio-in');
  network.connect('player-c', 'audio-out', 'audio-output', 'audio-in');
  network.connect('player-d', 'audio-out', 'audio-output', 'audio-in');
  const file = (nodeId, state, durationSeconds) => events.emit('engine:audioPlayerFile', { nodeId, state, durationSeconds, filePath: `${nodeId}.wav` });
  file('player-a', 'ready', 30);
  file('player-b', 'ready', 500);
  file('player-c', 'ready', 400);
  file('player-d', 'loading', 0);
  assert.equal(players.longestHeardSeconds(), 30,
    'b is cabled to nothing, c is muted, d is not read yet');
  file('player-d', 'ready', 90);
  assert.equal(players.longestHeardSeconds(), 90);
  players.dispose();
});

// ---- the header's panel --------------------------------------------------------

test('what the panel says of a span, a status and a length', () => {
  assert.equal(clockText(228), '3:48');
  assert.equal(clockText(4.4), '0:04');
  assert.equal(spanLabel('full', { startPpq: 0, endPpq: 456, source: 'players' }, 120), 'Whole — 3:48, the Audio Players');
  assert.equal(spanLabel('full', { startPpq: 0, endPpq: 4, source: 'empty' }, 120), 'Whole — 0:02, nothing plays yet');
  assert.equal(spanLabel('loop', { startPpq: 8, endPpq: 24 }, 120), 'Loop — bars 3 to 6, 0:08');
  assert.equal(exportStatusText({ state: 'complete', filePath: 'C:\\out\\a.wav' }, false), 'Saved C:\\out\\a.wav');
  assert.equal(exportStatusText({ state: 'progress', progress: 0.42, realtimeSpeed: 3 }, true), 'Rendering… 42% · 3.00× realtime');
  assert.equal(exportStatusText(null, false), '');
});

function panelOf() {
  return globalThis.document.body.children.find((child) => child._classSet.has('export-panel')) || null;
}

function walk(root, predicate, found = []) {
  for (const child of root.children) {
    if (predicate(child)) found.push(child);
    walk(child, predicate, found);
  }
  return found;
}

test('the header\'s Export opens its panel, exports, shows progress, and closes', async () => {
  installDom();
  const { hub, controller, exports } = controllerRig({ playerSeconds: 228 });
  const button = makeEl('button');
  const remove = installExportPanel(hub, button);
  assert.equal(button.textContent, 'Export');

  fire(button, 'click');
  const panel = panelOf();
  assert.ok(panel, 'the panel opens under the button');
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  const selects = walk(panel, (node) => node.tagName === 'SELECT');
  const range = selects[0];
  assert.equal(range.children[0].textContent, 'Whole — 3:48, the Audio Players');
  assert.equal(range.children[1].disabled, true, 'no loop to export while the loop is off');

  const format = selects[1];
  format.value = 'mp3';
  fire(format, 'change');
  assert.equal(walk(selects[2], () => true).map((node) => node.textContent).join(','), '128 kbps,192 kbps,256 kbps,320 kbps');
  assert.equal(controller.exportOptions.format, 'mp3', 'kept for the next export');

  const [start, cancel] = walk(panel, (node) => node.tagName === 'BUTTON');
  assert.equal(cancel.disabled, true);
  fire(start, 'click');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(exports.length, 1);
  assert.equal(exports[0].format, 'mp3');
  assert.equal(exports[0].endPpq, 456);
  assert.equal(start.disabled, true, 'one export at a time');

  hub.events.emit('sequencer:export', { state: 'progress', progress: 0.42 });
  assert.equal(button.textContent, 'Export 42%', 'the progress shows with the panel closed too');

  fireDocumentKey('Escape');
  assert.equal(panelOf(), null, 'Escape closes it');
  assert.equal(button.getAttribute('aria-expanded'), 'false');

  controller.exporting = false;
  hub.events.emit('sequencer:export', { state: 'error', message: 'Disk full' });
  const reopened = panelOf();
  assert.ok(reopened, 'an export that fails opens the panel to say so');
  const status = walk(reopened, (node) => node._classSet.has('export-status'))[0];
  assert.equal(status.textContent, 'Disk full');
  assert.equal(button.classList.contains('failed'), true);

  remove();
  assert.equal(panelOf(), null);
});
