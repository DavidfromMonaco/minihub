/**
 * The conformance corpus, run against the code that has to agree with it.
 *
 * MINIHUB_CONTROLLER_PLATFORM_SPEC.md section 3.5: MiniHub and the site Builder
 * decode the same MIDI, from two copies of the same files. Nothing stops the two
 * copies drifting except a body of recorded messages with their expected result,
 * which both sides run. test/conformance/midi-corpus.json is that body; this file
 * is MiniHub's side of it.
 *
 * It is also the "before" of the workstream that follows. The profile-driven
 * decoder of step 4 has to reproduce this file case for case -- which is why the
 * expectations were derived from the control declaration and the documented
 * normalisation rules rather than from a run of the decoder, and then frozen.
 * Regenerating the corpus to make it pass would be exactly the mistake it exists
 * to catch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseMidiMessage } from '../src/renderer/js/midi/parseMidi.js';
import { MINILAB_CONTROL_SOURCES, decodeMiniLabControl } from '../src/renderer/js/midi/minilabControls.js';

const corpus = JSON.parse(
  fs.readFileSync(new URL('./conformance/midi-corpus.json', import.meta.url), 'utf8')
);

const decodeCase = (entry) => {
  const parsed = parseMidiMessage(entry.bytes);
  if (!parsed) return { parsed: null, decoded: null };
  return { parsed, decoded: decodeMiniLabControl({ ...parsed, sourceName: entry.sourceName }) };
};

test('the corpus holds cases, and every case is complete', () => {
  assert.ok(corpus.cases.length >= 90, `the corpus shrank to ${corpus.cases.length} cases`);
  const ids = new Set();
  for (const entry of corpus.cases) {
    assert.ok(entry.id && !ids.has(entry.id), `duplicate or missing case id: ${entry.id}`);
    ids.add(entry.id);
    assert.ok(entry.why, `case ${entry.id} does not say what it is for`);
    assert.ok(Array.isArray(entry.bytes) && entry.bytes.length > 0, `case ${entry.id} has no bytes`);
    assert.ok('parsed' in entry && 'expect' in entry, `case ${entry.id} has no expectation`);
  }
});

test('parseMidi turns every recorded byte stream into the recorded message', () => {
  for (const entry of corpus.cases) {
    assert.deepEqual(parseMidiMessage(entry.bytes), entry.parsed, `case ${entry.id}: ${entry.why}`);
  }
});

test('the decoder turns every recorded message into the recorded control', () => {
  for (const entry of corpus.cases) {
    if (entry.expect === null) continue;
    const { decoded } = decodeCase(entry);
    assert.deepEqual(decoded, entry.expect, `case ${entry.id}: ${entry.why}`);
  }
});

test('the decoder refuses everything the corpus records as a refusal', () => {
  const refusals = corpus.cases.filter((entry) => entry.expect === null);
  assert.ok(refusals.length >= 10, 'a corpus with no refusals only proves the easy half');
  for (const entry of refusals) {
    const { decoded } = decodeCase(entry);
    assert.equal(decoded, null, `case ${entry.id}: ${entry.why}`);
  }
});

/**
 * The corpus is only a proof while it still covers the hardware. A control added
 * to the declaration and forgotten here would leave the next decoder free to get
 * it wrong, silently -- so coverage is asserted rather than assumed.
 */
test('every declared control, CC and pad note appears in the corpus', () => {
  const covered = new Set(corpus.cases.map((entry) => entry.expect?.sourceControlId).filter(Boolean));
  for (const control of MINILAB_CONTROL_SOURCES) {
    assert.ok(covered.has(control.id), `no corpus case decodes to ${control.id}`);
  }

  const recordedCcs = new Set(
    corpus.cases.filter((entry) => entry.expect && entry.parsed?.type === 'cc')
      .map((entry) => entry.parsed.controller)
  );
  const recordedNotes = new Set(
    corpus.cases.filter((entry) => entry.expect && Number.isInteger(entry.parsed?.note))
      .map((entry) => entry.parsed.note)
  );
  for (const control of MINILAB_CONTROL_SOURCES) {
    for (const cc of control.ccs || []) {
      assert.ok(recordedCcs.has(cc), `CC ${cc} of ${control.id} is declared but never recorded`);
    }
    for (const note of control.notes || []) {
      assert.ok(recordedNotes.has(note), `note ${note} of ${control.id} is declared but never recorded`);
    }
  }
});
