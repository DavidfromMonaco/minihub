import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventBus } from '../src/renderer/js/core/eventBus.js';
import { EngineClient } from '../src/renderer/js/core/engineClient.js';
import {
  DEFAULT_MASTER_OUTPUT,
  MASTER_OUTPUT_KEY,
  normalizeMasterOutput,
  setupMasterOutput,
  updateMasterOutput
} from '../src/renderer/js/core/masterOutput.js';
import { ProjectManager, PROJECT_KEYS } from '../src/renderer/js/core/projectManager.js';

test('Master owns only explicit static gain and discards legacy hidden ceilings', () => {
  assert.deepEqual(normalizeMasterOutput(null), DEFAULT_MASTER_OUTPUT);
  assert.deepEqual(normalizeMasterOutput({ gainDb: -99, ceilingDb: 3 }), { gainDb: -60 });
  assert.deepEqual(normalizeMasterOutput({ gainDb: 99, safetyCeilingDb: -99 }), { gainDb: 12 });
  assert.ok(PROJECT_KEYS.includes(MASTER_OUTPUT_KEY));

  const data = {};
  const hub = {
    settings: { data, get: (key) => data[key] },
    network: { serialize: () => [] },
    sequencer: { model: { snapshot: () => null } },
    events: { emit() {} }
  };
  const project = new ProjectManager(hub, {});
  project.applySnapshot({
    projectId: 'legacy', name: 'Legacy', createdAt: '2026-01-01',
    network: {}, nodeInstances: { instances: [], idSeq: {} }, transport: { bpm: 120 }
  }, null);
  assert.deepEqual(data.masterOutput, { gainDb: 0 },
    'old projects retain unity Master gain and remove every hidden limiter field');
  data.masterOutput = { gainDb: -7.5 };
  assert.deepEqual(project.snapshot().master, data.masterOutput,
    'Master gain is serialized as visible project state');
});

test('Master state publishes without its editor and is restored after engine restart', () => {
  const events = new EventBus();
  const sent = [];
  let dirty = 0;
  const data = { masterOutput: { gainDb: -6 } };
  const hub = {
    events,
    settings: {
      data,
      get: (key) => data[key],
      onSet: (key) => { if (key === MASTER_OUTPUT_KEY) dirty += 1; }
    },
    engine: {
      setMasterOutput: (value) => sent.push(value)
    }
  };
  setupMasterOutput(hub);
  events.emit('engine:state', { state: 'running' });
  updateMasterOutput(hub, { gainDb: 4.25 });
  assert.deepEqual(sent, [
    { gainDb: -6 },
    { gainDb: -6 },
    { gainDb: 4.25 }
  ]);
  assert.equal(dirty, 1);
});

test('native Master telemetry is cached and commands are bounded across IPC', async () => {
  const listeners = {};
  const sent = [];
  const api = {
    diagnosticsLog() {},
    onEngineState(callback) { listeners.state = callback; return () => {}; },
    onEngineEvent(callback) { listeners.event = callback; return () => {}; },
    engineState: async () => ({ state: 'stopped', error: null }),
    engineCommand: async (message) => { sent.push(message); return { ok: true }; }
  };
  const events = new EventBus();
  const seen = [];
  events.on('engine:masterMeter', (meter) => seen.push(meter));
  const client = new EngineClient(api, events, { get: () => [], set() {} });
  await client.init();
  listeners.event({ type: 'masterMeter', peakLeftDb: -3.2, peakRightDb: -4.1, clip: true });
  assert.equal(client.masterMeter.clip, true);
  assert.equal(seen.length, 1);
  await client.setMasterOutput({ gainDb: 99, safetyCeilingDb: -99 });
  await client.resetMasterClip();
  assert.deepEqual(sent, [
    { v: 1, type: 'setMasterOutput', gainDb: 12 },
    { v: 1, type: 'resetMasterClip' }
  ]);
});

test('Audio Output view exposes linear float summation, Master metering, and no protection gain', () => {
  const source = fs.readFileSync(new URL('../src/renderer/js/modules/audioOutput/audioOutputModule.js', import.meta.url), 'utf8');
  for (const id of ['master-gain', 'master-meter-l', 'master-meter-r', 'master-clip', 'master-pre-gain-peak', 'automatic-gain-reduction', 'audio-runtime-summary', 'audio-path-diagnostics'])
    assert.match(source, new RegExp(`id=["']${id}["']`));
  assert.doesNotMatch(source, /Limiter ON|master-gr/);
  assert.match(source, /engine:masterMeter/);
  assert.match(source, /Linear float sum · no auto gain/);
  assert.match(source, /engine:audioPathTelemetry/);
  assert.match(source, /engine:audioRuntimeTelemetry/);
  assert.match(source, /resetMasterClip/);
});
