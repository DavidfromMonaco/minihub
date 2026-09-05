'use strict';

/**
 * The folder of imported profiles, and the boundary around it.
 *
 * Two properties carry the weight here. The first is that a stored NAME can
 * never become a path: `selectedProfileFile` lives in a settings file a user can
 * edit, so `../../settings` must be refused on the way out as well as on the way
 * in. The second is that a profile which cannot be parsed stays visible: it is
 * the only window the user has onto this folder, and a file that vanishes from
 * the list is a file he can neither fix nor delete.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const profiles = require('../src/main/controllerProfiles.js');

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlh-profiles-'));
  return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const minimal = (profileId) => JSON.stringify({
  formatVersion: 1, profileId, revision: 1, name: `${profileId} test`, controls: []
});

test('a name that could climb out of the folder is refused', () => {
  for (const value of [
    '../settings.json', '..\\settings.json', 'a/b.json', 'a\\b.json',
    '.hidden.json', 'CAPS.json', 'no-extension', 'profile.json.exe',
    '', null, undefined, 42, 'x'.repeat(70) + '.json'
  ]) {
    assert.equal(profiles.isSafeFileName(value), false, `${JSON.stringify(value)} was accepted`);
  }
  assert.equal(profiles.isSafeFileName('minilab-3.json'), true);
  assert.equal(profiles.isSafeFileName('vega49.json'), true);
});

test('the selected name is re-checked on the way out, not only on the way in', () => {
  // settings.json is a file a user can edit; what comes back is not necessarily
  // what was written.
  assert.equal(profiles.selectedFileName({ selectedProfileFile: '../../etc/passwd' }), null);
  assert.equal(profiles.selectedFileName({ selectedProfileFile: 'vega-49.json' }), 'vega-49.json');
  assert.equal(profiles.selectedFileName({}), null);
  assert.equal(profiles.selectedFileName(null), null);
});

test('an imported profile is named after the hardware it describes', () => {
  const { dir, done } = scratch();
  try {
    const stored = profiles.storeProfile(dir, minimal('vega-49'));
    assert.equal(stored.ok, true);
    assert.equal(stored.fileName, 'vega-49.json');
    assert.equal(fs.existsSync(path.join(dir, 'vega-49.json')), true);

    // D-025: a profile is identified by the hardware, so a second import of the
    // same device is a newer version of one thing, not a second entry.
    const again = profiles.storeProfile(dir, minimal('vega-49'));
    assert.equal(again.ok, true);
    assert.equal(profiles.listProfiles(dir).length, 1);
  } finally { done(); }
});

test('what cannot become a file name is refused before anything is written', () => {
  const { dir, done } = scratch();
  try {
    for (const text of [
      '', 'not json at all', JSON.stringify({ profileId: '../escape' }),
      JSON.stringify({ profileId: 'Has Capitals' }), JSON.stringify({ name: 'no id' })
    ]) {
      const result = profiles.storeProfile(dir, text);
      assert.equal(result.ok, false, `${text.slice(0, 24)} was stored`);
      assert.ok(result.error, 'a refusal says why, or it cannot be acted on');
    }
    assert.deepEqual(profiles.listProfiles(dir), [], 'nothing reached the folder');
  } finally { done(); }
});

test('a profile too large to be a profile is refused', () => {
  const { dir, done } = scratch();
  try {
    const huge = JSON.stringify({ formatVersion: 1, profileId: 'big-one', pad: 'x'.repeat(profiles.MAX_BYTES) });
    const result = profiles.storeProfile(dir, huge);
    assert.equal(result.ok, false);
    assert.match(result.error, /not a profile/);
  } finally { done(); }
});

test('a file that will not parse is listed with its fault, not hidden', () => {
  const { dir, done } = scratch();
  try {
    profiles.storeProfile(dir, minimal('vega-49'));
    fs.writeFileSync(path.join(dir, 'broken-one.json'), '{ this is not json', 'utf8');
    // Something the folder should ignore entirely rather than report.
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello', 'utf8');

    const listed = profiles.listProfiles(dir);
    assert.deepEqual(listed.map((entry) => entry.fileName), ['broken-one.json', 'vega-49.json']);
    assert.ok(listed[0].error, 'the broken one is listed so it can be deleted or fixed');
    assert.equal(listed[1].profileId, 'vega-49');
  } finally { done(); }
});

test('reading the chosen profile answers one of three things, and never throws', () => {
  const { dir, done } = scratch();
  try {
    assert.deepEqual(profiles.readSelectedProfile(dir, {}),
      { source: 'none', fileName: null, profile: null, error: null });

    profiles.storeProfile(dir, minimal('vega-49'));
    const found = profiles.readSelectedProfile(dir, { selectedProfileFile: 'vega-49.json' });
    assert.equal(found.source, 'file');
    assert.equal(found.profile.profileId, 'vega-49');

    fs.rmSync(path.join(dir, 'vega-49.json'));
    const gone = profiles.readSelectedProfile(dir, { selectedProfileFile: 'vega-49.json' });
    assert.equal(gone.source, 'unreadable');
    assert.equal(gone.fileName, 'vega-49.json', 'the file that failed is named');
    assert.ok(gone.error);

    // The boundary again, at the one call that turns a name into a path.
    assert.equal(profiles.readSelectedProfile(dir, { selectedProfileFile: '../../settings.json' }).source, 'none');
  } finally { done(); }
});

test('the profile in use cannot be deleted out from under the next launch', () => {
  const { dir, done } = scratch();
  try {
    profiles.storeProfile(dir, minimal('vega-49'));
    const refused = profiles.forgetProfile(dir, 'vega-49.json', { selectedProfileFile: 'vega-49.json' });
    assert.equal(refused.ok, false);
    assert.equal(fs.existsSync(path.join(dir, 'vega-49.json')), true);

    const removed = profiles.forgetProfile(dir, 'vega-49.json', { selectedProfileFile: null });
    assert.equal(removed.ok, true);
    assert.equal(fs.existsSync(path.join(dir, 'vega-49.json')), false);

    assert.equal(profiles.forgetProfile(dir, '../settings.json', {}).ok, false);
  } finally { done(); }
});

/**
 * The same trap D-015 documents for the picker folders. The renderer writes the
 * whole preferences object from the copy it loaded at launch; anything main has
 * recorded since is missing from it, and would be erased.
 */
test('a settings write from the renderer cannot unselect the profile', () => {
  const carried = profiles.carrySelectedProfile(
    { metronomeEnabled: true },                       // what the renderer sends
    { selectedProfileFile: 'vega-49.json' }           // what main wrote since
  );
  assert.equal(carried.selectedProfileFile, 'vega-49.json');
  assert.equal(carried.metronomeEnabled, true);

  const cleared = profiles.carrySelectedProfile({ selectedProfileFile: 'stale.json' }, {});
  assert.equal('selectedProfileFile' in cleared, false,
    'and the disk is the authority in both directions');
});
