import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { SequencerModel, TICKS_PER_QUARTER, normalizeSequencerState, quantizeGridTicks, snapStep } from '../src/renderer/js/core/sequencerModel.js';
import { SequencerController } from '../src/renderer/js/core/sequencerController.js';
import { gridPx, rulerStride, timelineEndPpq } from '../src/renderer/js/modules/sequencer/sequencerModule.js';
import { handleAgentRequest } from '../src/renderer/js/core/agentRequests.js';
import { spanLabel } from '../src/renderer/js/ui/exportPanel.js';

const require = createRequire(import.meta.url);
const { validTransportState } = require('../src/main/clipEditorWindows.js');

const WALTZ = { numerator: 3, denominator: 4 };
const COMPOUND = { numerator: 6, denominator: 8 };

function controllerRig() {
  const commands = [];
  const emitted = [];
  const published = [];
  const data = { transportBpm: 120 };
  const hub = {
    settings: { get: (key) => data[key], set: (key, value) => { data[key] = value; } },
    network: { connectionsTo: () => [], connectionsFrom: () => [], getNode: () => null },
    engine: {
      setTransport: (state) => commands.push({ type: 'transport', ...state }),
      syncSequencer: (state) => commands.push({ type: 'sync', state })
    },
    events: { emit: (name, value) => emitted.push([name, value]) },
    midi: { selectedOutputId: '', getOutput: () => null },
    api: { clipEditorPublishTransport: async (state) => { published.push(state); return true; } },
    project: { projectId: 'project-signature', _transitionPending: false }
  };
  const controller = new SequencerController(hub);
  hub.sequencer = controller;
  return { controller, commands, emitted, published, data, hub };
}

const signaturesSent = (commands) => commands
  .filter((command) => command.type === 'transport' && command.signature)
  .map((command) => `${command.signature.numerator}/${command.signature.denominator}`);

test('a project from before signatures opens in 4/4, and a broken one too', () => {
  assert.deepEqual(normalizeSequencerState({ tracks: [] }).signature, { numerator: 4, denominator: 4 });
  assert.deepEqual(normalizeSequencerState({ signature: { numerator: 5, denominator: 3 } }).signature,
    { numerator: 4, denominator: 4 });
  assert.deepEqual(normalizeSequencerState({ signature: COMPOUND }).signature, COMPOUND);
});

test('changing the signature moves bar lines, never notes', async () => {
  const { controller, commands, emitted, published, data } = controllerRig();
  const track = controller.model.addTrack('midi');
  controller.model.addMidiClip(track.id, 4, 4, [{ startPpq: 1, durationPpq: 0.5, pitch: 60 }]);
  const before = JSON.stringify(controller.model.state.tracks);

  assert.deepEqual(controller.setSignature(WALTZ), WALTZ);
  assert.equal(JSON.stringify(controller.model.state.tracks), before, 'the clip and its note keep their quarters');
  assert.deepEqual(data.sequencerState.signature, WALTZ, 'saved with the arrangement');
  assert.deepEqual(signaturesSent(commands), ['3/4'], 'the engine is told once');
  assert.deepEqual(emitted.filter(([name]) => name === 'sequencer:signature').map(([, value]) => value), [WALTZ]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(published.at(-1).signature, WALTZ, 'an open Clip Editor snaps a 3/4 bar');

  controller.changed();
  assert.deepEqual(signaturesSent(commands), ['3/4'], 'an edit that is not a signature change tells the engine nothing');
  assert.deepEqual(controller.setSignature({ numerator: 3, denominator: 5 }), WALTZ, 'a signature that is not one is ignored');
  assert.deepEqual(signaturesSent(commands), ['3/4']);
});

test('an undo that restores another signature tells the engine', () => {
  const { controller, commands } = controllerRig();
  controller.setSignature(COMPOUND);
  const snapshot = controller.model.snapshot();
  controller.restoreState({ ...snapshot, signature: { numerator: 4, denominator: 4 } });
  assert.deepEqual(controller.signature, { numerator: 4, denominator: 4 });
  assert.deepEqual(signaturesSent(commands), ['6/8', '4/4']);
});

test('a bar is the signature\'s wherever the Sequencer counts one', () => {
  const { controller, commands } = controllerRig();
  controller.setSignature(WALTZ);
  const track = controller.model.addTrack('midi');
  controller.addMidiClip(track.id, 3);
  assert.equal(controller.model.state.tracks[0].clips[0].lengthPpq, 3, 'a new clip is one 3/4 bar');
  controller.playheadPpq = 7;
  controller.nudgeBars(-1);
  assert.equal(commands.at(-1).seekPpq, 6);
  controller.nudgeBars(1);
  assert.equal(commands.at(-1).seekPpq, 9);
  assert.deepEqual(new SequencerController(controllerRig().hub).exportSpan('full').endPpq, 4,
    'an empty 4/4 project exports one bar of four');
  assert.equal(controller.exportSpan('full').endPpq, 6, 'the clip ends at 6');
});

test('Snap and Quantize "1 bar" follow the signature; note values do not', () => {
  assert.equal(snapStep('1 bar', COMPOUND), 3);
  assert.equal(snapStep('1/8', COMPOUND), 0.5);
  assert.equal(snapStep('1 bar'), 4);
  assert.equal(quantizeGridTicks('1 bar', { numerator: 7, denominator: 8 }), 3.5 * TICKS_PER_QUARTER);
  assert.equal(quantizeGridTicks('1/16', COMPOUND), TICKS_PER_QUARTER / 4);
  const model = new SequencerModel({ snap: '1 bar', signature: WALTZ });
  const track = model.addTrack('midi');
  const clip = model.addMidiClip(track.id, 4.4);
  assert.equal(clip.startPpq, 3, 'dropped near bar two of 3/4, it lands on quarter 3');
  model.moveClip(clip.id, 5);
  assert.equal(clip.startPpq, 6);
});

test('the grid draws the signature\'s divisions, and the timeline ends on a bar', () => {
  // 4/4 is what it always was: 1, 2, 4, 8 quarters.
  assert.equal(gridPx(72), 72);
  assert.equal(gridPx(8), 16);
  assert.equal(gridPx(4), 16);
  assert.equal(gridPx(2), 16);
  // 3/4 never draws a line two quarters in: the bar, then two bars.
  assert.equal(gridPx(8, WALTZ), 24);
  assert.equal(gridPx(3, WALTZ), 18);
  // 6/8 steps by eighths, groups of eighths that fill the bar, then bars.
  assert.equal(gridPx(30, COMPOUND), 15);
  assert.equal(gridPx(10, COMPOUND), 15);
  assert.equal(timelineEndPpq({ minimumPpq: 256, barPpq: 3 }) % 3, 0);
  assert.equal(timelineEndPpq({ minimumPpq: 256 }), 256);
  assert.equal(rulerStride(100, 72, 3), 1);
  assert.ok(rulerStride(2000, 1, 3) >= 16);
});

test('the export panel names the loop in the signature\'s bars', () => {
  assert.equal(spanLabel('loop', { startPpq: 6, endPpq: 18 }, 120, WALTZ), 'Loop — bars 3 to 6, 0:06');
  assert.equal(spanLabel('loop', { startPpq: 8, endPpq: 24 }, 120), 'Loop — bars 3 to 6, 0:08');
});

test('an agent sets the signature as the header does, and is refused one that is not', async () => {
  const { controller, hub } = controllerRig();
  const ask = (request) => handleAgentRequest(hub, { expectedProjectId: 'project-signature', ...request });
  assert.deepEqual(await ask({ kind: 'set-signature', signature: '12/8' }),
    { ok: true, signature: { numerator: 12, denominator: 8 } });
  assert.deepEqual(await ask({ kind: 'set-signature', numerator: 5, denominator: 4 }),
    { ok: true, signature: { numerator: 5, denominator: 4 } });
  assert.equal((await ask({ kind: 'set-signature', signature: '5/3' })).reason, 'invalid-signature');
  assert.equal((await ask({ kind: 'set-signature', numerator: 0, denominator: 4 })).reason, 'invalid-signature');
  assert.deepEqual(controller.signature, { numerator: 5, denominator: 4 }, 'a refusal changes nothing');
  assert.deepEqual(await handleAgentRequest(hub, { kind: 'set-signature', signature: '3/4', expectedProjectId: 'gone' }),
    { ok: false, reason: 'stale-project' }, 'it edits the arrangement, so it is gated like the loop');
});

test('the Clip Editor window accepts a signature from the main window, and only a signature', () => {
  assert.equal(validTransportState({ bpm: 120, signature: COMPOUND }), true);
  assert.equal(validTransportState({ bpm: 120, signature: { numerator: 6, denominator: 7 } }), false);
  assert.equal(validTransportState({ signature: { numerator: 6, denominator: 8, extra: 1 } }), false);
  assert.equal(validTransportState({ ppqPosition: 0, playing: false, recording: false, bpm: 120, signature: WALTZ }), true);
});

// ---- a signature per track, changing along it (D-060) ----------------------

import { meterBarAt, meterBarPpq, meterRegions, meterSnap, normalizeMeter } from '../src/renderer/js/core/musicalTime.js';

test('a track counts its own bars: the project\'s until its first change, then its own', () => {
  const regions = meterRegions([{ bar: 3, numerator: 7, denominator: 8 }, { bar: 5, numerator: 4, denominator: 4 }]);
  assert.deepEqual(regions.map((region) => [region.startPpq, region.startBar]), [[0, 1], [8, 3], [15, 5]]);
  assert.equal(meterBarPpq(regions, 4), 11.5, 'bar 4 is the second 7/8 bar');
  assert.deepEqual(meterBarAt(regions, 12).bar, 4);
  assert.equal(meterSnap(regions, 12.3, 'bar'), 11.5);
  assert.equal(meterSnap(regions, 12.3, 1), 12.5, 'a quarter grid restarts on the 7/8 bar line, half a quarter late');
  // A track with no change follows the project, whatever it becomes.
  assert.equal(meterBarPpq(meterRegions([], WALTZ), 3), 6);
  assert.equal(meterBarPpq(meterRegions([{ bar: 1, numerator: 12, denominator: 8 }], WALTZ), 3), 12,
    'a change at bar one replaces the project\'s signature for the whole track');
});

test('polymetry: a 7/8 track meets a 4/4 one again after 28 quarters', () => {
  const seven = meterRegions([{ bar: 1, numerator: 7, denominator: 8 }]);
  const four = meterRegions([]);
  const lines = (regions) => new Set(Array.from({ length: 12 }, (_, bar) => meterBarPpq(regions, bar + 1)));
  const shared = [...lines(seven)].filter((q) => lines(four).has(q));
  assert.deepEqual(shared, [0, 28], 'eight 7/8 bars against seven 4/4 bars: they share a bar line every 28 quarters');
});

test('a meter keeps valid changes only, one per bar, in order', () => {
  assert.deepEqual(normalizeMeter([
    { bar: 9, numerator: 5, denominator: 4 }, { bar: 2, numerator: 7, denominator: 8 },
    { bar: 9, numerator: 3, denominator: 4 }, { bar: 0, numerator: 3, denominator: 4 },
    { bar: 4, numerator: 7, denominator: 3 }, null
  ]), [{ bar: 2, numerator: 7, denominator: 8 }, { bar: 9, numerator: 3, denominator: 4 }]);
});

test('a track\'s changes are saved and undone with it, and its clips land on its bars', () => {
  const { controller, commands, data } = controllerRig();
  const four = controller.model.addTrack('midi');
  const seven = controller.model.addTrack('midi');
  controller.changed();
  const sent = signaturesSent(commands).length;
  controller.setTrackMeterChange(seven.id, 1, { numerator: 7, denominator: 8 });
  assert.deepEqual(data.sequencerState.tracks[1].meter, [{ bar: 1, numerator: 7, denominator: 8 }]);
  assert.equal(signaturesSent(commands).length, sent, 'the engine keeps the project\'s signature');

  controller.model.state.snap = '1 bar';
  controller.addMidiClip(seven.id, 7.2);
  controller.addMidiClip(four.id, 7.2);
  assert.deepEqual([seven.clips[0].startPpq, seven.clips[0].lengthPpq], [7, 3.5], 'on the 7/8 track: its third bar, one bar long');
  assert.deepEqual([four.clips[0].startPpq, four.clips[0].lengthPpq], [8, 4], 'on the 4/4 track: the project\'s');
  controller.model.moveClips([four.clips[0].id], -0.4, seven.id, { anchorClipId: four.clips[0].id });
  assert.equal(seven.clips.at(-1).startPpq, 7, 'moved onto the 7/8 track, a clip lands on its bar line');

  controller.setTrackMeterChange(seven.id, 1, null);
  assert.deepEqual(controller.model.state.tracks[1].meter, [], 'Remove takes the change off');
  assert.deepEqual(controller.setTrackMeterChange('nope', 1, null), null);
});

test('an agent sets a track\'s meter whole, and reads it back', async () => {
  const { controller, hub } = controllerRig();
  const track = controller.model.addTrack('midi');
  hub.sequencer.setTrack = (trackId, changes) => { controller.model.updateTrack(trackId, changes); controller.changed(); return controller.model._track(trackId); };
  const answer = await handleAgentRequest(hub, {
    kind: 'set-track', trackId: track.id, expectedProjectId: 'project-signature',
    changes: { meter: [{ bar: 1, numerator: 12, denominator: 8 }, { bar: 5, numerator: 5, denominator: 3 }] }
  });
  assert.deepEqual(answer.track.meter, [{ bar: 1, numerator: 12, denominator: 8 }], 'what is not a signature is dropped');
});
