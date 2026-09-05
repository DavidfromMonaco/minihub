/**
 * MiniHub's names for the MiniLab 3's controls, and the one profile that ships.
 *
 * This file used to hold the 25 control sources as a JavaScript literal. That
 * literal WAS a profile -- ids, CC numbers, pad notes, port ids -- with the
 * hardware welded into the core, which INTENT.md section 5 calls a defect and
 * DECISIONS.md D-020 lifted the refusal on. It derives them from
 * profiles/minilab-3.json instead, and the exported shape did not move an inch
 * while that happened.
 *
 * What it no longer holds is the decoding. A message becoming a control is
 * something MiniHub and the site Builder have to answer identically
 * (specification section 3.5), and it could not be shared while it was written
 * against one device's node id and port ids. It moved to decodeControl.js, which
 * takes a profile and returns the profile's own control; this file is what turns
 * that answer into the four names a saved project contains.
 *
 * Which profile this reads is `loadedProfile.js`'s decision, made once at launch
 * and never here. The built-in one is still trusted without validation -- it
 * ships with the application and a test holds it against the format -- but it is
 * now the FALLBACK rather than the only possibility, and anything arriving from
 * a file goes through validateControllerProfile() before it reaches this file.
 */
import { decodeControl } from './decodeControl.js';
import { MINILAB_NODE_ID } from '../core/systemNodes.js';
import { LOADED_PROFILE as profile } from './loadedProfile.js';

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

/**
 * A control that sends nothing is drawn and never routed.
 *
 * `HOLD`, `OCT −`, `OCT +` and the screen are on the panel, and a user needs to
 * see them to recognise the object under his fingers -- but there is no message
 * to carry, so a CONTROL port for them would be a socket that can never fire and
 * a Learn target that can never be learned. Excluding them here is also what
 * keeps this list at the 25 sources `test/conformance/control-sources.json`
 * freezes: declaring the panel does not touch a single saved project.
 */
const isRoutable = (control) => control.silent !== true;

/** Stable physical CONTROL identities; original MIDI is never consumed. */
export const MINILAB_CONTROL_SOURCES = Object.freeze(
  profile.controls.filter(isRoutable).map(toControlSource)
);

/**
 * Everything the panel HAS, in profile order -- including what it cannot send.
 *
 * This is the drawing list, and it is deliberately not the routing list above.
 * `printed` is what the manufacturer silk-screened next to the control; a
 * renderer must show it even when it has to show it faintly, because it is what
 * the user matches against the words on his hardware. `id` is null for a silent
 * element: there is no source to select, arm or bind, and a null says that
 * louder than an id that resolves to nothing.
 */
export const MINILAB_SURFACE_CONTROLS = Object.freeze(profile.controls.map((control) => Object.freeze({
  id: isRoutable(control) ? `${profile.profileId}:${control.id}` : null,
  portId: isRoutable(control) ? `control-${control.id}` : null,
  key: control.id,
  label: control.label,
  printed: control.printed ?? null,
  family: control.family,
  silent: !isRoutable(control),
  layout: control.layout ? Object.freeze({ ...control.layout }) : null
})));

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
/**
 * Null when the profile places nothing. D-023: a device described without a
 * photograph has no coordinates, and its controls are read as a list.
 *
 * It used to be `{ ...profile.device.layout }`, which turns an absent box into
 * `{}` -- an object, therefore truthy, therefore a panel of width `undefined`.
 * Every caller downstream would have believed it had a drawing.
 */
export const MINILAB_SURFACE_BOX = profile.device.layout
  ? Object.freeze({ ...profile.device.layout })
  : null;

const LAYOUT_BY_KEY = new Map(profile.controls
  .filter((control) => control.layout)
  .map((control) => [control.id, Object.freeze({ ...control.layout })]));

export function getMiniLabControlLayout(key) { return LAYOUT_BY_KEY.get(key) || null; }

const BY_ID = new Map(MINILAB_CONTROL_SOURCES.map((item) => [item.id, item]));
const BY_PORT = new Map(MINILAB_CONTROL_SOURCES.map((item) => [item.portId, item]));

export function getMiniLabControlSource(id) { return BY_ID.get(id) || null; }
export function getMiniLabControlSourceByPort(id) { return BY_PORT.get(id) || null; }

const BY_KEY = new Map(MINILAB_CONTROL_SOURCES.map((item) => [item.key, item]));

/**
 * Additively project one documented physical message into CONTROL.
 *
 * The decoding itself is not here any more -- it is `decodeControl.js`, which
 * knows a profile and nothing else, and which the site Builder runs from its own
 * copy. What is left here is the naming: the profile answers "control k1", and
 * MiniHub calls that `minilab-3:k1` on node `minilab-3` through port
 * `control-k1`, with the legacy `semantics` word attached. Those four names are
 * persisted inside saved projects, which is why they are built by rule and never
 * invented -- and why they stay on this side of the line.
 *
 * `binding` is dropped deliberately rather than forwarded: which declaration
 * answered is the decoder's business, and a CONTROL event that carried it would
 * be a second, unversioned copy of the profile travelling through the network.
 * Anything the decoder adds later and this line does not name fails the
 * conformance corpus loudly, which is the intended way round.
 *
 * Additively is the invariant, not the adverb: a message that becomes a control
 * is never taken off its MIDI path. A note played on the keys stays music, and
 * K1 keeps sending CC 74 while it also drives a VST parameter. Specification
 * section 6.7, and `controlRouting.test.mjs` is what holds it.
 */
export function decodeMiniLabControl(msg) {
  const hit = decodeControl(profile, msg);
  if (!hit) return null;
  const { control, binding, normalizedValue, rawValue, ...extra } = hit;
  const item = BY_KEY.get(control.id);
  return {
    type: 'control',
    sourceControlId: item.id,
    sourceNodeId: MINILAB_NODE_ID,
    sourcePortId: item.portId,
    label: item.label,
    semantics: item.semantics,
    normalizedValue,
    rawValue,
    ...extra
  };
}
