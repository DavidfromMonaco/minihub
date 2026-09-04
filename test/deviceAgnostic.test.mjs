/**
 * A second profile, and the proof that the machinery does not know the first
 * one.
 *
 * Steps 1 to 5 of this workstream moved the MiniLab 3 out of the code one place
 * at a time, and each step was checked against the device that ships. That is a
 * proof with a hole in it the size of the only profile there is: a format which
 * has only ever described one device has not been shown to describe a device.
 *
 * `test/conformance/vega-49.json` is a controller nobody owns -- Nebula
 * Instruments does not exist -- built to share NOTHING with the MiniLab 3: other
 * port names, other control ids, another layout box, another set of CC numbers,
 * pads on another channel. Where it deliberately overlaps is CC 74, so that "the
 * profile decides, not the number" is an assertion rather than a hope.
 *
 * It also exercises what the shipped profile does not, because a format is only
 * as tested as its widest profile:
 *
 *   - two layers, and a control emitting a different message on each (spec 4.3);
 *   - a binding on layer `*`, which the MiniLab 3 never uses;
 *   - a `control-surface` port ranked ABOVE a performance port, so that role and
 *     priority cannot be mistaken for one another;
 *   - a catch-all port declaration, whose whole job is to refuse rather than to
 *     guess;
 *   - a control with no binding at all, which is a normal, honest result
 *     (spec 5.1) and the only thing that makes `completeness.untested` a counter
 *     rather than a constant;
 *   - `mode: relative` with an encoding, and a `cc14` pair -- both declarable,
 *     neither interpreted by the decoder today. The corpus records that as a
 *     refusal, out loud, rather than leaving it to be discovered by whoever
 *     plugs in the first encoder.
 *
 * THIS FILE SHIPS NOTHING. The plan's constraint is exactly one profile in
 * `src/`; a fixture in `test/` is what proves the machinery without claiming to
 * describe hardware nobody here has measured.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { parseMidiMessage } from '../src/renderer/js/midi/parseMidi.js';
import { decodeControl } from '../src/renderer/js/midi/decodeControl.js';
import { resolvePortRole, isPerformancePort, bestPerformancePort } from '../src/renderer/js/midi/portRoles.js';
import { validateControllerProfile, computeCompleteness } from '../src/renderer/js/midi/controllerProfile.js';

const readJson = (name) => JSON.parse(fs.readFileSync(new URL(`./conformance/${name}`, import.meta.url), 'utf8'));

// Read as files arriving from elsewhere rather than imported as modules: a
// profile that is not the one shipping with the application is untrusted data,
// and this is the road it travels (DECISIONS.md D-020).
const vega = readJson('vega-49.json');
const vegaCorpus = readJson('vega-49-corpus.json');
const miniLab = readJson('../../src/renderer/js/midi/profiles/minilab-3.json');
const miniLabCorpus = readJson('midi-corpus.json');

const decodeCase = (profile, entry) => {
  const parsed = parseMidiMessage(entry.bytes);
  return parsed ? decodeControl(profile, { ...parsed, sourceName: entry.sourceName }) : null;
};

/** The corpus records the profile's answer, so the test speaks the profile's language too. */
const asRecorded = (hit) => {
  if (!hit) return null;
  const recorded = {
    controlId: hit.control.id,
    bindingIndex: hit.control.bindings.indexOf(hit.binding),
    normalizedValue: hit.normalizedValue,
    rawValue: hit.rawValue
  };
  if ('phase' in hit) recorded.phase = hit.phase;
  if ('note' in hit) recorded.note = hit.note;
  if ('bipolarValue' in hit) recorded.bipolarValue = hit.bipolarValue;
  return recorded;
};

// ---- the format ---------------------------------------------------------------

test('the format validates a device it was not written for', () => {
  const result = validateControllerProfile(vega);
  assert.deepEqual(result.errors, [], 'a fixture that does not validate proves nothing about the format');
  assert.equal(result.ok, true);
  assert.deepEqual(computeCompleteness(vega), vega.completeness,
    'completeness is computed, never typed in: a profile does not get to grade itself');
});

test('the fixture shares nothing with the profile that ships, except one CC on purpose', () => {
  const vegaIds = new Set(vega.controls.map((control) => control.id));
  for (const control of miniLab.controls) {
    assert.equal(vegaIds.has(control.id), false, `both profiles declare the control id '${control.id}'`);
  }
  const vegaPorts = new Set(vega.device.ports.map((port) => port.match.name));
  for (const port of miniLab.device.ports) {
    assert.equal(vegaPorts.has(port.match.name), false, `both profiles declare the port '${port.match.name}'`);
  }
  assert.notDeepEqual(vega.device.layout, miniLab.device.layout);
  assert.notEqual(vega.profileId, miniLab.profileId);

  // The one deliberate collision. Without it, "the profile decides" would only
  // be checked where the two profiles could not have collided anyway.
  const cc74 = (profile) => profile.controls.find((control) => control.bindings
    .some((binding) => binding.when.kind === 'cc' && binding.when.number === 74));
  assert.equal(cc74(vega).id, 'dial-one');
  assert.equal(cc74(miniLab).id, 'k1');
});

// ---- ports --------------------------------------------------------------------

test('the port to arm is chosen by role first, and only then by rank', () => {
  const ports = [
    { id: 'a', name: 'Vega49 Thru' },
    { id: 'b', name: 'Vega49 Mix' },
    { id: 'c', name: 'Vega49 Aux' },
    { id: 'd', name: 'Vega49 Keys' }
  ];
  assert.equal(bestPerformancePort(vega, ports).id, 'd');
  assert.equal(resolvePortRole(vega, 'Vega49 Mix').priority > resolvePortRole(vega, 'Vega49 Aux').priority, true,
    'the fixture is only worth its salt while the control surface outranks a performance port');
  assert.equal(bestPerformancePort(vega, [ports[0], ports[1]]), null,
    'a machine enumerating only a mixer and a pass-through has no port to arm');
  assert.equal(bestPerformancePort(vega, [ports[2]]).id, 'c');
});

test('a port the profile does not name falls to its catch-all rather than to a resemblance', () => {
  assert.equal(resolvePortRole(vega, 'Vega49 Keys').role, 'performance', 'the longer declaration wins');
  assert.equal(resolvePortRole(vega, 'Vega49 Pedal 1').role, 'ignore');
  assert.equal(isPerformancePort(vega, 'Vega49 Pedal 1'), false);
  assert.equal(resolvePortRole(vega, 'MIDIIN3 (Vega49 Keys)').role, 'performance',
    'the operating system decorates, and decoration does not change what a port is');
});

test('neither profile recognises the other device ports', () => {
  for (const port of vega.device.ports) {
    assert.equal(resolvePortRole(miniLab, port.match.name), null, `the MiniLab claimed '${port.match.name}'`);
  }
  for (const port of miniLab.device.ports) {
    assert.equal(resolvePortRole(vega, port.match.name), null, `the fixture claimed '${port.match.name}'`);
  }
});

// ---- the corpus ---------------------------------------------------------------

test('the fixture corpus holds cases, and every case is complete', () => {
  assert.ok(vegaCorpus.cases.length >= 25, `the corpus shrank to ${vegaCorpus.cases.length} cases`);
  const ids = new Set();
  for (const entry of vegaCorpus.cases) {
    assert.ok(entry.id && !ids.has(entry.id), `duplicate or missing case id: ${entry.id}`);
    ids.add(entry.id);
    assert.ok(entry.why, `case ${entry.id} does not say what it is for`);
    assert.ok(Array.isArray(entry.bytes) && entry.bytes.length > 0, `case ${entry.id} has no bytes`);
    assert.ok('parsed' in entry && 'expect' in entry, `case ${entry.id} has no expectation`);
  }
});

test('parseMidi turns every recorded byte stream of the fixture into the recorded message', () => {
  for (const entry of vegaCorpus.cases) {
    assert.deepEqual(parseMidiMessage(entry.bytes), entry.parsed, `case ${entry.id}: ${entry.why}`);
  }
});

test('the decoder answers the fixture corpus case for case', () => {
  for (const entry of vegaCorpus.cases) {
    if (entry.expect === null) continue;
    assert.deepEqual(asRecorded(decodeCase(vega, entry)), entry.expect, `case ${entry.id}: ${entry.why}`);
  }
});

test('the decoder returns the profile answer and nothing else, on every fixture case', () => {
  for (const entry of vegaCorpus.cases) {
    const hit = decodeCase(vega, entry);
    if (!hit) continue;
    const extras = Object.keys(entry.expect).filter((key) => ['phase', 'note', 'bipolarValue'].includes(key));
    assert.deepEqual(Object.keys(hit).sort(),
      ['binding', 'control', 'normalizedValue', 'rawValue', ...extras].sort(),
      `case ${entry.id} carries a field the corpus does not record`);
  }
});

test('the fixture corpus refuses as much as it accepts', () => {
  const refusals = vegaCorpus.cases.filter((entry) => entry.expect === null);
  assert.ok(refusals.length >= 10, 'a corpus with no refusals only proves the easy half');
  for (const entry of refusals) {
    assert.equal(decodeCase(vega, entry), null, `case ${entry.id}: ${entry.why}`);
  }
});

/**
 * Coverage, with its two holes named rather than left to be noticed.
 *
 * `macro` declares a `cc14` pair and `wheel-two` declares nothing at all, so
 * neither can appear as a decode. Listing them here is what makes the day
 * someone implements 14-bit decoding a test failure instead of a silent
 * improvement.
 */
test('every control the decoder can reach appears in the fixture corpus', () => {
  const undecodable = new Set(['macro', 'wheel-two']);
  const covered = new Set(vegaCorpus.cases.map((entry) => entry.expect?.controlId).filter(Boolean));
  for (const control of vega.controls) {
    if (undecodable.has(control.id)) {
      assert.equal(covered.has(control.id), false,
        `${control.id} decodes now; the corpus and this list have to say so`);
      continue;
    }
    assert.ok(covered.has(control.id), `no corpus case decodes to ${control.id}`);
  }
  assert.equal(vega.controls.filter((control) => undecodable.has(control.id)).length, undecodable.size,
    'the fixture lost a control this test was watching');
});

// ---- the two corpora do not touch ---------------------------------------------

test('the same message is a different control under each profile', () => {
  const cc74 = { type: 'cc', channel: 1, controller: 74, value: 64 };
  assert.equal(decodeControl(vega, { ...cc74, sourceName: 'Vega49 Keys' }).control.id, 'dial-one');
  assert.equal(decodeControl(miniLab, { ...cc74, sourceName: 'Minilab3 MIDI' }).control.id, 'k1');
  assert.equal(decodeControl(vega, { ...cc74, sourceName: 'Minilab3 MIDI' }), null);
  assert.equal(decodeControl(miniLab, { ...cc74, sourceName: 'Vega49 Keys' }), null);
});

/**
 * Interleaved on purpose. The decoder caches a lookup table per profile, and the
 * failure mode of a cache keyed on anything coarser is that the second profile
 * is answered with the first one's controls -- which no single-profile run can
 * see, however many cases it holds.
 */
test('running the fixture corpus leaves the MiniLab corpus decoding exactly as before', () => {
  const miniLabCases = miniLabCorpus.cases.filter((entry) => entry.expect !== null);
  const vegaCases = vegaCorpus.cases.filter((entry) => entry.expect !== null);
  assert.ok(miniLabCases.length > 0 && vegaCases.length > 0);

  for (let index = 0; index < Math.max(miniLabCases.length, vegaCases.length); index += 1) {
    const vegaEntry = vegaCases[index % vegaCases.length];
    assert.deepEqual(asRecorded(decodeCase(vega, vegaEntry)), vegaEntry.expect, `fixture case ${vegaEntry.id}`);

    const miniLabEntry = miniLabCases[index % miniLabCases.length];
    const hit = decodeCase(miniLab, miniLabEntry);
    assert.equal(hit.control.id, miniLabEntry.expect.sourceControlId.split(':')[1], `case ${miniLabEntry.id}`);
    assert.equal(hit.normalizedValue, miniLabEntry.expect.normalizedValue, `case ${miniLabEntry.id}`);
  }
});
