'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateProject, readProject, writeProjectAtomic } = require('../src/main/projectFiles');

function sample() {
  return { format: 'minihub-project', version: 1, projectId: 'p-1', name: 'Test', createdAt: '2026-01-01', modifiedAt: '2026-01-01', graph: { connections: [], layout: {} }, nodeInstances: { instances: [], idSeq: {} }, transport: { bpm: 123 }, sequencer: { version: 1, loop: { enabled: true, startPpq: 4, endPpq: 12 }, snap: '1/16', zoom: 72, scrollPpq: 0, selectedClipId: 'clip-midi', tracks: [{ id: 'track-midi', type: 'midi', name: 'MIDI 1', armed: false, muted: false, volume: .8, inputId: 'keys', outputId: 'vst-001', clips: [{ id: 'clip-midi', name: 'MIDI Clip', startPpq: 4, lengthPpq: 4, gain: 1, notes: [{ id: 'note-1', pitch: 60, startPpq: 0, durationPpq: 1, velocity: 90, channel: 2 }] }] }, { id: 'track-audio', type: 'audio', name: 'Audio 1', armed: false, muted: true, volume: .6, inputId: 'audio-input', outputId: 'mixer-001', clips: [{ id: 'clip-audio', name: 'Take', startPpq: 8, lengthPpq: 2, gain: .7, filePath: 'D:\\Audio\\take.wav', trimStartSeconds: .1, trimEndSeconds: 1.1, durationSeconds: 1.5, peaks: [.2, .8] }] }] } };
}

test('project validates, saves atomically, and reopens unchanged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minihub-project-'));
  const target = path.join(dir, 'Test.minihub');
  writeProjectAtomic(target, sample());
  assert.deepEqual(readProject(target), sample());
  assert.equal(fs.readdirSync(dir).some((name) => name.endsWith('.tmp')), false);
});

test('malformed and unsupported project files are rejected before replacement', () => {
  assert.throws(() => validateProject({}), /Not a MiniHub project/);
  assert.throws(() => validateProject({ ...sample(), version: 99 }), /Unsupported/);
});

test('atomic write failure preserves the previous valid project', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minihub-project-'));
  const target = path.join(dir, 'Test.minihub');
  writeProjectAtomic(target, sample());
  const io = { ...fs, mkdirSync: fs.mkdirSync, writeFileSync: fs.writeFileSync, rmSync: fs.rmSync, renameSync() { throw new Error('replace failed'); } };
  assert.throws(() => writeProjectAtomic(target, { ...sample(), name: 'Changed' }, io), /replace failed/);
  assert.equal(readProject(target).name, 'Test');
});
