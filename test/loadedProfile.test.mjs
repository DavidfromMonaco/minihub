/**
 * Which profile runs, and what happens when the chosen one cannot.
 *
 * The rule this file locks is that MiniHub NEVER launches without a controller.
 * A profile that is absent, unreadable or invalid falls back to the one that
 * ships — and says so, because falling back in silence would leave a user whose
 * keyboard has quietly become a MiniLab 3, with every cable pointing at a node
 * named after a device he does not own.
 *
 * `resolveProfile` is exported and pure for exactly this: the decision it makes
 * lands in a module-level constant that nothing can swap afterwards, so the only
 * way to run it against a foreign profile is to hand it one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { LOADED_PROFILE, PROFILE_ORIGIN, resolveProfile } from '../src/renderer/js/midi/loadedProfile.js';

const shipped = JSON.parse(fs.readFileSync(
  new URL('../src/renderer/js/midi/profiles/minilab-3.json', import.meta.url), 'utf8'
));

/** A legal profile for a device that does not exist, with its own identity. */
const foreign = () => JSON.parse(fs.readFileSync(
  new URL('./conformance/vega-49.json', import.meta.url), 'utf8'
));

test('with nothing chosen, the profile that ships is the profile that runs', () => {
  for (const handover of [null, undefined, { source: 'none' }]) {
    const resolved = resolveProfile(handover, shipped);
    assert.equal(resolved.profile, shipped);
    assert.equal(resolved.origin, 'shipped');
    assert.equal(resolved.reason, null, 'nothing was asked for, so nothing failed');
  }
});

test('a chosen profile runs, and is validated before it does', () => {
  const vega = foreign();
  const resolved = resolveProfile({ source: 'file', fileName: 'vega-49.json', profile: vega }, shipped);
  assert.equal(resolved.profile, vega);
  assert.equal(resolved.origin, 'file');
  assert.equal(resolved.fileName, 'vega-49.json');
  // The identity the whole application derives from it: the routing node's id,
  // every port id, every binding key.
  assert.equal(resolved.profile.profileId, 'vega-49');
});

test('a profile that does not validate is refused, and every fault is kept', () => {
  const broken = foreign();
  broken.controls[0].id = 'Dial One';          // capitals cannot survive being a port id
  broken.controls[1].bindings[0].mode = 'wat'; // not a mode this format has

  const resolved = resolveProfile({ source: 'file', fileName: 'broken.json', profile: broken }, shipped);
  assert.equal(resolved.profile, shipped, 'the application still launches, on the profile it ships with');
  assert.equal(resolved.origin, 'shipped');
  assert.equal(resolved.reason, 'invalid');
  assert.equal(resolved.fileName, 'broken.json', 'the file that failed is named, or nobody can fix it');
  assert.ok(resolved.detail.length >= 2,
    'the validator accumulates faults so a profile is fixed in one pass; keeping only the first would undo that');
});

test('a file that is gone or is not JSON falls back, and says which', () => {
  const resolved = resolveProfile(
    { source: 'unreadable', fileName: 'korg-nano.json', error: 'ENOENT' }, shipped
  );
  assert.equal(resolved.profile, shipped);
  assert.equal(resolved.reason, 'unreadable');
  assert.equal(resolved.detail, 'ENOENT');
  assert.equal(resolved.fileName, 'korg-nano.json');
});

test('a handover that makes no sense is treated as a failure, not as a profile', () => {
  for (const handover of [
    { source: 'file' },
    { source: 'file', profile: null },
    { source: 'file', profile: 'a string' },
    { source: 'something-else' }
  ]) {
    const resolved = resolveProfile(handover, shipped);
    assert.equal(resolved.profile, shipped, `${JSON.stringify(handover)} must not become the profile`);
    assert.equal(resolved.origin, 'shipped');
  }
});

/**
 * The default path, which is also the migration one: a user who imports nothing
 * sees no change at all. Specification section 3.3 asks for an empty migration,
 * and this is where that is either true or false.
 */
test('with no profile injected, the module loads the one that ships', () => {
  assert.equal(LOADED_PROFILE.profileId, 'minilab-3');
  assert.equal(PROFILE_ORIGIN.origin, 'shipped');
  assert.equal(PROFILE_ORIGIN.reason, null);
  assert.deepEqual(LOADED_PROFILE.controls.map((control) => control.id),
    shipped.controls.map((control) => control.id));
});
