/**
 * The controller profile format: its schema, and the validator that refuses
 * anything else.
 *
 * WHY THIS FILE IMPORTS NOTHING
 * -----------------------------
 * MINIHUB_CONTROLLER_PLATFORM_SPEC.md section 3.5. MiniHub and the site Builder
 * have to agree on three things: the schema, the decoding of a message into a
 * control, and the inference of semantics. Three chances to drift apart, and
 * every drift becomes a bug report against a profile that is in fact correct.
 * So the schema travels as ONE artefact, copied byte for byte into the other
 * codebase, next to parseMidi.js which is already dependency-free. A single
 * import would end that. What proves the two copies still agree is the
 * conformance corpus, test/conformance/midi-corpus.json, which both sides run.
 *
 * WHAT THE VALIDATOR IS FOR
 * -------------------------
 * DECISIONS.md D-020 lifts a refusal for exactly two things: a versioned
 * declarative format, and profiles living as files contributed by pull request.
 * The boundary it draws is "extensible by data, never by code" -- a profile
 * value is a scalar, an array or an object, never a function, a script, a
 * command, a system path, a DLL, an executable URL or a callback. This file is
 * where that sentence stops being prose and starts failing.
 *
 * Two properties that are not decoration:
 *
 * - Errors ACCUMULATE. A profile is rejected field by field, never at the first
 *   fault. A validator that stops at fault one turns fixing a profile into a
 *   guessing game with one answer per round trip.
 * - Unknown fields are REFUSED, not ignored. The format is versioned; a field
 *   nobody reads is either a typo the author wants to hear about, or a newer
 *   format claiming to be this one. Both deserve a failure.
 *
 * IDENTIFIERS ARE PUBLISHED, THEREFORE IMMUTABLE
 * ----------------------------------------------
 * Specification section 3.2. A control id becomes a Patch Bay port id, and port
 * ids are persisted inside every project's connections. Renaming a control cuts
 * the cables of every project that used it, silently -- the network simply stops
 * matching. Hence the narrow id shape enforced here: lowercase, digits and
 * single hyphens, nothing that could ever need quoting, escaping or a case fold.
 */

export const CONTROLLER_PROFILE_FORMAT_VERSION = 1;

/** Can this port carry what the user plays? Specification section 4.2. */
export const PORT_ROLES = Object.freeze(['performance', 'control-surface', 'ignore']);

/** A 14-bit pair is ONE binding of kind cc14, never two controls. */
export const BINDING_KINDS = Object.freeze([
  'cc', 'cc14', 'note', 'pitchbend', 'channelpressure', 'polyaftertouch', 'programchange'
]);

export const CONTROL_MODES = Object.freeze([
  'absolute', 'relative', 'velocity', 'pressure', 'bipolar', 'momentary', 'toggle', 'trigger'
]);

/**
 * Required by mode "relative", forbidden otherwise, and with no default value:
 * a relative encoder whose encoding was never observed is a guess, and the
 * format has a word for a guess (confidence "inferred") rather than a silent
 * fallback that turns a wrong guess into a smooth-looking knob.
 */
export const RELATIVE_ENCODINGS = Object.freeze(['twos-complement', 'signed-bit', 'offset-64']);

/** Specification section 3.4: a profile has to say what it does not know. */
export const CONFIDENCE_LEVELS = Object.freeze(['observed', 'documented', 'inferred']);

/** A binding present on every layer. */
export const ALL_LAYERS = '*';

/**
 * Bounds, not taste. Each one closes a way for a profile file to cost more than
 * it declares: an unbounded string in a label, a thousand controls to render, an
 * object nested until the validator recurses off the stack.
 */
const LIMITS = Object.freeze({
  stringLength: 200, depth: 8, ports: 32, layers: 16,
  controls: 512, bindings: 32, coordinate: 4096, priority: 100, revision: 100000
});

const ID_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ID_SHAPE_TEXT = 'lowercase letters, digits and single hyphens';
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

const ROOT_KEYS = Object.freeze([
  'formatVersion', 'profileId', 'revision', 'name', 'author',
  'createdAt', 'completeness', 'device', 'layers', 'controls'
]);
const DEVICE_KEYS = Object.freeze(['vendor', 'model', 'ports']);
const PORT_KEYS = Object.freeze(['role', 'priority', 'match', 'note']);
const MATCH_KEYS = Object.freeze(['name']);
const LAYER_KEYS = Object.freeze(['id', 'label']);
const CONTROL_KEYS = Object.freeze(['id', 'label', 'family', 'layout', 'bindings']);
const LAYOUT_KEYS = Object.freeze(['x', 'y']);
const BINDING_KEYS = Object.freeze(['layer', 'when', 'mode', 'encoding', 'range', 'confidence']);
const WHEN_KEYS = Object.freeze(['kind', 'channel', 'number', 'lsbNumber']);
const COMPLETENESS_KEYS = Object.freeze(['declared', 'observed', 'inferred', 'untested']);

/** Kinds whose message carries a controller or note number; the others do not. */
const KINDS_WITH_NUMBER = Object.freeze(['cc', 'cc14', 'note', 'polyaftertouch', 'programchange']);

/**
 * Keys that reach Object.prototype. JSON.parse writes "__proto__" as an own
 * property rather than through the setter, so it arrives here looking ordinary;
 * a literal written in JS sets the prototype instead, which isPlainObject sees.
 * Both roads are closed because only one of them is obvious.
 */
const FORBIDDEN_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);
const KEY_SHAPE = /^[A-Za-z][A-Za-z0-9]*$/;

/**
 * What a profile string may not look like. D-020 names the categories -- script,
 * command, system path, DLL, executable URL -- and these are them, tested
 * against every string in the file rather than against a list of "risky" fields.
 * A field-by-field allow-list is the version that gets forgotten when a field is
 * added.
 */
const DANGEROUS_STRINGS = Object.freeze([
  [/[\u0000-\u001f\u007f]/, 'contains a control character'],
  [/^[a-z][a-z0-9+.-]*:\/\//i, 'looks like a URL'],
  [/^(?:javascript|data|vbscript|blob|about|file):/i, 'uses an executable URL scheme'],
  [/^[a-z]:[\\/]/i, 'looks like a Windows path'],
  [/^\\\\/, 'looks like a UNC network path'],
  [/^\.{0,2}[\\/]/, 'looks like a file path'],
  [/(?:^|[\\/])\.\.(?:[\\/]|$)/, 'contains a path traversal'],
  [/\.(?:exe|dll|so|dylib|bat|cmd|com|ps1|sh|js|mjs|cjs|vbs|scr|msi|lnk)(?:$|[?#\s])/i,
    'names an executable or a library'],
  [/<\s*script/i, 'contains a script tag']
]);

const fail = (errors, path, message) => { errors.push({ path, message }); };

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Invariant "profile is data", walked over the whole tree before any field is
 * looked at by name. Everything below this point may then assume that what it
 * reads is inert.
 */
function scanData(value, path, errors, depth) {
  if (depth > LIMITS.depth) {
    fail(errors, path, `nests deeper than ${LIMITS.depth} levels`);
    return;
  }
  if (value === null) return;
  const type = typeof value;
  if (type === 'boolean') return;
  if (type === 'number') {
    if (!Number.isFinite(value)) fail(errors, path, 'is not a finite number');
    return;
  }
  if (type === 'string') {
    if (value.length > LIMITS.stringLength) {
      fail(errors, path, `is longer than ${LIMITS.stringLength} characters`);
      return;
    }
    for (const [pattern, why] of DANGEROUS_STRINGS) {
      if (pattern.test(value)) { fail(errors, path, `${why}; a profile carries data, not code`); return; }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanData(item, `${path}[${index}]`, errors, depth + 1));
    return;
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_KEYS.includes(key)) {
        fail(errors, `${path}.${key}`, 'uses a key that reaches Object.prototype');
        continue;
      }
      if (!KEY_SHAPE.test(key)) {
        fail(errors, `${path}.${key}`, 'uses a field name outside letters and digits');
        continue;
      }
      scanData(value[key], `${path}.${key}`, errors, depth + 1);
    }
    return;
  }
  const what = type === 'object' ? 'an object with a prototype' : `a ${type}`;
  fail(errors, path, `is ${what}; a profile carries only scalars, arrays and objects`);
}

function checkKeys(object, path, allowed, errors) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) fail(errors, `${path}.${key}`, 'is not a field of this format version');
  }
}

function stringField(object, path, key, errors, { shape = null, shapeText = '', optional = false } = {}) {
  const where = `${path}.${key}`;
  const value = object[key];
  if (value === undefined) {
    if (!optional) fail(errors, where, 'is required');
    return null;
  }
  if (typeof value !== 'string') { fail(errors, where, 'must be a string'); return null; }
  if (value.length === 0) { fail(errors, where, 'must not be empty'); return null; }
  if (shape && !shape.test(value)) { fail(errors, where, `must be ${shapeText}`); return null; }
  return value;
}

function integerField(object, path, key, errors, { min, max, optional = false } = {}) {
  const where = `${path}.${key}`;
  const value = object[key];
  if (value === undefined) {
    if (!optional) fail(errors, where, 'is required');
    return null;
  }
  if (!Number.isInteger(value)) { fail(errors, where, 'must be a whole number'); return null; }
  if (value < min || value > max) { fail(errors, where, `must be between ${min} and ${max}`); return null; }
  return value;
}

function enumField(object, path, key, errors, allowed, { optional = false } = {}) {
  const where = `${path}.${key}`;
  const value = object[key];
  if (value === undefined) {
    if (!optional) fail(errors, where, 'is required');
    return null;
  }
  if (typeof value !== 'string' || !allowed.includes(value)) {
    fail(errors, where, `must be one of ${allowed.join(', ')}`);
    return null;
  }
  return value;
}

function objectField(object, path, key, errors, { optional = false } = {}) {
  const where = `${path}.${key}`;
  const value = object[key];
  if (value === undefined) {
    if (!optional) fail(errors, where, 'is required');
    return null;
  }
  if (!isPlainObject(value)) { fail(errors, where, 'must be an object'); return null; }
  return value;
}

function arrayField(object, path, key, errors, { max, min = 1, optional = false } = {}) {
  const where = `${path}.${key}`;
  const value = object[key];
  if (value === undefined) {
    if (!optional) fail(errors, where, 'is required');
    return null;
  }
  if (!Array.isArray(value)) { fail(errors, where, 'must be an array'); return null; }
  if (value.length < min) { fail(errors, where, `must hold at least ${min} entries`); return null; }
  if (value.length > max) { fail(errors, where, `must hold at most ${max} entries`); return null; }
  return value;
}

function validateDevice(device, errors) {
  checkKeys(device, 'profile.device', DEVICE_KEYS, errors);
  stringField(device, 'profile.device', 'vendor', errors);
  stringField(device, 'profile.device', 'model', errors);
  const ports = arrayField(device, 'profile.device', 'ports', errors, { max: LIMITS.ports });
  if (!ports) return;
  ports.forEach((port, index) => {
    const path = `profile.device.ports[${index}]`;
    if (!isPlainObject(port)) { fail(errors, path, 'must be an object'); return; }
    checkKeys(port, path, PORT_KEYS, errors);
    enumField(port, path, 'role', errors, PORT_ROLES);
    integerField(port, path, 'priority', errors, { min: 0, max: LIMITS.priority });
    stringField(port, path, 'note', errors, { optional: true });
    const match = objectField(port, path, 'match', errors);
    if (!match) return;
    checkKeys(match, `${path}.match`, MATCH_KEYS, errors);
    stringField(match, `${path}.match`, 'name', errors);
  });
}

function validateLayers(layers, errors) {
  const ids = new Set();
  layers.forEach((layer, index) => {
    const path = `profile.layers[${index}]`;
    if (!isPlainObject(layer)) { fail(errors, path, 'must be an object'); return; }
    checkKeys(layer, path, LAYER_KEYS, errors);
    stringField(layer, path, 'label', errors);
    const id = stringField(layer, path, 'id', errors, { shape: ID_SHAPE, shapeText: ID_SHAPE_TEXT });
    if (id === null) return;
    if (ids.has(id)) fail(errors, `${path}.id`, `repeats the layer id '${id}'`);
    ids.add(id);
  });
  return ids;
}

function validateWhen(when, path, errors) {
  checkKeys(when, path, WHEN_KEYS, errors);
  const kind = enumField(when, path, 'kind', errors, BINDING_KINDS);
  // An absent channel means "on any channel", and it is not a shortcut: it is
  // what most controllers actually do once their global channel is moved, and
  // what MiniHub has always done for continuous controllers. A channel written
  // down is a channel matched -- so it is written down only where the match
  // really depends on it, which on the MiniLab 3 is the pads on channel 10.
  integerField(when, path, 'channel', errors, { min: 1, max: 16, optional: true });
  if (kind === null) return null;

  if (KINDS_WITH_NUMBER.includes(kind)) integerField(when, path, 'number', errors, { min: 0, max: 127 });
  else if (when.number !== undefined) fail(errors, `${path}.number`, `is meaningless for kind '${kind}'`);

  if (kind === 'cc14') integerField(when, path, 'lsbNumber', errors, { min: 0, max: 127 });
  else if (when.lsbNumber !== undefined) fail(errors, `${path}.lsbNumber`, "only belongs to kind 'cc14'");

  return kind;
}

function validateBinding(binding, path, layerIds, errors) {
  if (!isPlainObject(binding)) { fail(errors, path, 'must be an object'); return null; }
  checkKeys(binding, path, BINDING_KEYS, errors);
  enumField(binding, path, 'confidence', errors, CONFIDENCE_LEVELS);

  const layer = stringField(binding, path, 'layer', errors);
  if (layer !== null && layer !== ALL_LAYERS && !layerIds.has(layer)) {
    fail(errors, `${path}.layer`, `names the layer '${layer}', which the profile does not declare`);
  }

  const mode = enumField(binding, path, 'mode', errors, CONTROL_MODES);
  if (mode === 'relative') enumField(binding, path, 'encoding', errors, RELATIVE_ENCODINGS);
  else if (binding.encoding !== undefined) fail(errors, `${path}.encoding`, "only belongs to mode 'relative'");

  if (binding.range !== undefined) {
    const range = arrayField(binding, path, 'range', errors, { min: 2, max: 2 });
    if (range && range.length === 2) {
      const low = integerField(range, `${path}.range`, '0', errors, { min: 0, max: 16383 });
      const high = integerField(range, `${path}.range`, '1', errors, { min: 0, max: 16383 });
      if (low !== null && high !== null && low >= high) {
        fail(errors, `${path}.range`, 'must go from a low value to a higher one');
      }
    }
  }

  const when = objectField(binding, path, 'when', errors);
  if (!when) return null;
  const kind = validateWhen(when, `${path}.when`, errors);
  if (kind === null || layer === null) return null;
  return { layer, kind, channel: when.channel, number: when.number };
}

/**
 * Two bindings that answer the same message on the same layer make the decoder
 * pick one of them by source order -- which is to say, by accident. A profile has
 * to be unambiguous before it is loaded, not arbitrated afterwards.
 *
 * A binding with no channel answers on all sixteen of them, so it collides with
 * any binding of the same kind and number, channel or no channel.
 */
function reportMessageCollisions(claims, errors) {
  const byMessage = new Map();
  for (const claim of claims) {
    const key = `${claim.kind}:${claim.number ?? '-'}`;
    const seen = byMessage.get(key) ?? [];
    for (const other of seen) {
      const sameLayer = other.layer === claim.layer || other.layer === ALL_LAYERS || claim.layer === ALL_LAYERS;
      const sameChannel = other.channel === undefined || claim.channel === undefined
        || other.channel === claim.channel;
      if (sameLayer && sameChannel) {
        fail(errors, claim.path, `answers the same message as ${other.path} on layer '${claim.layer}'`);
        break;
      }
    }
    seen.push(claim);
    byMessage.set(key, seen);
  }
}

function validateControls(controls, layerIds, errors) {
  const ids = new Set();
  const claims = [];
  controls.forEach((control, index) => {
    const path = `profile.controls[${index}]`;
    if (!isPlainObject(control)) { fail(errors, path, 'must be an object'); return; }
    checkKeys(control, path, CONTROL_KEYS, errors);
    stringField(control, path, 'label', errors);
    stringField(control, path, 'family', errors, { shape: ID_SHAPE, shapeText: ID_SHAPE_TEXT });

    const id = stringField(control, path, 'id', errors, { shape: ID_SHAPE, shapeText: ID_SHAPE_TEXT });
    if (id !== null) {
      if (ids.has(id)) fail(errors, `${path}.id`, `repeats the control id '${id}'`);
      ids.add(id);
    }

    const layout = objectField(control, path, 'layout', errors);
    if (layout) {
      checkKeys(layout, `${path}.layout`, LAYOUT_KEYS, errors);
      integerField(layout, `${path}.layout`, 'x', errors, { min: 0, max: LIMITS.coordinate });
      integerField(layout, `${path}.layout`, 'y', errors, { min: 0, max: LIMITS.coordinate });
    }

    const bindings = arrayField(control, path, 'bindings', errors, { min: 0, max: LIMITS.bindings });
    if (!bindings) return;
    bindings.forEach((binding, bindingIndex) => {
      const bindingPath = `${path}.bindings[${bindingIndex}]`;
      const claim = validateBinding(binding, bindingPath, layerIds, errors);
      if (claim) claims.push({ ...claim, path: bindingPath });
    });
  });
  reportMessageCollisions(claims, errors);
}

const CONFIDENCE_RANK = Object.freeze({ observed: 3, documented: 2, inferred: 1 });

/**
 * The summary MiniHub shows so that an imported profile is not trusted blindly.
 * Specification section 4.5: it is computed, never typed in -- a profile does not
 * get to grade itself.
 *
 * A control is ranked by its best binding: observed beats documented beats
 * inferred, and a control with no binding at all is untested. Note that the four
 * counters the specification names do not cover "documented", so
 * observed + inferred + untested can be less than declared. That is the
 * specification's shape, kept as it is rather than quietly widened here.
 */
export function computeCompleteness(profile) {
  const controls = Array.isArray(profile?.controls) ? profile.controls : [];
  const summary = { declared: controls.length, observed: 0, inferred: 0, untested: 0 };
  for (const control of controls) {
    const bindings = Array.isArray(control?.bindings) ? control.bindings : [];
    if (bindings.length === 0) { summary.untested += 1; continue; }
    let best = 0;
    for (const binding of bindings) best = Math.max(best, CONFIDENCE_RANK[binding?.confidence] ?? 0);
    if (best === CONFIDENCE_RANK.observed) summary.observed += 1;
    else if (best === CONFIDENCE_RANK.inferred) summary.inferred += 1;
  }
  return summary;
}

/**
 * Validate one parsed profile. Returns every fault found, so a profile can be
 * fixed in one pass rather than one round trip per mistake.
 */
export function validateControllerProfile(value) {
  const errors = [];
  scanData(value, 'profile', errors, 0);
  if (!isPlainObject(value)) {
    fail(errors, 'profile', 'must be an object');
    return { ok: false, errors };
  }

  checkKeys(value, 'profile', ROOT_KEYS, errors);

  // Refused first and named plainly: a file from a newer format read under this
  // one's rules is the shape of silent data loss. Nothing is touched while a
  // profile is being rejected -- rejection is the whole of the reaction.
  if (value.formatVersion !== CONTROLLER_PROFILE_FORMAT_VERSION) {
    fail(errors, 'profile.formatVersion',
      `must be ${CONTROLLER_PROFILE_FORMAT_VERSION}; this build reads no other format version`);
  }

  stringField(value, 'profile', 'profileId', errors, { shape: ID_SHAPE, shapeText: ID_SHAPE_TEXT });
  integerField(value, 'profile', 'revision', errors, { min: 1, max: LIMITS.revision });
  stringField(value, 'profile', 'name', errors);
  stringField(value, 'profile', 'createdAt', errors, { shape: DATE_SHAPE, shapeText: 'a YYYY-MM-DD date' });
  if (typeof value.author !== 'string') fail(errors, 'profile.author', 'must be a string, possibly empty');

  const device = objectField(value, 'profile', 'device', errors);
  if (device) validateDevice(device, errors);

  const layers = arrayField(value, 'profile', 'layers', errors, { max: LIMITS.layers });
  const layerIds = layers ? validateLayers(layers, errors) : new Set();

  const controls = arrayField(value, 'profile', 'controls', errors, { max: LIMITS.controls });
  if (controls) validateControls(controls, layerIds, errors);

  const completeness = objectField(value, 'profile', 'completeness', errors);
  if (completeness) {
    checkKeys(completeness, 'profile.completeness', COMPLETENESS_KEYS, errors);
    const computed = computeCompleteness(value);
    for (const key of COMPLETENESS_KEYS) {
      if (completeness[key] !== computed[key]) {
        fail(errors, `profile.completeness.${key}`,
          `says ${JSON.stringify(completeness[key])} where the controls add up to ${computed[key]}`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
