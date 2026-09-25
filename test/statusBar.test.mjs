/**
 * The status bar (D-055): the audio engine's state and the device it plays on,
 * in words a person reads, from the events the engine client already emits.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeHub } from './helpers.mjs';
import { makeEl } from './domShim.mjs';
import { audioDeviceText, buildStatusBar, engineStatusText } from '../src/renderer/js/ui/statusBar.js';

test('the engine line says what the engine is doing', () => {
  assert.deepEqual(engineStatusText('running', { running: true }), { text: 'Audio engine running', level: 'ok' });
  assert.equal(engineStatusText('running', { running: false }).level, 'warn');
  assert.equal(engineStatusText('starting', null).text, 'Audio engine starting');
  assert.equal(engineStatusText('error', null).level, 'danger');
  assert.equal(engineStatusText('stopped', null).text, 'Audio engine stopped');
});

test('the device line names the device, its rate and its buffer, or nothing', () => {
  assert.equal(audioDeviceText({ running: true, device: 'Speakers', sampleRate: 48000, bufferSize: 256 }),
    'Speakers · 48 kHz · 256 samples');
  assert.equal(audioDeviceText({ running: true, device: 'Speakers', sampleRate: 44100, bufferSize: 512 }),
    'Speakers · 44.1 kHz · 512 samples');
  assert.equal(audioDeviceText({ running: false, device: 'Speakers' }), '', 'a device not open is not shown as one');
  assert.equal(audioDeviceText(null), '');
});

test('the bar follows the engine, and its disposer stops it', () => {
  const hub = makeHub();
  hub.engine = { state: 'starting', deviceState: null };
  const engineEl = makeEl('span');
  const deviceEl = makeEl('span');
  const dispose = buildStatusBar(hub, { engineEl, deviceEl });
  assert.equal(engineEl.textContent, 'Audio engine starting');

  hub.engine.state = 'running';
  hub.engine.deviceState = { running: true, device: '<b>Speakers</b>', sampleRate: 48000, bufferSize: 128 };
  hub.events.emit('engine:deviceState', hub.engine.deviceState);
  assert.equal(engineEl.className, 'engine-status ok');
  assert.equal(deviceEl.textContent, '<b>Speakers</b> · 48 kHz · 128 samples', 'text, never markup (invariant 9)');

  dispose();
  hub.engine.state = 'error';
  hub.events.emit('engine:state', { state: 'error' });
  assert.equal(engineEl.className, 'engine-status ok', 'unsubscribed');
});
