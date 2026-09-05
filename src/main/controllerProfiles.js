'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * The profiles a user has imported, and the one that is loaded.
 *
 * A controller profile is a JSON file describing a keyboard: what its controls
 * send, and where they sit. One ships with the application; this module owns the
 * others -- the ones written by hand, or fetched from the catalogue the site will
 * hold.
 *
 * WHY THEY LIVE IN userData AND NOT IN A FOLDER THE USER PICKS
 * -----------------------------------------------------------
 * DECISIONS.md D-015 says no file lands in a folder the user has not chosen, and
 * that rule is about the user's OWN files: recordings, exports, projects. A
 * profile is not one of those. It is configuration, it is read at every launch,
 * and it sits next to `settings.json` for the same reason `settings.json` does --
 * a profile stored on a disconnected drive is a MiniHub that starts without a
 * controller. Importing COPIES the file, so moving or deleting the original
 * changes nothing.
 *
 * WHY THE SETTING HOLDS NAMES AND NEVER PATHS
 * -------------------------------------------
 * `selectedProfileFile` holds bare file names, and `isSafeFileName` is what makes
 * that a boundary rather than a convention: a stored value of `../../settings`
 * would otherwise be joined onto the profiles folder and read whatever it liked.
 * Every name is checked on the way in and again on the way out, because the file
 * that produced it and the file that reads it are separated by a settings file a
 * user can edit.
 *
 * WHY IT IS A LIST, AND WHY THE KEY IS STILL SINGULAR
 * ---------------------------------------------------
 * Two keyboards on one desk are two profiles loaded at once, not a choice between
 * them -- `plans/active/two-controllers-at-once.md`. The value is therefore a list
 * of names, and `selectedFileNames` is the single place that reads it.
 *
 * The KEY did not follow. It is on the disk of everyone who has ever chosen a
 * profile, and renaming it would silently unselect their keyboard: the same
 * reason AGENTS.md section 2 keeps `%APPDATA%/minilab-hub/` under a name nobody
 * would pick today. A bare string left there by an older version reads as a list
 * of one, for ever, and is rewritten as a list the next time anything is saved.
 *
 * This module is deliberately free of Electron, like `recentDirectories.js`, so
 * every rule here can be tested with node:test alone. The caller supplies the
 * folder.
 */

/** The application-settings key holding the chosen file's NAME. Owned by main. */
const SETTINGS_KEY = 'selectedProfileFile';

/**
 * A profile is a description, not a payload. The format bounds what it may
 * contain -- 512 controls, 32 bindings each -- which lands well under this; the
 * cap exists so that a file chosen by mistake is refused before it is read into
 * memory rather than after.
 */
const MAX_BYTES = 1024 * 1024;

/**
 * How many profiles may be loaded at once.
 *
 * Not a matter of taste: every selected profile is read SYNCHRONOUSLY on the
 * `profile:current` channel, before the renderer's first module evaluates, so
 * this list sits on the critical path of every launch. A settings file
 * hand-edited to hold two hundred names would be a MiniHub that takes a minute
 * to show a window. Eight is more controllers than there are hands.
 */
const MAX_SELECTED = 8;

/**
 * Names this module will touch: what a profile id can be, plus `.json`.
 *
 * Deliberately narrower than the filesystem allows. No separator, no `..`, no
 * leading dot, no case -- so a name cannot climb out of the folder, cannot
 * collide with itself on a case-insensitive volume, and cannot hide.
 */
const FILE_NAME_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*\.json$/;

function isSafeFileName(value) {
  return typeof value === 'string'
    && value.length > 0 && value.length <= 69 // 64 for the id, plus '.json'
    && FILE_NAME_SHAPE.test(value)
    && !value.includes(path.sep)
    && path.basename(value) === value;
}

/** `vega-49` -> `vega-49.json`, or null when the id could never be a file name. */
function fileNameForProfileId(profileId) {
  if (typeof profileId !== 'string') return null;
  const candidate = `${profileId}.json`;
  return isSafeFileName(candidate) ? candidate : null;
}

/**
 * The chosen file names, in the order they were chosen. Always an array.
 *
 * Re-checked here: settings.json is a file a user can edit, and what comes back
 * is not necessarily what was written. Duplicates are dropped rather than
 * tolerated -- a profile IS its node id (D-025), so the same file twice would
 * register one id twice, which invariant 4 forbids and `unregister` could not
 * undo symmetrically.
 */
function selectedFileNames(settings) {
  const value = settings && settings[SETTINGS_KEY];
  const raw = typeof value === 'string' ? [value] : (Array.isArray(value) ? value : []);
  const names = [];
  for (const name of raw) {
    if (!isSafeFileName(name) || names.includes(name)) continue;
    names.push(name);
    if (names.length === MAX_SELECTED) break;
  }
  return names;
}

/** The first chosen name, or null: what the callers that still know of one
 *  controller read. They go away as the rest of the workstream lands. */
function selectedFileName(settings) {
  return selectedFileNames(settings)[0] ?? null;
}

function ensureDirectory(profilesDir) {
  fs.mkdirSync(profilesDir, { recursive: true });
  return profilesDir;
}

/**
 * What is in the folder, newest information first: the file name, and whatever
 * of the profile's own identity can be read out of it.
 *
 * A file that will not parse is LISTED, with its error, rather than skipped. A
 * profile that silently disappears from the list is a profile the user cannot
 * delete and cannot fix, and he has no other window onto this folder.
 */
function listProfiles(profilesDir) {
  let names;
  try {
    names = fs.readdirSync(profilesDir);
  } catch (_) {
    return [];
  }
  const profiles = [];
  for (const fileName of names.slice().sort()) {
    if (!isSafeFileName(fileName)) continue;
    const entry = { fileName, profileId: null, name: null, controls: null, error: null };
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(profilesDir, fileName), 'utf8'));
      entry.profileId = typeof parsed?.profileId === 'string' ? parsed.profileId : null;
      entry.name = typeof parsed?.name === 'string' ? parsed.name : null;
      entry.controls = Array.isArray(parsed?.controls) ? parsed.controls.length : null;
    } catch (error) {
      entry.error = error.message;
    }
    profiles.push(entry);
  }
  return profiles;
}

/**
 * Read one profile for handover to the renderer.
 *
 * `source` is what the renderer's `resolveProfile` knows, and the distinction is
 * what lets the controller page say why a keyboard is not the one asked for:
 * `file` (here it is) or `unreadable` (chosen, and gone or not JSON).
 *
 * Nothing is validated here. `src/main/` is CommonJS and cannot import the
 * validator, which is an ES module the `module boundary` rule keeps that way --
 * so main reads bytes and the renderer judges them.
 */
function readProfileFile(profilesDir, fileName) {
  const file = path.join(profilesDir, fileName);
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return { source: 'unreadable', fileName, profile: null, error: 'not a file' };
    if (stat.size > MAX_BYTES) {
      return { source: 'unreadable', fileName, profile: null, error: `larger than ${MAX_BYTES} bytes` };
    }
    return { source: 'file', fileName, profile: JSON.parse(fs.readFileSync(file, 'utf8')), error: null };
  } catch (error) {
    return { source: 'unreadable', fileName, profile: null, error: error.message };
  }
}

/**
 * Every chosen profile, one entry each, in the order they were chosen.
 *
 * `none` is not an entry: an entry exists BECAUSE a name was chosen, so "nothing
 * chosen" is the empty list, which the renderer answers with the profile that
 * ships. One unreadable file among several does not take the others down with
 * it -- it comes back as its own `unreadable` entry, named, so the page can say
 * which keyboard is missing rather than showing one node fewer and no reason.
 */
function readSelectedProfiles(profilesDir, settings) {
  return selectedFileNames(settings).map((fileName) => readProfileFile(profilesDir, fileName));
}


/**
 * Write an imported profile into the folder, under its own identity.
 *
 * `text` is the file exactly as the user chose it, and it is what gets written:
 * re-serialising would hand back a file that is no longer byte for byte the one
 * he can compare against the catalogue. It is parsed all the same, because the
 * name comes from `profileId` and a name taken from unparsed text is a name
 * taken on trust.
 *
 * Importing the same device twice REPLACES it. A profile is identified by the
 * hardware it describes (D-025), so two files claiming `minilab-3` are two
 * versions of one thing, and keeping both would leave the user choosing between
 * two identical-looking entries.
 */
function storeProfile(profilesDir, text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { ok: false, error: 'nothing to import' };
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) {
    return { ok: false, error: `a profile larger than ${MAX_BYTES} bytes is not a profile` };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `not JSON: ${error.message}` };
  }
  const fileName = fileNameForProfileId(parsed?.profileId);
  if (!fileName) {
    return { ok: false, error: 'the profile declares no usable profileId' };
  }
  try {
    ensureDirectory(profilesDir);
    fs.writeFileSync(path.join(profilesDir, fileName), text, 'utf8');
  } catch (error) {
    return { ok: false, error: error.message };
  }
  return { ok: true, fileName, profileId: parsed.profileId };
}

/**
 * Delete an imported profile.
 *
 * Refuses any profile currently selected: removing a file the next launch is
 * going to read means coming back without that keyboard and with no explanation,
 * and the user who asked for a deletion did not ask for that. It is unselected
 * first -- which, with a list, no longer means choosing a replacement for it.
 */
function forgetProfile(profilesDir, fileName, settings) {
  if (!isSafeFileName(fileName)) return { ok: false, error: 'not a profile file name' };
  if (selectedFileNames(settings).includes(fileName)) {
    return { ok: false, error: 'this profile is in use; unselect it first' };
  }
  try {
    fs.rmSync(path.join(profilesDir, fileName), { force: true });
  } catch (error) {
    return { ok: false, error: error.message };
  }
  return { ok: true, fileName };
}

/**
 * Carry the chosen profiles across a settings write that came from the renderer.
 *
 * The same trap D-015 documents for the picker folders, and for the same reason:
 * the renderer writes the whole preferences object from the copy it loaded at
 * launch, where anything main has recorded SINCE does not exist. An import
 * followed by any preference change would silently unselect the profile that was
 * just imported -- and the user would find his keyboard back to a MiniLab 3 with
 * nothing to explain it.
 *
 * What goes back is the NORMALISED list and not the raw stored value, which is
 * what quietly retires the bare string: the first preference a user changes
 * rewrites it as a list, and nothing reads it as a string again.
 */
function carrySelectedProfiles(incoming, onDisk) {
  const settings = { ...(incoming && typeof incoming === 'object' ? incoming : {}) };
  const chosen = selectedFileNames(onDisk);
  if (chosen.length === 0) delete settings[SETTINGS_KEY];
  else settings[SETTINGS_KEY] = chosen;
  return settings;
}

module.exports = {
  SETTINGS_KEY,
  MAX_BYTES,
  MAX_SELECTED,
  isSafeFileName,
  fileNameForProfileId,
  selectedFileName,
  selectedFileNames,
  ensureDirectory,
  listProfiles,
  readSelectedProfiles,
  storeProfile,
  forgetProfile,
  carrySelectedProfiles
};
