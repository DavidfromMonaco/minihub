import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeControl } from '../src/renderer/js/midi/decodeControl.js';
import { decodeMiniLabControl } from '../src/renderer/js/midi/minilabControls.js';
import miniLab from '../src/renderer/js/midi/profiles/minilab-3.json' with { type: 'json' };

/**
 * Contract: the decoder answers with the PROFILE's vocabulary, and MiniHub's
 * names are added afterwards by whoever asked.
 *
 * That boundary is what makes the file shareable with the site Builder
 * (specification section 3.5), and it is invisible in the conformance corpus:
 * the corpus checks the finished CONTROL event, so a decoder that quietly went
 * back to knowing a node id would still pass it. These tests watch the seam
 * instead of the result.
 *
 * The device-agnostic proof at full size -- a second profile with its own corpus
 * -- is step 6 of the plan. What is proved here is narrower and enough for this
 * step: the decoder answers a profile it has never seen, and answers it in that
 * profile's own terms.
 */

/** A pedal box, sharing no control id, no CC and no port name with the MiniLab. */
const PEDALS = {
  profileId: 'pedals',
  device: {
    ports: [
      { role: 'performance', priority: 5, match: { name: 'Pedals In' } },
      { role: 'ignore', priority: 0, match: { name: 'Pedals Thru' } }
    ]
  },
  controls: [
    {
      id: 'sustain', label: 'Sustain', family: 'switch',
      // CC 74 as well: the same message, a different control, another profile.
      bindings: [{ layer: 'default', when: { kind: 'cc', number: 74 }, mode: 'toggle' }]
    },
    {
      id: 'swell', label: 'Swell', family: 'pedal',
      bindings: [{ layer: 'default', when: { kind: 'cc', channel: 4, number: 11 }, mode: 'absolute' }]
    }
  ]
};

const cc = (controller, value, sourceName, channel = 1) =>
  ({ type: 'cc', channel, controller, value, sourceName });

// ---- the seam -----------------------------------------------------------------

test('the decoder answers with the profile control and binding, not with a name', () => {
  const hit = decodeControl(miniLab, cc(74, 13, 'Minilab3 MIDI'));
  assert.equal(hit.control, miniLab.controls.find((control) => control.id === 'k1'));
  assert.equal(hit.binding, hit.control.bindings[0]);
  assert.deepEqual(
    Object.keys(hit).sort(),
    ['binding', 'control', 'normalizedValue', 'rawValue'],
    'a MiniHub identity leaking in here would travel to the Builder with the file'
  );
});

test('no MiniHub name reaches the shared decoder result', () => {
  const messages = [
    cc(74, 13, 'Minilab3 MIDI'),
    { type: 'noteon', channel: 10, note: 36, velocity: 96, sourceName: 'Minilab3 MIDI' },
    { type: 'pitchbend', channel: 1, bend: 0, sourceName: 'Minilab3 MIDI' }
  ];
  for (const msg of messages) {
    const hit = decodeControl(miniLab, msg);
    assert.ok(hit, `${msg.type} decodes`);
    for (const forbidden of ['type', 'sourceNodeId', 'sourcePortId', 'sourceControlId', 'semantics', 'label']) {
      assert.equal(forbidden in hit, false, `${msg.type} result carries '${forbidden}'`);
    }
  }
});

test('the caller is what turns the profile answer into MiniHub names', () => {
  const named = decodeMiniLabControl(cc(74, 13, 'Minilab3 MIDI'));
  const raw = decodeControl(miniLab, cc(74, 13, 'Minilab3 MIDI'));
  assert.equal(named.sourceControlId, `${miniLab.profileId}:${raw.control.id}`);
  assert.equal(named.sourcePortId, `control-${raw.control.id}`);
  assert.equal(named.label, raw.control.label);
  assert.equal(named.normalizedValue, raw.normalizedValue);
  assert.equal('binding' in named, false, 'the declaration that answered stays with the decoder');
});

// ---- another profile ----------------------------------------------------------

test('a profile the decoder has never seen answers in its own terms', () => {
  const hit = decodeControl(PEDALS, cc(74, 127, 'Pedals In'));
  assert.equal(hit.control.id, 'sustain');
  assert.equal(hit.control.label, 'Sustain');
  assert.equal(hit.normalizedValue, 1);
});

test('the same CC is a different control under a different profile', () => {
  assert.equal(decodeControl(miniLab, cc(74, 64, 'Minilab3 MIDI')).control.id, 'k1');
  assert.equal(decodeControl(PEDALS, cc(74, 64, 'Pedals In')).control.id, 'sustain');
  assert.equal(decodeControl(PEDALS, cc(74, 64, 'Minilab3 MIDI')), null,
    "the MiniLab's port is not this profile's port");
  assert.equal(decodeControl(miniLab, cc(74, 64, 'Pedals In')), null);
});

test('a declared channel is matched, and an undeclared one answers on any', () => {
  assert.equal(decodeControl(PEDALS, cc(11, 64, 'Pedals In', 4)).control.id, 'swell');
  assert.equal(decodeControl(PEDALS, cc(11, 64, 'Pedals In', 1)), null,
    'CC 11 is declared on channel 4 only');
  assert.equal(decodeControl(PEDALS, cc(74, 64, 'Pedals In', 16)).control.id, 'sustain');
});

test('a port that cannot carry a note decodes to nothing, profile by profile', () => {
  assert.equal(decodeControl(PEDALS, cc(74, 64, 'Pedals Thru')), null);
  assert.equal(decodeControl(PEDALS, cc(74, 64, '')), null);
  assert.equal(decodeControl(PEDALS, null), null);
});

test('two profiles never share one lookup table', () => {
  // The index is cached per profile object; a cache keyed on anything coarser
  // would answer the second profile with the first one's controls.
  for (let round = 0; round < 2; round += 1) {
    assert.equal(decodeControl(miniLab, cc(74, 64, 'Minilab3 MIDI')).control.label, 'K1');
    assert.equal(decodeControl(PEDALS, cc(74, 64, 'Pedals In')).control.label, 'Sustain');
  }
});

// ---- what a binding declares about its travel ---------------------------------

/**
 * A profile that never met the validator, which is the case the decoder has to
 * survive rather than the one it would like: the built-in profile ships without
 * being validated (see `minilabControls.js`), and `range` is a field a stranger
 * writes. Two of these bindings could not pass `validateControllerProfile()`.
 */
const TRAVEL = {
  profileId: 'travel',
  device: { ports: [{ role: 'performance', priority: 5, match: { name: 'Travel In' } }] },
  controls: [
    { id: 'declared', label: 'Declared', family: 'fader',
      bindings: [{ layer: 'default', when: { kind: 'cc', number: 20 }, mode: 'absolute', range: [16, 112] }] },
    { id: 'silent', label: 'Silent', family: 'fader',
      bindings: [{ layer: 'default', when: { kind: 'cc', number: 21 }, mode: 'absolute' }] },
    { id: 'inverted', label: 'Inverted', family: 'fader',
      bindings: [{ layer: 'default', when: { kind: 'cc', number: 22 }, mode: 'absolute', range: [100, 20] }] },
    { id: 'nonsense', label: 'Nonsense', family: 'fader',
      bindings: [{ layer: 'default', when: { kind: 'cc', number: 23 }, mode: 'absolute', range: ['16', null] }] },
    { id: 'pressure', label: 'Pressure', family: 'strip',
      bindings: [{ layer: 'default', when: { kind: 'channelpressure' }, mode: 'pressure' }] }
  ]
};

const travel = (controller, value) =>
  decodeControl(TRAVEL, { type: 'cc', channel: 1, controller, value, sourceName: 'Travel In' });

test('a binding is normalised against the travel it declares, not against the wire format', () => {
  assert.equal(travel(20, 16).normalizedValue, 0);
  assert.equal(travel(20, 64).normalizedValue, 0.5, 'the full span would have said 0.504');
  assert.equal(travel(20, 112).normalizedValue, 1, 'the full span would have said 0.882');
  assert.equal(travel(21, 64).normalizedValue, 64 / 127, 'a binding declaring no range keeps the full span');
});

test('a value outside the declared travel is clamped, never reported past the ends', () => {
  // A pedal declared [16, 112] that sends 120 once is a real pedal; a consumer
  // handed 1.083 for a VST parameter has no rule for it.
  assert.equal(travel(20, 127).normalizedValue, 1);
  assert.equal(travel(20, 0).normalizedValue, 0);
});

test('a range the validator would have refused falls back to the full span, and never to NaN', () => {
  for (const [controller, id] of [[22, 'inverted'], [23, 'nonsense']]) {
    const hit = travel(controller, 64);
    assert.equal(hit.control.id, id);
    assert.equal(hit.normalizedValue, 64 / 127, `${id} did not fall back to the full span`);
  }
});

test('channel pressure answers on kind and channel alone, carrying no note', () => {
  const press = (channel, value) =>
    decodeControl(TRAVEL, { type: 'channelpressure', channel, value, sourceName: 'Travel In' });
  assert.equal(press(1, 127).control.id, 'pressure');
  assert.equal(press(1, 127).normalizedValue, 1);
  assert.equal(press(16, 64).normalizedValue, 64 / 127, 'a binding declaring no channel answers on any');
  assert.deepEqual(Object.keys(press(1, 64)).sort(), ['binding', 'control', 'normalizedValue', 'rawValue'],
    'a pressure stream names no note, so the result carries none');
  assert.equal(press(1, 64).rawValue, 64);
});
