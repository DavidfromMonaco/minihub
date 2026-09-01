'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createEngineEventTrace } = require('../src/main/engineEventTrace');

test('periodic telemetry never reaches the synchronous startup log', () => {
  const trace = createEngineEventTrace();
  for (const type of ['masterMeter', 'hostTiming', 'audioPathTelemetry',
                      'transport', 'recorderState', 'nodeSafetyTelemetry',
                      'metronomeTick']) {
    assert.equal(trace({ type }), null, type + ' must not be logged per occurrence');
  }
});

test('lifecycle events are still logged with their details', () => {
  const trace = createEngineEventTrace();
  assert.equal(trace({ type: 'deviceState' }), 'engine:event deviceState');
  assert.equal(trace({ type: 'error' }, ' code=device-open'),
               'engine:event error code=device-open');
  assert.equal(trace({ type: 'pluginState' }), 'engine:event pluginState');
});

test('a clean runtime telemetry window is silent', () => {
  const trace = createEngineEventTrace();
  assert.equal(trace({
    type: 'audioRuntimeTelemetry',
    chainBlocksSkippedSinceSnapshot: 0,
    pluginBlocksSkippedSinceSnapshot: 0,
    deadlineMisses: 0,
    estimatedSchedulingUnderruns: 0,
    paOutputUnderflows: 0,
    portAudioNonFiniteSamples: 0
  }), null);
});

test('silent dropouts are reported, which no other counter can show', () => {
  const trace = createEngineEventTrace();
  const line = trace({
    type: 'audioRuntimeTelemetry',
    chainBlocksSkippedSinceSnapshot: 3,
    pluginBlocksSkippedSinceSnapshot: 12,
    deadlineMisses: 0,
    paOutputUnderflows: 0
  });
  assert.equal(line, 'engine:anomaly chainBlocksSkipped=3 pluginBlocksSkipped=12');
});

test('cumulative PortAudio counters are reported by growth, not by level', () => {
  const trace = createEngineEventTrace();
  const first = trace({ type: 'audioRuntimeTelemetry', paOutputUnderflows: 4 });
  assert.equal(first, 'engine:anomaly paOutputUnderflows=+4');
  // Same total on the next window: the fault did not recur, so no new line.
  assert.equal(trace({ type: 'audioRuntimeTelemetry', paOutputUnderflows: 4 }), null);
  assert.equal(trace({ type: 'audioRuntimeTelemetry', paOutputUnderflows: 7 }),
               'engine:anomaly paOutputUnderflows=+3');
});

test('a malformed event is dropped rather than logged as undefined', () => {
  const trace = createEngineEventTrace();
  assert.equal(trace({}), null);
  assert.equal(trace(null), null);
});
