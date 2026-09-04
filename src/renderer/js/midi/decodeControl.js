/**
 * One parsed MIDI message, against one profile: which control answered, and
 * with what value.
 *
 * WHY THIS FILE IS PART OF THE SHARED ARTEFACT
 * --------------------------------------------
 * MINIHUB_CONTROLLER_PLATFORM_SPEC.md section 3.5. MiniHub and the site Builder
 * have to agree on three things: the schema, the decoding of a message into a
 * control, and the inference of semantics. This is the second of the three, and
 * until now it lived inside `minilabControls.js` -- welded to one device's node
 * id, one device's port ids and one device's name, which made it unshareable and
 * left specification 3.5 owed.
 *
 * It is shareable now because of what it does NOT return. There is no
 * `sourceNodeId` here, no `control-<id>` port id, no `semantics` string: those
 * are MiniHub's names for the thing that answered, not the decoding of the
 * message. What comes back is the profile's own control and the profile's own
 * binding, plus the numbers. Whoever calls it names the result in its own
 * vocabulary -- `minilabControls.js` does exactly that, in nine lines.
 *
 * The artefact is a SET of files, not one: this one, `controllerProfile.js`
 * (the schema), `portRoles.js` (which port may speak) and `parseMidi.js` (bytes
 * to message). They import each other and nothing else, so the set travels as a
 * unit. `test/conformance/midi-corpus.json` is the only proof that the two
 * copies still agree, and it is frozen for that reason.
 *
 * WHY THE INDEX IS CACHED
 * -----------------------
 * A `kind:number` lookup table has to be derived from the profile before any
 * message can be answered. Deriving it per message would rebuild twenty-five
 * controls' worth of Map entries for every knob tick, and a knob sweep is a
 * hundred messages a second. The cache is a WeakMap on the profile object, so a
 * profile that is dropped takes its index with it, and two profiles never share
 * one table.
 */
import { isPerformancePort } from './portRoles.js';

/**
 * Which profile `kind` a parsed message can answer to.
 *
 * A pad's three phases -- struck, released, leaned on -- are one control and one
 * binding, distinguished in the result by `phase` rather than by three
 * declarations. That is why `polyaftertouch` maps to `note` here: the profile
 * kind of the same name exists for a device that would use aftertouch as a
 * control in its own right, which the MiniLab 3 does not.
 *
 * `channelpressure` is the opposite case, and maps to itself: it carries no note
 * and no controller number, so it cannot be a phase of anything. A keyboard
 * sending one pressure stream for the whole keybed is declaring one control, and
 * a profile says so with one binding carrying no `number` at all.
 */
const KIND_BY_MESSAGE_TYPE = Object.freeze({
  cc: 'cc',
  pitchbend: 'pitchbend',
  channelpressure: 'channelpressure',
  noteon: 'note',
  noteoff: 'note',
  polyaftertouch: 'note'
});

const INDEXES = new WeakMap();

/**
 * `kind:number` -> the controls that answer it, in profile order.
 *
 * A binding with no channel answers on any channel, which is what a controller
 * does for everything but, typically, its pads: move the keyboard's global
 * channel and K1 is still K1. The validator refuses two bindings that could both
 * answer one message, so the first match is the only match -- and a profile that
 * never went through the validator gets source order, which is the same answer
 * the validator would have made it earn.
 */
function indexFor(profile) {
  const cached = INDEXES.get(profile);
  if (cached) return cached;
  const index = new Map();
  for (const control of profile?.controls ?? []) {
    for (const binding of control?.bindings ?? []) {
      const key = `${binding?.when?.kind}:${binding?.when?.number ?? '-'}`;
      const answers = index.get(key) ?? [];
      answers.push({ control, binding });
      index.set(key, answers);
    }
  }
  if (profile && typeof profile === 'object') INDEXES.set(profile, index);
  return index;
}

function answering(index, kind, number, channel) {
  const answers = index.get(`${kind}:${number ?? '-'}`);
  if (!answers) return null;
  return answers.find(({ binding }) => {
    const declared = binding?.when?.channel;
    return declared === undefined || declared === channel;
  }) ?? null;
}

/**
 * `rawValue` is the byte the message actually carried, whatever it is called in
 * that message: a controller value, a velocity, a bend. It is reported
 * unchanged even where the normalised value ignores it -- a released pad
 * normalises to 0 while its release-velocity byte says 64, and both facts are
 * true.
 */
const rawOf = (msg) => msg.value ?? msg.velocity ?? msg.bend;

/**
 * What a message of this kind carries when the control is at its maximum.
 *
 * The wire format's span, not the device's -- and only the fallback: it is what
 * a binding declaring no `range` is normalised against, which is most of them.
 */
const FULL_SPAN = Object.freeze({ cc: 127, note: 127, channelpressure: 127, pitchbend: 16383 });

/**
 * One raw value against the travel its binding declares, as 0..1.
 *
 * `range` was written and validated when the profile format landed, and read by
 * nobody: a field an author could fill in correctly and watch do nothing. A
 * breath input declared [16, 112] reported four fifths of the way up at full
 * blow, and no error anywhere said so.
 *
 * Clamped, because `range` describes a control rather than promising anything
 * about it -- a pedal declared [16, 112] that sends 120 once is a real pedal, and
 * a consumer handed 1.08 for a VST parameter has no rule for it. A malformed
 * range falls back to the full span instead of returning NaN: the built-in
 * profile ships WITHOUT passing the validator (see `minilabControls.js`), so
 * this function is not entitled to assume one ever ran.
 */
function normalize(binding, kind, value) {
  const range = binding?.range;
  const declared = Array.isArray(range) && range.length === 2
    && Number.isFinite(range[0]) && Number.isFinite(range[1]) && range[1] > range[0];
  const low = declared ? range[0] : 0;
  const high = declared ? range[1] : FULL_SPAN[kind];
  return Math.min(1, Math.max(0, (value - low) / (high - low)));
}

/**
 * Decode one parsed message against one profile.
 *
 * Returns null for everything that is not a control of this profile, and the
 * refusals are the point rather than the leftovers: a message from a port that
 * cannot carry a note, a message from another device, a kind no control
 * declares, an undeclared CC, a note on a channel the declaration does not
 * name. Each of them is a case in the conformance corpus, because "decodes to
 * nothing" is as much a shared answer as "decodes to K1".
 */
export function decodeControl(profile, msg) {
  if (!msg || !isPerformancePort(profile, msg.sourceName)) return null;
  const kind = KIND_BY_MESSAGE_TYPE[msg.type];
  if (!kind) return null;
  const index = indexFor(profile);

  if (kind === 'pitchbend') {
    if (!Number.isInteger(msg.bend) || msg.bend < 0 || msg.bend > 16383) return null;
    const hit = answering(index, 'pitchbend', undefined, msg.channel);
    if (!hit) return null;
    return {
      ...hit,
      normalizedValue: normalize(hit.binding, 'pitchbend', msg.bend),
      rawValue: rawOf(msg),
      // Deliberately NOT rescaled by `range`: 8192 is the centre of the wire
      // format, which is where the wheel springs back to, whatever travel the
      // device declares around it. Recentring on the declared midpoint would
      // move "released" off zero for every asymmetric bender.
      bipolarValue: Math.max(-1, (msg.bend - 8192) / 8191)
    };
  }

  if (kind === 'cc') {
    if (!Number.isInteger(msg.value) || msg.value < 0 || msg.value > 127) return null;
    const hit = answering(index, 'cc', msg.controller, msg.channel);
    if (!hit) return null;
    return { ...hit, normalizedValue: normalize(hit.binding, 'cc', msg.value), rawValue: rawOf(msg) };
  }

  // Number-less, like a pitch bend: one stream for the whole keybed, so the
  // binding that answers is found by kind and channel alone.
  if (kind === 'channelpressure') {
    if (!Number.isInteger(msg.value) || msg.value < 0 || msg.value > 127) return null;
    const hit = answering(index, 'channelpressure', undefined, msg.channel);
    if (!hit) return null;
    return {
      ...hit,
      normalizedValue: normalize(hit.binding, 'channelpressure', msg.value),
      rawValue: rawOf(msg)
    };
  }

  if (!Number.isInteger(msg.note)) return null;
  const hit = answering(index, 'note', msg.note, msg.channel);
  if (!hit) return null;
  // A Note Off is a release, whatever velocity it was released with.
  const level = msg.type === 'noteoff' ? 0 : (msg.velocity ?? msg.value);
  if (!Number.isInteger(level) || level < 0 || level > 127) return null;
  return {
    ...hit,
    normalizedValue: normalize(hit.binding, 'note', level),
    rawValue: rawOf(msg),
    phase: msg.type,
    note: msg.note
  };
}
