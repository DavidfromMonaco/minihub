/**
 * The reference profile, and the 25 control sources it now produces.
 *
 * MINIHUB_CONTROLLER_PLATFORM_SPEC.md section 4.1 states the only acceptance
 * criterion the format has: a format that cannot describe the reference
 * controller is wrong. So the test is a comparison, not an opinion.
 *
 * What it compares against is `test/conformance/control-sources.json`, a frozen
 * recording of the 25 sources as `midi/minilabControls.js` declared them before
 * the profile replaced its literal. Comparing the derivation against the profile
 * it derives from would prove nothing; comparing it against what the application
 * used to say proves the thing that matters, and keeps proving it through every
 * later step of the plan.
 *
 * Section 3.3 is the other half: every identity a project has already written to
 * disk stays the same word. That is why the profile is called minilab-3 and not
 * arturia.minilab3 — and why those identities are asserted here one by one
 * rather than left to the comparison above to imply.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MINILAB_CONTROL_SOURCES, decodeMiniLabControl } from '../src/renderer/js/midi/minilabControls.js';
import { MINILAB_NODE_ID } from '../src/renderer/js/core/systemNodes.js';
import { MINILAB_SURFACE_LAYOUT } from '../src/renderer/js/ui/miniLabControlSurface.js';
import { computeCompleteness, validateControllerProfile } from '../src/renderer/js/midi/controllerProfile.js';

const readJson = (relative) => JSON.parse(fs.readFileSync(new URL(relative, import.meta.url), 'utf8'));

const profile = readJson('../src/renderer/js/midi/profiles/minilab-3.json');
const frozen = readJson('./conformance/control-sources.json');

test('the reference profile is a valid profile', () => {
  const result = validateControllerProfile(profile);
  assert.deepEqual(result.errors, []);
});

test('the profile produces the 25 control sources, field for field', () => {
  assert.equal(frozen.sources.length, 25, 'the MiniLab 3 has 25 control sources');
  assert.deepEqual(MINILAB_CONTROL_SOURCES.map((source) => ({ ...source })), frozen.sources);
});

/**
 * Specification section 3.3. Each of these strings is written inside saved
 * projects: a port id sits in every cable, a source id in every learned knob,
 * the node id in the network layout. A profile that changed one of them would
 * cut those projects silently.
 */
test('no identity a project has already written to disk moves', () => {
  assert.equal(profile.profileId, MINILAB_NODE_ID,
    'the profile id and the network node id are the same string, or the node stops matching');

  const byKey = (key) => profile.controls.find((control) => control.id === key);
  for (const key of ['k1', 'f2', 'p3', 'pitch-bend', 'main-encoder', 'main-click', 'shift', 'modulation']) {
    assert.ok(byKey(key), `the control '${key}' no longer exists under that id`);
  }

  const k1 = MINILAB_CONTROL_SOURCES.find((source) => source.key === 'k1');
  assert.equal(k1.portId, 'control-k1', 'port ids are derived, and unchanged');
  assert.equal(k1.id, 'minilab-3:k1', 'binding keys are derived, and unchanged');

  const declared = new Set(profile.controls.map((control) => control.id));
  for (const source of frozen.sources) {
    assert.ok(declared.has(source.key), `${source.key} disappeared from the profile`);
  }
});

test('the profile carries the layout the surface draws today', () => {
  const positionOf = (key) => {
    for (const group of ['knobs', 'faders', 'pads']) {
      const hit = MINILAB_SURFACE_LAYOUT[group].find((item) => item.key === key);
      if (hit) return { x: hit.x, y: hit.y };
    }
    return null;
  };
  for (const control of profile.controls) {
    const drawn = positionOf(control.id);
    if (!drawn) continue; // shift, the strips and the encoder are placed one by one, step 6
    assert.deepEqual(control.layout, drawn, `${control.id} would move on screen`);
  }
  const encoder = profile.controls.find((control) => control.id === 'main-encoder');
  assert.deepEqual(encoder.layout, { x: 122, y: 68 });
});

test('the profile grades itself as complete, and is right', () => {
  assert.deepEqual(profile.completeness, { declared: 25, observed: 25, inferred: 0, untested: 0 });
  assert.deepEqual(computeCompleteness(profile), profile.completeness);
});

/**
 * A channel written into a profile is a channel the decoder matches on. So the
 * profile declares one exactly where the decoding has always enforced one — the
 * pads, on channel 10 — and nowhere else. Anywhere else it would silently break
 * a keyboard whose global channel has been moved, which is a setting the author
 * has never used and most owners never touch.
 */
test('a channel is declared only where the decoding depends on it', () => {
  for (const control of profile.controls) {
    for (const binding of control.bindings) {
      if (binding.when.kind === 'note') {
        assert.equal(binding.when.channel, 10, `${control.id} sends its notes on the pad channel`);
      } else {
        assert.equal(binding.when.channel, undefined,
          `${control.id} would stop answering if the keyboard changed global channel`);
      }
    }
  }
});

test('that rule is what the decoding does, not just what the file says', () => {
  const onPerformancePort = { sourceName: 'Minilab3 MIDI' };
  const knobOnAnotherChannel = decodeMiniLabControl({
    ...onPerformancePort, type: 'cc', channel: 16, controller: 74, value: 64
  });
  assert.equal(knobOnAnotherChannel?.sourceControlId, 'minilab-3:k1', 'K1 is K1 on any channel');

  const padOnItsChannel = decodeMiniLabControl({
    ...onPerformancePort, type: 'noteon', channel: 10, note: 36, velocity: 96
  });
  assert.equal(padOnItsChannel?.sourceControlId, 'minilab-3:p1');

  const playedKey = decodeMiniLabControl({
    ...onPerformancePort, type: 'noteon', channel: 1, note: 36, velocity: 96
  });
  assert.equal(playedKey, null, 'the same note played on the keys is music, not a pad');
});

/**
 * Specification section 3.4: the profile has to say what it does not know. The
 * message each control sends out of the box was observed; the alternates the old
 * literal carried came with no record of where they were read, so they claim no
 * more than "inferred".
 */
test('every control declares one observed message, and hedges the rest', () => {
  for (const control of profile.controls) {
    const observed = control.bindings.filter((binding) => binding.confidence === 'observed');
    assert.equal(observed.length, 1, `${control.id} should stand on exactly one observed message`);
    assert.equal(control.bindings[0].confidence, 'observed', `${control.id} does not lead with what was observed`);
    for (const binding of control.bindings.slice(1)) {
      assert.equal(binding.confidence, 'inferred', `${control.id} presents a guess as something better`);
    }
  }
});
