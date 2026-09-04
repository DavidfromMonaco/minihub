/**
 * The MiniLab 3's control surface, read from its profile.
 *
 * This file used to hold the 25 control sources as a JavaScript literal. That
 * literal WAS a profile -- ids, CC numbers, pad notes, port ids -- with the
 * hardware welded into the core, which INTENT.md section 5 calls a defect and
 * DECISIONS.md D-020 lifted the refusal on. It now derives them from
 * profiles/minilab-3.json, and derives nothing else: the exported shape, the
 * lookup helpers and the decoding are what they were.
 *
 * The built-in profile is NOT validated at startup. It ships with the
 * application and a test holds it against the format; paying for validation on
 * every launch would buy a guarantee that is already bought. A profile arriving
 * from anywhere else is a different matter, and validateControllerProfile() in
 * controllerProfile.js is what it goes through.
 */
import { isMiniLabName, isPerformanceInputName } from './minilab.js';
import { MINILAB_NODE_ID } from '../core/systemNodes.js';
import profile from './profiles/minilab-3.json' with { type: 'json' };

/**
 * The legacy `semantics` string, rebuilt from the set of modes a control's
 * bindings carry.
 *
 * It is a compatibility shim, and it is worth knowing that it shims nothing
 * mechanical: no code in src/ branches on `semantics`. Specification section 4.3
 * replaced this control-wide word with one `mode` per binding, precisely because
 * a control can mean different things on different layers. A mode set with no
 * legacy name falls back to the modes themselves rather than to a plausible
 * wrong answer.
 */
const SEMANTICS_BY_MODES = Object.freeze({
  absolute: 'continuous-absolute',
  bipolar: 'bipolar',
  momentary: 'momentary',
  toggle: 'momentary-or-toggle',
  'pressure,velocity': 'velocity-momentary-pressure'
});

function semanticsOf(control) {
  const modes = [...new Set(control.bindings.map((binding) => binding.mode))].sort().join(',');
  return SEMANTICS_BY_MODES[modes] ?? modes;
}

const numbersOfKind = (control, kind) => Object.freeze(
  control.bindings.filter((binding) => binding.when.kind === kind).map((binding) => binding.when.number)
);

/**
 * One profile control becomes one CONTROL source.
 *
 * Every derived string is an identity a saved project already contains -- the
 * port id sits in each cable, the source id in each learned binding -- so each
 * one is built by the rule specification section 3.3 fixed, and none of them is
 * free to change: `control-<controlId>` and `<profileId>:<controlId>`.
 */
function toControlSource(control) {
  const ccs = numbersOfKind(control, 'cc');
  const notes = numbersOfKind(control, 'note');
  const source = {
    id: `${profile.profileId}:${control.id}`,
    key: control.id,
    label: control.label,
    family: control.family,
    semantics: semanticsOf(control)
  };
  // `cc` is the control's primary message, and only where that message is a CC:
  // a pad leads with its note, and the pitch strip has no CC at all.
  if (control.bindings[0]?.when.kind === 'cc') source.cc = control.bindings[0].when.number;
  if (notes.length) source.notes = notes;
  if (ccs.length) source.ccs = ccs;
  source.portId = `control-${control.id}`;
  return Object.freeze(source);
}

/** Stable physical CONTROL identities; original MIDI is never consumed. */
export const MINILAB_CONTROL_SOURCES = Object.freeze(profile.controls.map(toControlSource));

/**
 * Where the controls sit, kept apart from what they send.
 *
 * `layout` is not on a control source because a source is an identity that gets
 * persisted and compared field for field; a coordinate is a drawing input that
 * changes when a faceplate is redrawn. Mixing them would make a repaint look
 * like a hardware change.
 *
 * `box` is the coordinate space those positions are expressed in -- the Patch Bay
 * scales it into a node, and the site's blueprint will use it as a viewBox.
 */
export const MINILAB_SURFACE_BOX = Object.freeze({ ...profile.device.layout });

const LAYOUT_BY_KEY = new Map(profile.controls.map((control) => [control.id, Object.freeze({ ...control.layout })]));

export function getMiniLabControlLayout(key) { return LAYOUT_BY_KEY.get(key) || null; }

const BY_ID = new Map(MINILAB_CONTROL_SOURCES.map((item) => [item.id, item]));
const BY_PORT = new Map(MINILAB_CONTROL_SOURCES.map((item) => [item.portId, item]));

export function getMiniLabControlSource(id) { return BY_ID.get(id) || null; }
export function getMiniLabControlSourceByPort(id) { return BY_PORT.get(id) || null; }

/**
 * Which profile `kind` a parsed message can answer to.
 *
 * A pad's three phases -- struck, released, leaned on -- are one control and one
 * binding, distinguished in the result by `phase` rather than by three
 * declarations. That is why `polyaftertouch` maps to `note` here: the profile
 * kind of the same name exists for a device that would use aftertouch as a
 * control in its own right, which the MiniLab 3 does not.
 */
const KIND_BY_MESSAGE_TYPE = Object.freeze({
  cc: 'cc',
  pitchbend: 'pitchbend',
  noteon: 'note',
  noteoff: 'note',
  polyaftertouch: 'note'
});

/**
 * `kind:number` -> the controls that answer it, in profile order.
 *
 * A binding with no channel answers on any channel, which is what the MiniLab 3
 * does for everything but its pads: move the keyboard's global channel and K1 is
 * still K1. The pads are the exception, and the only place a channel is written
 * down. The validator refuses two bindings that could both answer one message,
 * so the first match is the only match.
 */
const MATCHERS = new Map();
profile.controls.forEach((control, index) => {
  const source = MINILAB_CONTROL_SOURCES[index];
  for (const binding of control.bindings) {
    const key = `${binding.when.kind}:${binding.when.number ?? '-'}`;
    const answers = MATCHERS.get(key) ?? [];
    answers.push({ source, channel: binding.when.channel });
    MATCHERS.set(key, answers);
  }
});

function sourceAnswering(kind, number, channel) {
  const answers = MATCHERS.get(`${kind}:${number ?? '-'}`);
  if (!answers) return null;
  const hit = answers.find((entry) => entry.channel === undefined || entry.channel === channel);
  return hit ? hit.source : null;
}

function result(item, msg, normalizedValue, extra = {}) {
  return { type: 'control', sourceControlId: item.id, sourceNodeId: MINILAB_NODE_ID,
    sourcePortId: item.portId, label: item.label, semantics: item.semantics,
    normalizedValue, rawValue: msg.value ?? msg.velocity ?? msg.bend, ...extra };
}

/**
 * Additively project one documented physical message into CONTROL.
 *
 * Additively is the invariant, not the adverb: a message that becomes a control
 * is never taken off its MIDI path. A note played on the keys stays music, and
 * K1 keeps sending CC 74 while it also drives a VST parameter. Specification
 * section 6.7, and `controlRouting.test.mjs` is what holds it.
 */
export function decodeMiniLabControl(msg) {
  if (!msg || !isMiniLabName(msg.sourceName) || !isPerformanceInputName(msg.sourceName)) return null;
  const kind = KIND_BY_MESSAGE_TYPE[msg.type];
  if (!kind) return null;

  if (kind === 'pitchbend') {
    if (!Number.isInteger(msg.bend) || msg.bend < 0 || msg.bend > 16383) return null;
    const item = sourceAnswering('pitchbend', undefined, msg.channel);
    if (!item) return null;
    return result(item, msg, msg.bend / 16383, { bipolarValue: Math.max(-1, (msg.bend - 8192) / 8191) });
  }

  if (kind === 'cc') {
    if (!Number.isInteger(msg.value) || msg.value < 0 || msg.value > 127) return null;
    const item = sourceAnswering('cc', msg.controller, msg.channel);
    return item ? result(item, msg, msg.value / 127) : null;
  }

  if (!Number.isInteger(msg.note)) return null;
  const item = sourceAnswering('note', msg.note, msg.channel);
  if (!item) return null;
  const raw = msg.type === 'noteoff' ? 0 : (msg.velocity ?? msg.value);
  if (!Number.isInteger(raw) || raw < 0 || raw > 127) return null;
  return result(item, msg, raw / 127, { phase: msg.type, note: msg.note });
}
