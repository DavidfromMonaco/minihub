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
 * Which profiles this reads is `loadedProfile.js`'s decision, made once at launch
 * and never here. The built-in one is still trusted without validation -- it
 * ships with the application and a test holds it against the format -- but it is
 * now the FALLBACK rather than the only possibility, and anything arriving from
 * a file goes through validateControllerProfile() before it reaches this file.
 *
 * WHY EVERYTHING HERE IS KEYED ON A NODE
 * --------------------------------------
 * Two keyboards run at once, so `control-k1` and `k1` stopped being answers.
 * They are unique inside ONE profile and inside nothing larger: a MiniLab and a
 * BeatStep both have a first knob, and both call its port `control-k1`. Asking
 * this file for `control-k1` would get whichever keyboard happened to load
 * first, and a cable drawn on the second would drive the first one's binding.
 *
 * So the lookups take the node -- which IS the profile id (D-025) -- and the one
 * key that is unique on its own, `<profileId>:<controlId>`, is the one the
 * source-level lookups use. Nothing here answers a bare control key any more.
 */
import { decodeControl } from './decodeControl.js';
import { LOADED_PROFILE, LOADED_PROFILES } from './loadedProfile.js';

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
function toControlSource(profile, control) {
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

/** One keyboard's routable CONTROL identities. */
function controlSourcesOf(profile) {
  return Object.freeze(profile.controls.filter(isRoutable).map((control) => toControlSource(profile, control)));
}

/**
 * Everything one panel HAS, in profile order -- including what it cannot send.
 *
 * This is the drawing list, and it is deliberately not the routing list above.
 * `printed` is what the manufacturer silk-screened next to the control; a
 * renderer must show it even when it has to show it faintly, because it is what
 * the user matches against the words on his hardware. `id` is null for a silent
 * element: there is no source to select, arm or bind, and a null says that
 * louder than an id that resolves to nothing.
 */
function surfaceControlsOf(profile) {
  return Object.freeze(profile.controls.map((control) => Object.freeze({
    id: isRoutable(control) ? `${profile.profileId}:${control.id}` : null,
    portId: isRoutable(control) ? `control-${control.id}` : null,
    key: control.id,
    label: control.label,
    printed: control.printed ?? null,
    family: control.family,
    silent: !isRoutable(control),
    layout: control.layout ? Object.freeze({ ...control.layout }) : null
  })));
}

const EMPTY = Object.freeze([]);

// Built once, per keyboard, and every export below is a view onto these. Two
// derivations of the same profile would be two sets of frozen objects that are
// equal and not identical, which is the sort of thing that makes `find` and
// `===` disagree three files away.
const SOURCES_BY_NODE = new Map(LOADED_PROFILES.map((entry) => [entry.profileId, controlSourcesOf(entry)]));
const SURFACE_CONTROLS_BY_NODE = new Map(LOADED_PROFILES.map((entry) =>
  [entry.profileId, surfaceControlsOf(entry)]));
const SURFACE_BOX_BY_NODE = new Map(LOADED_PROFILES.map((entry) =>
  [entry.profileId, entry.device.layout ? Object.freeze({ ...entry.device.layout }) : null]));
const PROFILE_BY_NODE = new Map(LOADED_PROFILES.map((entry) => [entry.profileId, entry]));

/** What one keyboard can send. Empty for a node that is not a controller. */
export function controlSourcesOfNode(nodeId) { return SOURCES_BY_NODE.get(nodeId) ?? EMPTY; }

/** What one keyboard HAS, drawable elements included. */
export function surfaceControlsOfNode(nodeId) { return SURFACE_CONTROLS_BY_NODE.get(nodeId) ?? EMPTY; }

/**
 * The coordinate space one keyboard's positions are expressed in, or null.
 *
 * D-023: a device described without a photograph has no coordinates, and its
 * controls are read as a list. It used to be `{ ...profile.device.layout }`,
 * which turns an absent box into `{}` -- an object, therefore truthy, therefore
 * a panel of width `undefined`, which every caller downstream would have
 * believed was a drawing.
 */
export function surfaceBoxOfNode(nodeId) { return SURFACE_BOX_BY_NODE.get(nodeId) ?? null; }

/** The profile a node runs on, for the callers that need to decode with it. */
export function profileOfNode(nodeId) { return PROFILE_BY_NODE.get(nodeId) ?? null; }

/** Every routable identity on the desk, keyboard by keyboard, in load order. */
export const MINILAB_CONTROL_SOURCES = Object.freeze([...SOURCES_BY_NODE.values()].flat());

/** The first keyboard's, for the consumers that still know of one. */
export const MINILAB_SURFACE_CONTROLS = surfaceControlsOfNode(LOADED_PROFILE.profileId);

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
/** The first keyboard's box, for the consumers that still know of one. */
export const MINILAB_SURFACE_BOX = surfaceBoxOfNode(LOADED_PROFILE.profileId);

/**
 * Where a control sits, keyed on the one name that is unique across keyboards.
 *
 * `k1` was the key here and could not stay one: it names a knob on every device
 * that has knobs. `<profileId>:<controlId>` is the source id a saved project
 * already contains, it is unique by construction, and every caller of this
 * function has it in hand -- so the disambiguation costs nothing and no
 * second argument had to be threaded through the drawing code.
 *
 * Silent elements are in here too. They are never routed and never asked for by
 * id, but a panel draws them, and a table missing half a device would be a trap
 * for the next reader.
 */
const LAYOUT_BY_SOURCE_ID = new Map(LOADED_PROFILES.flatMap((entry) => entry.controls
  .filter((control) => control.layout)
  .map((control) => [`${entry.profileId}:${control.id}`, Object.freeze({ ...control.layout })])));

export function getMiniLabControlLayout(sourceId) { return LAYOUT_BY_SOURCE_ID.get(sourceId) || null; }

// `id` is `<profileId>:<controlId>` and is unique on the whole desk; `portId` is
// `control-<controlId>` and is unique only INSIDE its node, which is why one of
// these is a flat map and the other is a map per node.
const BY_ID = new Map(MINILAB_CONTROL_SOURCES.map((item) => [item.id, item]));
const BY_PORT_BY_NODE = new Map([...SOURCES_BY_NODE].map(([nodeId, sources]) =>
  [nodeId, new Map(sources.map((item) => [item.portId, item]))]));
const BY_KEY_BY_NODE = new Map([...SOURCES_BY_NODE].map(([nodeId, sources]) =>
  [nodeId, new Map(sources.map((item) => [item.key, item]))]));

export function getMiniLabControlSource(id) { return BY_ID.get(id) || null; }

/**
 * Which keyboard a source belongs to.
 *
 * The answer is inside the id -- `minilab-3:k1` says both halves -- but reading
 * it by cutting the string at the colon would be a second parser for a format
 * `core/controlBindings.js` already owns. This is the table that was built when
 * the sources were, so it cannot disagree with them.
 *
 * It exists because "is this cable from a controller?" stopped being a strong
 * enough question. Two keyboards both answer yes, and both have a socket called
 * `control-k1`; what a binding needs to know is whether the cable comes from the
 * keyboard THIS source is on.
 */
const NODE_BY_SOURCE_ID = new Map([...SOURCES_BY_NODE]
  .flatMap(([nodeId, sources]) => sources.map((item) => [item.id, nodeId])));

export function controllerNodeOfSource(sourceId) { return NODE_BY_SOURCE_ID.get(sourceId) ?? null; }

/** The control a cable leaves by. Takes the node: a port id alone names a
 *  socket on every keyboard that has one. */
export function getMiniLabControlSourceByPort(nodeId, portId) {
  return BY_PORT_BY_NODE.get(nodeId)?.get(portId) ?? null;
}

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
 *
 * WHICH keyboard sent it is the caller's to say, not this function's to guess.
 * Two controllers both send CC 74 from their first knob; deciding here by trying
 * each profile in turn would hand every message to whichever loaded first. The
 * answer is the port it arrived on, which `midi/midiManager.js` knows and this
 * file does not -- so it is a parameter, defaulting to the first keyboard until
 * that arming lands.
 */
export function decodeMiniLabControl(msg, forProfile = LOADED_PROFILE) {
  const hit = decodeControl(forProfile, msg);
  if (!hit) return null;
  const { control, binding, normalizedValue, rawValue, ...extra } = hit;
  const item = BY_KEY_BY_NODE.get(forProfile.profileId)?.get(control.id);
  // A control that decodes but has no source is a profile declaring bindings on
  // a `silent` element. It is drawn and never routed, by definition, so there is
  // nothing to emit -- and reading `item.id` off `undefined` would take the
  // whole MIDI path down with a TypeError.
  if (!item) return null;
  return {
    type: 'control',
    sourceControlId: item.id,
    sourceNodeId: forProfile.profileId,
    sourcePortId: item.portId,
    label: item.label,
    semantics: item.semantics,
    normalizedValue,
    rawValue,
    ...extra
  };
}
