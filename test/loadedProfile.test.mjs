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
import {
  LOADED_PROFILE, LOADED_PROFILES, PROFILE_ORIGIN, PROFILE_ORIGINS, resolveProfile, resolveProfiles
} from '../src/renderer/js/midi/loadedProfile.js';

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
  assert.deepEqual(LOADED_PROFILES, [LOADED_PROFILE], 'and it is a list of exactly that one');
  assert.deepEqual(PROFILE_ORIGINS, [PROFILE_ORIGIN]);
});

/*
 * TWO KEYBOARDS AT ONCE
 *
 * `plans/active/two-controllers-at-once.md`: a MiniLab and a BeatStep on one
 * desk run together, and choosing between them stops being a thing the user
 * does. What must hold as that arrives: the shipped profile stands in ONCE, and
 * never for a keyboard that simply failed to load while others did -- standing
 * it in twice would register one node id twice (invariants 4 and 5).
 */
const asFile = (fileName, loaded) => ({ source: 'file', fileName, profile: loaded, error: null });

test('two profiles chosen are two profiles running', () => {
  const vega = foreign();
  const entries = resolveProfiles([asFile('minilab-3.json', shipped), asFile('vega-49.json', vega)], shipped);

  assert.deepEqual(entries.map((entry) => entry.origin), ['file', 'file']);
  assert.deepEqual(entries.map((entry) => entry.profile.profileId), ['minilab-3', 'vega-49'],
    'in the order they were chosen, because that is the order the nodes appear in');
  assert.equal(entries[1].fileName, 'vega-49.json');
});

test('a keyboard that fails while another loads is named, not replaced', () => {
  const vega = foreign();
  const entries = resolveProfiles([
    asFile('vega-49.json', vega),
    { source: 'unreadable', fileName: 'beatstep.json', profile: null, error: 'ENOENT' }
  ], shipped);

  assert.equal(entries.length, 2);
  assert.equal(entries[0].profile, vega, 'the one that loaded is untouched');
  assert.equal(entries[1].profile, null,
    'the shipped profile does not stand in here: minilab-3 is already a node id, and a second one is invariant 4');
  assert.equal(entries[1].origin, 'missing');
  assert.equal(entries[1].fileName, 'beatstep.json', 'named, so the page can say which keyboard is absent');
  assert.equal(entries[1].reason, 'unreadable');
});

test('when nothing loads at all, the shipped profile stands in once and says whose place it took', () => {
  const broken = foreign();
  broken.controls[0].id = 'Dial One';

  const entries = resolveProfiles([
    asFile('broken.json', broken),
    { source: 'unreadable', fileName: 'gone.json', profile: null, error: 'ENOENT' }
  ], shipped);

  assert.equal(entries[0].profile, shipped, 'MiniHub never launches without a controller');
  assert.equal(entries[0].origin, 'shipped');
  assert.equal(entries[0].fileName, 'broken.json', 'it takes the place of the first failure, and reports it');
  assert.equal(entries[0].reason, 'invalid');
  assert.equal(entries[1].origin, 'missing', 'one shipped profile cannot stand in for two keyboards');
  assert.equal(entries.filter((entry) => entry.profile !== null).length, 1);
});

/*
 * The shipped profile is compiled in, so `main` can only ever report it as
 * unreadable -- there is no file for it to read. Until it answered to a name it
 * could not be asked for AT ALL alongside another keyboard: selecting a BeatStep
 * replaced the MiniLab rather than joining it, which is the one arrangement this
 * workstream exists for.
 */
test('the shipped profile loads beside an imported one, though it has no file', () => {
  const vega = foreign();
  const entries = resolveProfiles([
    { source: 'unreadable', fileName: 'minilab-3.json', profile: null, error: 'ENOENT' },
    asFile('vega-49.json', vega)
  ], shipped);

  assert.equal(entries.length, 2);
  assert.equal(entries[0].profile, shipped, 'the name resolves to the compiled-in profile');
  assert.equal(entries[0].origin, 'shipped');
  assert.equal(entries[0].reason, null, 'it is not a failure: nothing went wrong');
  assert.equal(entries[1].profile, vega);
  assert.deepEqual(entries.map((entry) => entry.profile.profileId), ['minilab-3', 'vega-49']);
});

test('a file under the shipped name wins, so an updated profile can replace it', () => {
  // D-025: a profile is identified by the hardware it describes, so a newer
  // `minilab-3.json` IS the MiniLab 3 and the substitution must not fight it.
  const newer = foreign();
  const entries = resolveProfiles([asFile('minilab-3.json', newer)], shipped);
  assert.equal(entries[0].profile, newer);
  assert.equal(entries[0].origin, 'file');
});

test('a name that is not the shipped one is still a missing keyboard', () => {
  const vega = foreign();
  const entries = resolveProfiles([
    asFile('vega-49.json', vega),
    { source: 'unreadable', fileName: 'gone.json', profile: null, error: 'ENOENT' }
  ], shipped);
  assert.equal(entries[1].profile, null, 'the substitution is for one name, not for every failure');
  assert.equal(entries[1].origin, 'missing');
});

test('a list is never resolved to nothing', () => {
  for (const handover of [null, undefined, [], [{ source: 'none' }], {}]) {
    const entries = resolveProfiles(handover, shipped);
    assert.ok(entries.some((entry) => entry.profile === shipped),
      `${JSON.stringify(handover)} left the session with no controller`);
  }
});
