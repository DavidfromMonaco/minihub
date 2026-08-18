import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockSettings } from './helpers.mjs';
import { parseMidiMessage, noteName, describeMessage } from '../src/renderer/js/midi/parseMidi.js';
import { MidiManager } from '../src/renderer/js/midi/midiManager.js';
import { EventBus } from '../src/renderer/js/core/eventBus.js';

test('parseMidiMessage normalizes note on/off/cc/pitchbend', () => {
  assert.equal(parseMidiMessage([0x90, 60, 100]).type, 'noteon');
  assert.equal(parseMidiMessage([0x90, 60, 0]).type, 'noteoff');
  assert.equal(parseMidiMessage([0x80, 60, 0]).type, 'noteoff');
  assert.equal(parseMidiMessage([0xb0, 1, 64]).type, 'cc');
  const pb = parseMidiMessage([0xe0, 0x00, 0x40]);
  assert.equal(pb.type, 'pitchbend');
  assert.equal(pb.bend, 8192);
  assert.equal(parseMidiMessage([0xf8]), null);
});

test('noteName maps notes to chromatic names', () => {
  assert.equal(noteName(60), 'C4');
  assert.equal(noteName(36), 'C2');
});

test('timing compensation annotates messages without delaying them', () => {
  const settings = mockSettings({ inputOffsets: { in1: -20 } });
  const events = new EventBus();
  const mm = new MidiManager(events, settings);
  mm.inputs.set('in1', { id: 'in1', name: 'MiniLab 3', manufacturer: 'Arturia' });
  mm.selectedInputId = 'in1';

  const received = [];
  events.on('midi:message', (m) => received.push(m));

  mm._onMessage('in1', [0x90, 60, 100], 1000);

  assert.equal(received.length, 1);
  const msg = received[0];
  assert.equal(msg.type, 'noteon');
  assert.equal(msg.webMidiTimestamp, 1000);
  assert.equal(msg.offsetMs, -20);
  assert.equal(msg.compensatedTimestamp, 980);
  assert.equal(typeof msg.hubTimestamp, 'number');
  assert.equal(typeof msg.processingDelayMs, 'number');
  assert.equal(msg.sourceName, 'MiniLab 3');
});

test('offset default is 0 and setInputOffset persists', async () => {
  const settings = mockSettings();
  const events = new EventBus();
  const mm = new MidiManager(events, settings);
  assert.equal(mm.getInputOffset('in1'), 0);
  await mm.setInputOffset('in1', 15);
  assert.equal(mm.getInputOffset('in1'), 15);
  assert.deepEqual(settings.get('inputOffsets'), { in1: 15 });
  await mm.setInputOffset('in1', 0);
  assert.deepEqual(settings.get('inputOffsets'), {});
});

test('messages from non-selected input are ignored', () => {
  const settings = mockSettings();
  const events = new EventBus();
  const mm = new MidiManager(events, settings);
  mm.inputs.set('in1', { id: 'in1', name: 'Other', manufacturer: '' });
  mm.selectedInputId = 'in1';
  let count = 0;
  events.on('midi:message', () => count++);
  mm._onMessage('in2', [0x90, 60, 100], 100);
  assert.equal(count, 0);
});
