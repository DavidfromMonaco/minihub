/**
 * The profile format's validator, tested by what it must refuse.
 *
 * DECISIONS.md D-020 draws one boundary -- "extensible by data, never by code" --
 * and MINIHUB_CONTROLLER_PLATFORM_SPEC.md section 9 turns it into commands. A
 * profile file is the one thing in MiniHub that may arrive from a stranger, so
 * the interesting tests here are the rejections, and the interesting property is
 * that a rejection names its field.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTROLLER_PROFILE_FORMAT_VERSION,
  computeCompleteness,
  validateControllerProfile
} from '../src/renderer/js/midi/controllerProfile.js';

/** A profile that is entirely ordinary, so each test can spoil exactly one thing. */
const profile = () => ({
  formatVersion: CONTROLLER_PROFILE_FORMAT_VERSION,
  profileId: 'test-controller',
  revision: 1,
  name: 'Test Controller',
  author: '',
  createdAt: '2026-09-04',
  completeness: { declared: 2, observed: 1, inferred: 1, untested: 0 },
  device: {
    vendor: 'Test',
    model: 'One',
    layout: { width: 480, height: 180 },
    ports: [
      { role: 'performance', priority: 5, match: { name: 'Test One MIDI' } },
      { role: 'control-surface', priority: 1, match: { name: 'Test One MCU' }, note: 'never carries played notes' }
    ]
  },
  layers: [
    { id: 'default', label: 'Default' },
    { id: 'daw', label: 'DAW' }
  ],
  controls: [
    {
      id: 'k1',
      label: 'K1',
      family: 'knob',
      layout: { x: 155, y: 43 },
      bindings: [
        { layer: 'default', when: { kind: 'cc', channel: 1, number: 74 }, mode: 'absolute', range: [0, 127], confidence: 'observed' }
      ]
    },
    {
      id: 'main-encoder',
      label: 'Main',
      family: 'encoder',
      layout: { x: 122, y: 68 },
      bindings: [
        { layer: 'daw', when: { kind: 'cc', channel: 1, number: 28 }, mode: 'relative', encoding: 'twos-complement', confidence: 'inferred' }
      ]
    }
  ]
});

/** Apply one mutation to an otherwise valid profile and validate the result. */
function spoil(mutate) {
  const value = profile();
  mutate(value);
  return validateControllerProfile(value);
}

const paths = (result) => result.errors.map((error) => error.path);

function assertRefused(result, path, message) {
  assert.equal(result.ok, false, message);
  assert.ok(paths(result).includes(path), `${message}\nexpected an error on ${path}, got ${paths(result).join(', ') || 'none'}`);
}

test('an ordinary profile passes, with no error at all', () => {
  const result = validateControllerProfile(profile());
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test('a profile from a format version this build does not read is refused', () => {
  assertRefused(spoil((p) => { p.formatVersion = CONTROLLER_PROFILE_FORMAT_VERSION + 1; }),
    'profile.formatVersion', 'a newer format read under this one is silent data loss');
  assertRefused(spoil((p) => { delete p.formatVersion; }), 'profile.formatVersion', 'no version is not version 1');
});

test('what is not an object is refused without throwing', () => {
  for (const value of [null, undefined, 3, 'profile', [], true]) {
    const result = validateControllerProfile(value);
    assert.equal(result.ok, false, `${JSON.stringify(value) ?? 'undefined'} was accepted`);
    assert.ok(result.errors.length > 0);
  }
});

/**
 * The list D-020 names: a function, a script, a command, a system path, a DLL,
 * an executable URL, a callback. Each one placed in a field that legitimately
 * holds free text, because that is where it would actually arrive.
 */
test('a malicious profile is refused field by field', () => {
  assertRefused(spoil((p) => { p.controls[0].bindings[0].when.number = () => 74; }),
    'profile.controls[0].bindings[0].when.number', 'a function is not data');
  assertRefused(spoil((p) => { p.name = 'javascript:fetch("http://example.invalid")'; }),
    'profile.name', 'an executable URL scheme is not a name');
  assertRefused(spoil((p) => { p.author = 'https://example.invalid/collect'; }),
    'profile.author', 'a URL is not an author');
  assertRefused(spoil((p) => { p.device.vendor = 'C:\\Windows\\System32\\payload.dll'; }),
    'profile.device.vendor', 'a system path is not a vendor');
  assertRefused(spoil((p) => { p.device.ports[0].note = '../../etc/passwd'; }),
    'profile.device.ports[0].note', 'a path traversal is not a note');
  assertRefused(spoil((p) => { p.controls[0].label = '<script>steal()</script>'; }),
    'profile.controls[0].label', 'a script tag is not a label');
  assertRefused(spoil((p) => { p.layers[0].label = 'run me.exe'; }),
    'profile.layers[0].label', 'an executable is not a label');
  assertRefused(spoil((p) => { p.name = `Test${'x'.repeat(400)}`; }),
    'profile.name', 'an unbounded string is a cost the profile does not declare');
});

test('a key that reaches Object.prototype is refused, and pollutes nothing', () => {
  const result = validateControllerProfile(JSON.parse('{"formatVersion":1,"__proto__":{"polluted":true}}'));
  assert.equal(result.ok, false);
  assert.ok(paths(result).includes('profile.__proto__'));
  assert.equal({}.polluted, undefined, 'validating a hostile profile changed Object.prototype');
});

test('a field this format version does not have is refused, not ignored', () => {
  assertRefused(spoil((p) => { p.onLoad = 'doSomething'; }), 'profile.onLoad',
    'an unknown field is a typo or a newer format wearing this version number');
  assertRefused(spoil((p) => { p.controls[0].script = 'x'; }), 'profile.controls[0].script',
    'the same, one level down');
});

test('a profile nested past all reason is refused before the stack is', () => {
  const result = spoil((p) => {
    let deep = { name: 'bottom' };
    for (let level = 0; level < 12; level += 1) deep = { match: deep };
    p.device = deep;
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /nests deeper/.test(error.message)), 'depth was not the complaint');
});

/**
 * Specification section 3.2. A control id becomes a port id, and port ids are
 * persisted in every project's connections -- so the shape is narrow on purpose.
 */
test('an identifier that could not survive being a port id is refused', () => {
  for (const id of ['K1', 'k 1', 'minilab-3:k1', 'k1/', '-k1', 'k1-', '']) {
    assertRefused(spoil((p) => { p.controls[0].id = id; }), 'profile.controls[0].id',
      `the control id ${JSON.stringify(id)} was accepted`);
  }
  assertRefused(spoil((p) => { p.profileId = 'MiniLab_3'; }), 'profile.profileId',
    'a profile id becomes a node id');
});

test('a repeated identifier is refused', () => {
  assertRefused(spoil((p) => { p.controls[1].id = 'k1'; }), 'profile.controls[1].id',
    'two controls with one id means one of them is unreachable');
  assertRefused(spoil((p) => { p.layers[1].id = 'default'; }), 'profile.layers[1].id',
    'two layers with one id');
});

test('a binding on a layer the profile does not declare is refused', () => {
  assertRefused(spoil((p) => { p.controls[0].bindings[0].layer = 'shift'; }),
    'profile.controls[0].bindings[0].layer', 'a layer that exists nowhere');
});

test('a relative binding says how it encodes, and only a relative one may', () => {
  assertRefused(spoil((p) => { delete p.controls[1].bindings[0].encoding; }),
    'profile.controls[1].bindings[0].encoding', 'a relative encoder with no encoding is a guess');
  assertRefused(spoil((p) => { p.controls[1].bindings[0].encoding = 'rotary'; }),
    'profile.controls[1].bindings[0].encoding', 'an encoding nobody decodes');
  assertRefused(spoil((p) => { p.controls[0].bindings[0].encoding = 'offset-64'; }),
    'profile.controls[0].bindings[0].encoding', 'an absolute binding does not encode anything');
});

/**
 * An absent channel means "on any channel". It is the honest description of what
 * most continuous controllers do once their global channel is moved, and it is
 * what MiniHub has always done — so the format has to be able to say it, or
 * every profile would have to lie about a channel it does not actually match on.
 */
test('a binding with no channel answers on all of them', () => {
  const anyChannel = spoil((p) => { delete p.controls[0].bindings[0].when.channel; });
  assert.deepEqual(anyChannel.errors, [], 'a channel-less binding is legitimate');

  // ...which is exactly why it cannot share a message with a channelled one.
  const collision = spoil((p) => {
    delete p.controls[0].bindings[0].when.channel;
    p.controls[1].bindings[0] = {
      layer: 'default', when: { kind: 'cc', channel: 7, number: 74 }, mode: 'absolute', confidence: 'observed'
    };
    p.completeness = { declared: 2, observed: 2, inferred: 0, untested: 0 };
  });
  assert.equal(collision.ok, false, 'channel 7 falls inside "any channel"');
  assert.ok(collision.errors.some((error) => /answers the same message/.test(error.message)));

  // Two channelled bindings on one message are still fine when the channels differ.
  const distinct = spoil((p) => {
    p.controls[1].bindings[0] = {
      layer: 'default', when: { kind: 'cc', channel: 7, number: 74 }, mode: 'absolute', confidence: 'observed'
    };
    p.completeness = { declared: 2, observed: 2, inferred: 0, untested: 0 };
  });
  assert.deepEqual(distinct.errors, [], 'channel 1 and channel 7 are two different messages');
});

test('a message that cannot exist is refused', () => {
  assertRefused(spoil((p) => { p.controls[0].bindings[0].when.channel = 0; }),
    'profile.controls[0].bindings[0].when.channel', 'MIDI channels are 1 to 16 here');
  assertRefused(spoil((p) => { p.controls[0].bindings[0].when.channel = 17; }),
    'profile.controls[0].bindings[0].when.channel', 'MIDI channels are 1 to 16 here');
  assertRefused(spoil((p) => { p.controls[0].bindings[0].when.number = 128; }),
    'profile.controls[0].bindings[0].when.number', 'a CC number is 7 bits');
  assertRefused(spoil((p) => { p.controls[0].bindings[0].when.kind = 'sysex'; }),
    'profile.controls[0].bindings[0].when.kind', 'a kind the decoder has never heard of');
});

test('a 14-bit pair is one binding, and only it carries the second number', () => {
  const ok = spoil((p) => {
    p.controls[0].bindings[0].when = { kind: 'cc14', channel: 1, number: 74, lsbNumber: 106 };
  });
  assert.deepEqual(ok.errors, [], 'a cc14 binding is legitimate');

  assertRefused(spoil((p) => {
    p.controls[0].bindings[0].when = { kind: 'cc14', channel: 1, number: 74 };
  }), 'profile.controls[0].bindings[0].when.lsbNumber', 'a 14-bit pair with one number is not a pair');

  assertRefused(spoil((p) => { p.controls[0].bindings[0].when.lsbNumber = 106; }),
    'profile.controls[0].bindings[0].when.lsbNumber', 'a plain CC has no second number');
  assertRefused(spoil((p) => {
    p.controls[0].bindings[0].when = { kind: 'pitchbend', channel: 1, number: 0 };
  }), 'profile.controls[0].bindings[0].when.number', 'pitch bend carries no number');
});

/**
 * Two bindings answering one message on one layer would be arbitrated by source
 * order, which is to say by accident. Different layers are not a collision:
 * that is the whole point of layers.
 */
test('two bindings claiming the same message on the same layer are refused', () => {
  // The second control becomes observed rather than inferred, so the computed
  // completeness moves with it -- the validator would otherwise, rightly, report
  // that instead of the collision.
  const claimCc74 = (layer) => (p) => {
    p.controls[1].bindings[0] = {
      layer, when: { kind: 'cc', channel: 1, number: 74 }, mode: 'absolute', confidence: 'observed'
    };
    p.completeness = { declared: 2, observed: 2, inferred: 0, untested: 0 };
  };

  const collision = spoil(claimCc74('default'));
  assert.equal(collision.ok, false);
  assert.ok(collision.errors.some((error) => /answers the same message/.test(error.message)));

  const differentLayers = spoil(claimCc74('daw'));
  assert.deepEqual(differentLayers.errors, [], 'the same CC on two layers is what layers are for');

  const everyLayer = spoil(claimCc74('*'));
  assert.equal(everyLayer.ok, false, 'a binding on every layer collides with one on any layer');
});

test('a profile does not get to grade itself', () => {
  assertRefused(spoil((p) => { p.completeness.observed = 2; }), 'profile.completeness.observed',
    'completeness is computed, never typed in');
  assertRefused(spoil((p) => { p.completeness = { declared: 2, observed: 1, inferred: 1 }; }),
    'profile.completeness.untested', 'a missing counter is a wrong counter');
});

test('completeness ranks a control by its best binding', () => {
  assert.deepEqual(computeCompleteness(profile()),
    { declared: 2, observed: 1, inferred: 1, untested: 0, silent: 0 });

  const untested = profile();
  untested.controls[1].bindings = [];
  assert.deepEqual(computeCompleteness(untested),
    { declared: 2, observed: 1, inferred: 0, untested: 1, silent: 0 },
    'a control nobody ever saw move is untested');

  const promoted = profile();
  promoted.controls[1].bindings.push({
    layer: 'default', when: { kind: 'cc', channel: 1, number: 114 }, mode: 'absolute', confidence: 'observed'
  });
  assert.deepEqual(computeCompleteness(promoted),
    { declared: 2, observed: 2, inferred: 0, untested: 0, silent: 0 },
    'one observed binding is enough to stop calling a control a guess');

  // The distinction the fifth counter exists for. Both controls below have no
  // bindings; only one of them is missing a measurement.
  const silent = profile();
  silent.controls[1].bindings = [];
  silent.controls[1].silent = true;
  assert.deepEqual(computeCompleteness(silent),
    { declared: 2, observed: 1, inferred: 0, untested: 0, silent: 1 },
    'a control that sends nothing by design is not a control nobody has tested');
});

test('a control cannot both send nothing and send this', () => {
  const contradiction = profile();
  contradiction.controls[0].silent = true;
  const result = validateControllerProfile(contradiction);
  assert.equal(result.ok, false);
  const fault = result.errors.find((error) => error.path === 'profile.controls[0].silent');
  assert.ok(fault, 'the contradiction is reported where it can be fixed');
  assert.match(fault.message, /sends nothing.*1 binding/,
    'and the message names both halves, since either one could be the mistake');
});

test('silent is a boolean, not a truthy value', () => {
  for (const value of ['true', 1, {}, null]) {
    const spoiled = profile();
    spoiled.controls[0].silent = value;
    const result = validateControllerProfile(spoiled);
    assert.equal(result.ok, false, `${JSON.stringify(value)} was accepted as a boolean`);
  }
});

test('printed carries what the panel says, and is bound like every other string', () => {
  const ok = profile();
  ok.controls[0].printed = 'Arp';
  assert.equal(validateControllerProfile(ok).ok, true, 'a legend on a control is legal');

  const dangerous = profile();
  dangerous.controls[0].printed = 'C:/Windows/system32/evil.dll';
  assert.equal(validateControllerProfile(dangerous).ok, false,
    'a new string field must be swept like the others, not trusted because it is new');
});

test('every fault is reported, not just the first', () => {
  const result = spoil((p) => {
    p.formatVersion = 9;
    p.controls[0].id = 'K1';
    p.controls[1].bindings[0].confidence = 'certain';
    p.device.ports[0].role = 'input';
  });
  const reported = paths(result);
  for (const path of [
    'profile.formatVersion',
    'profile.controls[0].id',
    'profile.controls[1].bindings[0].confidence',
    'profile.device.ports[0].role'
  ]) {
    assert.ok(reported.includes(path), `${path} was swallowed: ${reported.join(', ')}`);
  }
});
