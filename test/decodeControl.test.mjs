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
