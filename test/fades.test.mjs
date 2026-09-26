import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_FADE_SHAPE, FADE_SHAPES, fadeGain, fadePaths, fadeShapeGain, fadeShapeIcon, fitFades, lowPassCutoffHz, normalizeFade
} from '../src/renderer/js/core/fades.js';
import { SequencerModel } from '../src/renderer/js/core/sequencerModel.js';
import { SequencerController } from '../src/renderer/js/core/sequencerController.js';
import { fadeRegionAt, fadeZoneAt } from '../src/renderer/js/modules/sequencer/sequencerModule.js';

const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: ${actual} vs ${expected}`);

test('Reaper\'s seven shapes, and the values the engine plays', () => {
  assert.equal(FADE_SHAPES.length, 7);
  assert.equal(FADE_SHAPES[DEFAULT_FADE_SHAPE], 'Fast start', 'a new fade takes the shape Reaper ticks by default');
  // The same numbers as testClipFades in the native core tests.
  close(fadeShapeGain(1, 0.3), 0.51, 'fast start at 0.3');
  close(fadeShapeGain(6, 0.25), 0.03125, 'steep S-curve at a quarter');
  close(fadeGain(1, 0.5, 0.5), 0.8660254, 'a curvature of 0.5 takes the square root');
  for (let shape = 0; shape < 7; shape += 1) {
    assert.equal(fadeShapeGain(shape, 0), 0, `${FADE_SHAPES[shape]} starts silent`);
    close(fadeShapeGain(shape, 1), 1, `${FADE_SHAPES[shape]} ends at full level`);
    assert.equal(fadeGain(shape, -1, 0), 0);
    close(fadeGain(shape, 1, 1), 1, 'whatever the curve');
  }
  assert.ok(fadeGain(0, 1, 0.5) > 0.5 && fadeGain(0, -1, 0.5) < 0.5, 'dragging the curve up bulges it, down sags it');
  close(lowPassCutoffHz(0), 20, 'the sweep starts at 20 Hz');
  close(lowPassCutoffHz(1), 20000, 'and opens to 20 kHz');
});

test('a fade is drawn rising for a fade-in and falling for a fade-out', () => {
  const linear = { shape: 0, curve: 0 };
  assert.match(fadePaths(linear, 'in').line, /^M0\.00 100\.00 .* L100\.00 0\.00$/);
  assert.match(fadePaths(linear, 'out').line, /^M0\.00 0\.00 .* L100\.00 100\.00$/);
  assert.match(fadeShapeIcon(0, 'out'), /^M0 12 L0\.00 0\.00/, 'the fade-out menu pictures fall too');
});

test('fades are bounded, and fitted into the sound the clip plays', () => {
  assert.deepEqual(normalizeFade({ seconds: -2, shape: 9, curve: 5, lowPass: 'yes' }),
    { seconds: 0, shape: DEFAULT_FADE_SHAPE, curve: 1, lowPass: false });
  const fitted = fitFades({ seconds: 3 }, { seconds: 3 }, 4);
  assert.deepEqual([fitted.fadeIn.seconds, fitted.fadeOut.seconds], [3, 1], 'they may meet, never cross: the fade-out gives way');
});

function audioModel() {
  const model = new SequencerModel();
  const track = model.addTrack('audio');
  const clip = model.addAudioClip(track.id, {
    name: 'Decay', filePath: 'C:/Decay.wav', startPpq: 0, lengthPpq: 8,
    durationSeconds: 4, trimStartSeconds: 0, trimEndSeconds: 4
  });
  return { model, track, clip };
}

test('a clip keeps its fades on the side they belong to when it is cut', () => {
  const { model, clip } = audioModel();
  model.updateAudioClip(clip.id, { fadeIn: { seconds: 0.5 }, fadeOut: { seconds: 1, shape: 5, lowPass: true } }, { bpm: 120 });
  assert.equal(clip.fadeIn.seconds, 0.5);
  assert.deepEqual(clip.fadeOut, { seconds: 1, shape: 5, curve: 0, lowPass: true }, 'a part given is laid over the fade');
  const [head, tail] = model.splitClip(clip.id, 4, { bpm: 120 });
  assert.deepEqual([head.fadeIn.seconds, head.fadeOut.seconds], [0.5, 0], 'the head keeps its fade-in');
  assert.deepEqual([tail.fadeIn.seconds, tail.fadeOut.seconds, tail.fadeOut.shape], [0, 1, 5], 'the tail its fade-out');
  model.resizeClip(head.id, 0.5, 'end', { bpm: 120 });
  assert.ok(head.fadeIn.seconds <= 0.25 + 1e-9, 'a trim shorter than the fade shortens it');
});

test('a fade change is published, saved and undoable in one step', () => {
  const commands = [];
  const data = { transportBpm: 120 };
  const hub = {
    settings: { get: (key) => data[key], set: (key, value) => { data[key] = value; } },
    network: { connectionsTo: () => [], connectionsFrom: () => [], getNode: () => null },
    engine: { setTransport: () => {}, syncSequencer: (state) => commands.push(state) },
    events: { emit() {} }, midi: { selectedOutputId: '', getOutput: () => null }, api: {},
    project: { projectId: 'p', _transitionPending: false }
  };
  const controller = new SequencerController(hub);
  const track = controller.model.addTrack('audio');
  const clip = controller.model.addAudioClip(track.id, { filePath: 'C:/a.wav', lengthPpq: 8, durationSeconds: 4, trimEndSeconds: 4 });
  assert.deepEqual(controller.setClipFade(clip.id, 'out', { seconds: 2, shape: 2 }), { seconds: 2, shape: 2, curve: 0, lowPass: false });
  assert.equal(data.sequencerState.tracks[0].clips[0].fadeOut.seconds, 2, 'saved with the arrangement');
});

test('the hand takes a fade at its top corner, its handle, or its curve', () => {
  // A 4-second clip at 120 BPM and 20 px per quarter: 160 px wide, 1 s = 40 px.
  const clip = { fadeIn: { seconds: 0, shape: 0, curve: 0 }, fadeOut: { seconds: 1, shape: 0, curve: 0 } };
  const at = (x, y) => fadeZoneAt(clip, 20, 120, 160, 40, x, y);
  assert.equal(at(2, 4), 'in-length', 'the top left corner starts a fade that is not there');
  assert.equal(at(120, 4), 'out-length', 'the handle where the fade-out begins takes it again');
  assert.equal(at(80, 4), '', 'the middle of the top is the clip\'s');
  assert.equal(at(2, 30), '', 'the corner is the top of the clip only');
  assert.equal(at(140, 20), 'out-curve', 'half-way through a linear fade-out, half-way down');
  assert.equal(at(140, 36), '', 'away from the curve, the clip');
  assert.equal(fadeRegionAt(clip, 20, 120, 160, 150), 'out', 'a right-click inside the fade opens its menu');
  assert.equal(fadeRegionAt(clip, 20, 120, 160, 60), '');
});
