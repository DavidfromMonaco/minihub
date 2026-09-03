'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * The folder MiniHub uses for each kind of file, and how it is remembered.
 *
 * Two different needs share one mechanism:
 *
 *   - a picker (export, import, project) must reopen where the user last put
 *     that kind of file, instead of making them re-navigate on every export;
 *   - a destination with no picker at all -- a recorded take is filed the
 *     instant the take ends -- must still be the user's choice, made once in
 *     Settings rather than answered again after every take.
 *
 * Each purpose keeps its own slot: one shared "last folder" would send the
 * next mixdown into the projects folder the moment a project was opened.
 *
 * This module is deliberately free of Electron so the rules can be tested with
 * node:test alone.
 */

/** Every folder MiniHub remembers. Anything else is ignored on read and write. */
const PURPOSES = Object.freeze(['project', 'audioExport', 'audioImport', 'audioRecordings']);

/** The application-settings key holding the map above. Owned by main. */
const SETTINGS_KEY = 'recentDirectories';

const isKnownPurpose = (purpose) => PURPOSES.includes(purpose);

const existsAsDirectory = (candidate) => {
  try { return fs.statSync(candidate).isDirectory(); } catch (_) { return false; }
};

/** The sanitized map: known purposes with a non-empty string, nothing else. */
function directoryMemory(settings) {
  const stored = settings && settings[SETTINGS_KEY];
  if (!stored || typeof stored !== 'object') return {};
  const memory = {};
  for (const purpose of PURPOSES) {
    const value = stored[purpose];
    if (typeof value === 'string' && value.trim() !== '') memory[purpose] = value;
  }
  return memory;
}

/**
 * The remembered folder for `purpose`, or null when there is nothing usable.
 *
 * Existence is checked rather than trusted: a folder on a disconnected drive or
 * one the user has since deleted would make `defaultPath` point nowhere, and
 * Windows then opens the dialog on an arbitrary location instead of on the
 * caller's fallback. A recorded take aimed at a vanished folder would simply
 * fail to be filed.
 */
function rememberedDirectory(settings, purpose, { isDirectory = existsAsDirectory } = {}) {
  if (!isKnownPurpose(purpose)) return null;
  const candidate = directoryMemory(settings)[purpose];
  if (!candidate) return null;
  return isDirectory(candidate) ? candidate : null;
}

/**
 * The same settings with `purpose` pointing at `directory`.
 *
 * Returns the input untouched when there is nothing to record, so a caller can
 * skip the disk write on an unchanged memory.
 */
function withDirectory(settings, purpose, directory) {
  if (!isKnownPurpose(purpose)) return settings;
  if (typeof directory !== 'string' || directory.trim() === '' || directory === '.') return settings;
  const memory = directoryMemory(settings);
  if (memory[purpose] === directory) return settings;
  return { ...settings, [SETTINGS_KEY]: { ...memory, [purpose]: directory } };
}

/** Same, from a file the user picked: what is remembered is its folder. */
function withDirectoryOfFile(settings, purpose, filePath) {
  if (typeof filePath !== 'string' || filePath.trim() === '') return settings;
  return withDirectory(settings, purpose, path.dirname(filePath));
}

/**
 * Re-impose the on-disk directory memory onto a settings object written by the
 * renderer.
 *
 * The renderer saves settings.json wholesale from the copy it loaded at
 * launch. Every folder the main process recorded after that launch is absent
 * from that copy, so an ordinary preference write would silently erase the
 * memory of every picker used during the session. Main is the only writer of
 * this key, so the file always wins.
 */
function carryDirectoryMemory(incoming, onDisk) {
  const memory = directoryMemory(onDisk);
  const settings = { ...(incoming && typeof incoming === 'object' ? incoming : {}) };
  if (Object.keys(memory).length === 0) delete settings[SETTINGS_KEY];
  else settings[SETTINGS_KEY] = memory;
  return settings;
}

module.exports = {
  PURPOSES,
  SETTINGS_KEY,
  isKnownPurpose,
  directoryMemory,
  rememberedDirectory,
  withDirectory,
  withDirectoryOfFile,
  carryDirectoryMemory
};
