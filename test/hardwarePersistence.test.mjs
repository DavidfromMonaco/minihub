import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from '../src/renderer/js/core/hub.js';
import { normalizeAudioOutputConfig } from '../src/renderer/js/core/hardwareConfig.js';
import { normalizeMidiInputPreference } from '../src/renderer/js/midi/midiManager.js';
import audioCommandValidation from '../src/main/audioDeviceCommand.js';

const { isValidSelectDeviceCommand } = audioCommandValidation;

function apiWithSettings(settings = {}, state = 'running') {
  const data = { ...settings };
  const sent = [];
  const listeners = { event: [], state: [] };
  return {
    data, sent,
    emitEvent(msg) { listeners.event.forEach((fn) => fn(msg)); },
    emitState(msg) { listeners.state.forEach((fn) => fn(msg)); },
    loadSettings: async () => ({ ...data }),
    saveSettings: async (next) => { Object.assign(data, next); return true; },
    diagnosticsLog: () => true,
    engineCommand: async (msg) => { sent.push(msg); return { ok: true }; },
    engineState: async () => ({ state, error: null }),
    onEngineEvent: (fn) => { listeners.event.push(fn); return () => {}; },
    onEngineState: (fn) => { listeners.state.push(fn); return () => {}; }
  };
}

const audioConfig = { deviceName: 'Speakers', sampleRate: 48000, bufferSize: 256 };
const devices = [{ name: 'Speakers', type: 'Windows Audio', isWASAPI: true }];
const selects = (api) => api.sent.filter((msg) => msg.type === 'selectDevice');

async function audioRig(settings = { audioOutputConfig: audioConfig }) {
  const api = apiWithSettings(settings);
  const hub = createHub(api);
  await hub.settings.load();
  await hub.engine.init();
  api.sent.length = 0;
  return { api, hub };
}

function enumerate(api, runtime = {
  type: 'deviceState', running: true, device: 'Default', sampleRate: 44100, bufferSize: 512
}, outputs = devices) {
  api.emitEvent({ type: 'devices', outputs });
  api.emitEvent(runtime);
}

test('audio preference validator accepts a bounded complete configuration', () => {
  assert.deepEqual(normalizeAudioOutputConfig(audioConfig), audioConfig);
});

test('audio preference validator rejects malformed and unbounded data', () => {
  for (const value of [null, {}, { ...audioConfig, deviceName: '' },
    { ...audioConfig, deviceName: 'x'.repeat(257) }, { ...audioConfig, sampleRate: '48000' },
    { ...audioConfig, bufferSize: 0 }, { ...audioConfig, bufferSize: 1.5 }]) {
    assert.equal(normalizeAudioOutputConfig(value), null);
  }
});

test('audio selection IPC rejects malformed device and numeric fields', () => {
  const valid = { v: 1, type: 'selectDevice', device: { name: 'Speakers' },
    sampleRate: 44100, bufferSize: 128 };
  assert.equal(isValidSelectDeviceCommand(valid), true);
  for (const mutation of [{ v: 2 }, { device: null }, { device: { name: '' } },
    { device: { name: 'x'.repeat(257) } }, { sampleRate: '44100' },
    { sampleRate: 7999 }, { sampleRate: Number.NaN }, { bufferSize: 0 },
    { bufferSize: 128.5 }, { bufferSize: '128' }]) {
    assert.equal(isValidSelectDeviceCommand({ ...valid, ...mutation }), false);
  }
});

test('audio restore waits for both device enumeration and runtime state', async () => {
  const { api } = await audioRig();
  api.emitEvent({ type: 'devices', outputs: devices });
  assert.equal(selects(api).length, 0);
  api.emitEvent({ type: 'deviceState', running: true, device: 'Default', sampleRate: 44100, bufferSize: 512 });
  assert.equal(selects(api).length, 1);
});

test('audio restore also waits when runtime state arrives before enumeration', async () => {
  const { api } = await audioRig();
  api.emitEvent({ type: 'deviceState', running: true, device: 'Default', sampleRate: 44100, bufferSize: 512 });
  assert.equal(selects(api).length, 0);
  api.emitEvent({ type: 'devices', outputs: devices });
  assert.equal(selects(api).length, 1);
});

test('exact runtime audio state is not reopened', async () => {
  const { api, hub } = await audioRig();
  enumerate(api, { type: 'deviceState', running: true, device: 'Speakers', sampleRate: 48000, bufferSize: 256 });
  assert.equal(selects(api).length, 0);
  assert.equal(hub.hardware.audioStatus.state, 'restored');
});

test('duplicate audio events cannot issue duplicate selection commands', async () => {
  const { api } = await audioRig();
  enumerate(api);
  enumerate(api);
  assert.equal(selects(api).length, 1);
});

test('an unavailable preferred output remains saved and runtime is untouched', async () => {
  const { api, hub } = await audioRig();
  enumerate(api, undefined, [{ name: 'Headphones', type: 'Windows Audio' }]);
  assert.equal(selects(api).length, 0);
  assert.deepEqual(hub.settings.get('audioOutputConfig'), audioConfig);
  assert.equal(hub.hardware.audioStatus.state, 'preferred-unavailable');
  assert.equal(hub.hardware.audioStatus.runtime.device, 'Default');
});

test('a preferred audio device is retried when a later enumeration finds it', async () => {
  const { api } = await audioRig();
  enumerate(api, undefined, []);
  api.emitEvent({ type: 'devices', outputs: devices });
  assert.equal(selects(api).length, 1);
});

test('engine restart permits exactly one fresh audio restore attempt', async () => {
  const { api, hub } = await audioRig();
  enumerate(api);
  api.emitState({ state: 'error', error: 'crashed' });
  api.emitState({ state: 'running', error: null });
  api.emitEvent({ type: 'devices', outputs: devices });
  api.emitEvent({ type: 'deviceState', running: true, device: 'Default', sampleRate: 44100, bufferSize: 512 });
  assert.equal(selects(api).length, 2);
  assert.equal(hub.engine.runtimeGeneration, 1);
});

test('engine crash clears runtime audio but retains preference', async () => {
  const { api, hub } = await audioRig();
  enumerate(api);
  api.emitState({ state: 'error', error: 'crashed' });
  assert.equal(hub.hardware.audioStatus.runtime, null);
  assert.deepEqual(hub.settings.get('audioOutputConfig'), audioConfig);
});

test('explicit available audio choice persists and applies once', async () => {
  const { api, hub } = await audioRig({});
  enumerate(api);
  api.sent.length = 0;
  const result = await hub.hardware.applyAudioPreference(audioConfig);
  assert.equal(result.applied, true);
  assert.deepEqual(api.data.audioOutputConfig, audioConfig);
  assert.equal(selects(api).length, 1);
});

test('explicit unavailable audio choice persists without forcing fallback', async () => {
  const { api, hub } = await audioRig({});
  enumerate(api, undefined, []);
  api.sent.length = 0;
  const result = await hub.hardware.applyAudioPreference(audioConfig);
  assert.equal(result.applied, false);
  assert.deepEqual(api.data.audioOutputConfig, audioConfig);
  assert.equal(selects(api).length, 0);
});

test('audio device-open failure is visible without erasing preference', async () => {
  const { api, hub } = await audioRig();
  enumerate(api);
  api.emitEvent({ type: 'error', code: 'device-open', message: 'unsupported rate' });
  assert.equal(hub.hardware.audioStatus.state, 'restore-failed');
  assert.deepEqual(hub.settings.get('audioOutputConfig'), audioConfig);
});

test('audio refresh requests both enumeration and actual runtime state', async () => {
  const { api, hub } = await audioRig();
  hub.hardware.refreshAudioDevices();
  assert.deepEqual(api.sent.map((msg) => msg.type), ['listDevices', 'getDeviceState']);
});

test('preferred and runtime audio states remain separately observable', async () => {
  const { api, hub } = await audioRig();
  enumerate(api);
  assert.equal(hub.hardware.audioStatus.preferred.deviceName, 'Speakers');
  assert.equal(hub.hardware.audioStatus.runtime.device, 'Default');
});

const midiPref = { id: 'old-id', name: 'Minilab3 MIDI', manufacturer: 'Arturia', type: 'input' };
const port = (id = 'old-id', name = 'Minilab3 MIDI', manufacturer = 'Arturia') => ({
  id, name, manufacturer, type: 'input', onmidimessage: null
});

function midiRig(settings = {}, ports = []) {
  const api = apiWithSettings(settings, 'stopped');
  const hub = createHub(api);
  hub.settings.data = { ...settings };
  hub.midi.midiAccess = { inputs: new Map(ports.map((p) => [p.id, p])), outputs: new Map(), onstatechange: null };
  return { api, hub };
}

test('MIDI preference validator preserves stable identity fields', () => {
  assert.deepEqual(normalizeMidiInputPreference(midiPref), midiPref);
  assert.equal(normalizeMidiInputPreference({ id: '', name: '' }), null);
});

test('MIDI preference restores by fingerprint when Web MIDI id changes', () => {
  const replacement = port('new-id');
  const { hub } = midiRig({ midiInputPreference: midiPref, selectedInputId: 'old-id' }, [replacement]);
  hub.midi._refreshPorts();
  assert.equal(hub.midi.selectedInputId, 'new-id');
  assert.equal(hub.settings.get('midiInputPreference').id, 'new-id');
});

test('MIDI enumeration order does not change the preferred port', () => {
  const wanted = port('new-id');
  const other = port('other-id', 'Minilab3 ALV');
  const { hub } = midiRig({ midiInputPreference: midiPref }, [other, wanted]);
  hub.midi._refreshPorts();
  assert.equal(hub.midi.selectedInputId, 'new-id');
});

test('a reused Web MIDI id cannot impersonate a different preferred device', () => {
  const { hub } = midiRig({ midiInputPreference: midiPref }, [port('old-id', 'Other Keyboard', 'Other')]);
  hub.midi._refreshPorts();
  assert.equal(hub.midi.selectedInputId, null);
});

test('unavailable MIDI preference survives enumeration', () => {
  const { hub } = midiRig({ midiInputPreference: midiPref }, []);
  hub.midi._refreshPorts();
  assert.deepEqual(hub.settings.get('midiInputPreference'), midiPref);
  assert.equal(hub.midi.inputPreferenceStatus().available, false);
});

test('MIDI unplug panics once and hot-plug re-arms the same physical port', () => {
  const original = port();
  const { hub } = midiRig({ midiInputPreference: midiPref }, [original]);
  let panics = 0;
  hub.events.on('midi:panic', () => { panics += 1; });
  hub.midi._refreshPorts();
  hub.midi.midiAccess.inputs = new Map();
  hub.midi._refreshPorts();
  hub.midi._refreshPorts();
  assert.equal(panics, 1);
  const returned = port('returned-id');
  hub.midi.midiAccess.inputs = new Map([[returned.id, returned]]);
  hub.midi._refreshPorts();
  assert.equal(hub.midi.selectedInputId, 'returned-id');
});

test('repeated MIDI refresh keeps one message handler on the same port', () => {
  const original = port();
  const { hub } = midiRig({ midiInputPreference: midiPref }, [original]);
  hub.midi._refreshPorts();
  const handler = original.onmidimessage;
  hub.midi._refreshPorts();
  assert.equal(original.onmidimessage, handler);
  assert.equal(hub.midi._messageHandlers.size, 1);
});

test('replacing a MIDI port object detaches the old listener', () => {
  const original = port();
  const { hub } = midiRig({ midiInputPreference: midiPref }, [original]);
  hub.midi._refreshPorts();
  const replacement = port();
  hub.midi.midiAccess.inputs = new Map([[replacement.id, replacement]]);
  hub.midi._refreshPorts();
  assert.equal(original.onmidimessage, null);
  assert.equal(typeof replacement.onmidimessage, 'function');
});

test('explicit MIDI disconnect clears modern and legacy preferences', () => {
  const original = port();
  const { hub } = midiRig({ midiInputPreference: midiPref, selectedInputId: 'old-id' }, [original]);
  hub.midi._refreshPorts();
  hub.midi.selectInput(null, { remember: true });
  assert.equal(hub.settings.get('midiInputPreference'), null);
  assert.equal(hub.settings.get('selectedInputId'), null);
});

test('legacy MIDI id is migrated after the port becomes available', () => {
  const original = port();
  const { hub } = midiRig({ selectedInputId: 'old-id' }, [original]);
  hub.midi._refreshPorts();
  assert.deepEqual(hub.settings.get('midiInputPreference'), midiPref);
});

test('unavailable legacy MIDI id is retained for a later hot-plug', () => {
  const { hub } = midiRig({ selectedInputId: 'old-id' }, []);
  hub.midi._refreshPorts();
  assert.equal(hub.settings.get('selectedInputId'), 'old-id');
});

test('legacy MiniLab control-surface preference is corrected to performance input', () => {
  const control = port('control', 'Minilab3 MCU/HUI');
  const musical = port('music', 'Minilab3 MIDI');
  const { hub } = midiRig({ selectedInputId: 'control' }, [control, musical]);
  hub.midi._refreshPorts();
  assert.equal(hub.midi.selectedInputId, 'music');
  assert.equal(hub.settings.get('midiInputPreference').name, 'Minilab3 MIDI');
});

test('first-run MiniLab auto-selection remembers the performance input', () => {
  const musical = port('music');
  const { hub } = midiRig({}, [port('control', 'Minilab3 MCU/HUI'), musical]);
  hub.midi._refreshPorts();
  assert.equal(hub.midi.autoSelectMiniLabInput(), 'music');
  assert.equal(hub.settings.get('midiInputPreference').id, 'music');
});

test('a deliberate non-MiniLab MIDI preference is preserved', () => {
  const other = port('keys', 'Other Keyboard', 'Other');
  const preference = { id: 'keys', name: 'Other Keyboard', manufacturer: 'Other', type: 'input' };
  const { hub } = midiRig({ midiInputPreference: preference }, [port('music'), other]);
  hub.midi._refreshPorts();
  assert.equal(hub.midi.selectedInputId, 'keys');
});
