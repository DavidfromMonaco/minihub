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

test('reading a chosen profile answers one of two things, and never throws', () => {
  const { dir, done } = scratch();
  try {
    // `none` used to be an entry that meant "there is no entry". A list says
    // that by being empty, and the renderer answers it with the shipped profile.
    assert.deepEqual(profiles.readSelectedProfiles(dir, {}), []);

    profiles.storeProfile(dir, minimal('vega-49'));
    const [found] = profiles.readSelectedProfiles(dir, { selectedProfileFile: 'vega-49.json' });
    assert.equal(found.source, 'file');
    assert.equal(found.profile.profileId, 'vega-49');

    fs.rmSync(path.join(dir, 'vega-49.json'));
    const [gone] = profiles.readSelectedProfiles(dir, { selectedProfileFile: 'vega-49.json' });
    assert.equal(gone.source, 'unreadable');
    assert.equal(gone.fileName, 'vega-49.json', 'the file that failed is named');
    assert.ok(gone.error);

    // The boundary again, at the one call that turns a name into a path.
    assert.deepEqual(profiles.readSelectedProfiles(dir, { selectedProfileFile: '../../settings.json' }), []);
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
test('a settings write from the renderer cannot unselect a profile', () => {
  const carried = profiles.carrySelectedProfiles(
    { metronomeEnabled: true },                                  // what the renderer sends
    { selectedProfileFile: ['vega-49.json', 'minilab-3.json'] }  // what main wrote since
  );
  assert.deepEqual(carried.selectedProfileFile, ['vega-49.json', 'minilab-3.json'],
    'both keyboards come back, not just the first');
  assert.equal(carried.metronomeEnabled, true);

  const cleared = profiles.carrySelectedProfiles({ selectedProfileFile: ['stale.json'] }, {});
  assert.equal('selectedProfileFile' in cleared, false,
    'and the disk is the authority in both directions');

  // The bare string retires itself: what goes back is the normalised list, so
  // the first preference a user changes rewrites the shape on disk.
  const normalised = profiles.carrySelectedProfiles({}, { selectedProfileFile: 'vega-49.json' });
  assert.deepEqual(normalised.selectedProfileFile, ['vega-49.json']);
});

/*
 * TWO KEYBOARDS AT ONCE
 *
 * `plans/active/two-controllers-at-once.md`: a MiniLab and a BeatStep on one
 * desk are two profiles loaded together, not a choice between them. The setting
 * became a list. What must not change is that a settings file written before it,
 * holding a bare string, still names its owner's keyboard -- that file is on his
 * disk and no migration runs over it.
 */
test('a settings file written before the list still names its keyboard', () => {
  assert.deepEqual(profiles.selectedFileNames({ selectedProfileFile: 'vega-49.json' }),
    ['vega-49.json'], 'a string reads as a list of one, for ever');
  assert.deepEqual(profiles.selectedFileNames({ selectedProfileFile: ['a-one.json', 'b-two.json'] }),
    ['a-one.json', 'b-two.json']);
  assert.deepEqual(profiles.selectedFileNames({ selectedProfileFile: [] }), []);
  assert.deepEqual(profiles.selectedFileNames({}), []);
  assert.deepEqual(profiles.selectedFileNames(null), []);
  assert.equal(profiles.selectedFileName({ selectedProfileFile: ['a-one.json', 'b-two.json'] }),
    'a-one.json', 'and the first entry is what a caller that still knows of one keyboard reads');
});

test('every name in the list crosses the boundary, not only the first', () => {
  assert.deepEqual(profiles.selectedFileNames({
    selectedProfileFile: ['minilab-3.json', '../../settings.json', 'beatstep.json', 42, 'a/b.json']
  }), ['minilab-3.json', 'beatstep.json'],
    'a bad name is dropped where it sits, and the ones around it are still read');
});

test('the same profile twice is one profile', () => {
  // A profile IS its node id (D-025), so the same file listed twice would
  // register one id twice: invariant 4 forbids it, and `unregister` could not
  // undo it symmetrically (invariant 5).
  assert.deepEqual(
    profiles.selectedFileNames({ selectedProfileFile: ['vega-49.json', 'vega-49.json'] }),
    ['vega-49.json']);
});

test('the list is capped, because every entry is read before the window opens', () => {
  const many = Array.from({ length: profiles.MAX_SELECTED + 4 }, (_, i) => `dev-${i}.json`);
  assert.equal(profiles.selectedFileNames({ selectedProfileFile: many }).length, profiles.MAX_SELECTED,
    'the profiles are read synchronously on the launch path; a hand-edited list cannot hang it');
});

test('several profiles are read at once, and one bad file does not take the others', () => {
  const { dir, done } = scratch();
  try {
    profiles.storeProfile(dir, minimal('vega-49'));
    profiles.storeProfile(dir, minimal('beatstep'));
    fs.writeFileSync(path.join(dir, 'broken-one.json'), '{ not json', 'utf8');

    const read = profiles.readSelectedProfiles(dir, {
      selectedProfileFile: ['vega-49.json', 'broken-one.json', 'beatstep.json']
    });
    assert.deepEqual(read.map((entry) => entry.source), ['file', 'unreadable', 'file']);
    assert.deepEqual(read.map((entry) => entry.fileName),
      ['vega-49.json', 'broken-one.json', 'beatstep.json'],
      'the one that failed is named, so the page can say which keyboard is missing');
    assert.equal(read[0].profile.profileId, 'vega-49');
    assert.equal(read[2].profile.profileId, 'beatstep');

    // Nothing chosen is the empty list, not an entry saying so: the renderer
    // answers it with the profile that ships.
    assert.deepEqual(profiles.readSelectedProfiles(dir, {}), []);
  } finally { done(); }
});

test('a profile in use cannot be deleted, wherever it sits in the list', () => {
  const { dir, done } = scratch();
  try {
    profiles.storeProfile(dir, minimal('vega-49'));
    const refused = profiles.forgetProfile(dir, 'vega-49.json',
      { selectedProfileFile: ['minilab-3.json', 'vega-49.json'] });
    assert.equal(refused.ok, false, 'it used to be refused only when it was the first name');
    assert.equal(fs.existsSync(path.join(dir, 'vega-49.json')), true);
  } finally { done(); }
});
