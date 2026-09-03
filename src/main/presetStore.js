'use strict';

/**
 * The local preset library: which `.vstpreset` files exist on this machine, and
 * which plugin each one belongs to.
 *
 * Two kinds of location are scanned. `VST3 Presets` under the user's local data
 * and under the shared common-files directory are the layout Steinberg
 * standardised (`<root>/<Vendor>/<Plugin>/...`), which is where plugins look for
 * their own presets -- writing there is what makes a downloaded preset visible
 * inside the plugin's own browser, not just inside MiniHub. The third root is
 * MiniHub's own store, where downloads land.
 *
 * Like `projectFiles.js`, this module takes its paths instead of resolving them
 * through Electron: it stays testable with a temporary directory and no app.
 *
 * A library scan reads 48 bytes per file, never the whole file. The class id in
 * that header is the entire point -- it is what lets a Preset node offer only
 * the presets belonging to the plugin it is cabled to.
 */

const fs = require('fs');
const path = require('path');

const { readHeader, readPreset } = require('./presetFile');

/** Where a refreshed remote catalogue is remembered, so the library still has
 *  something to show with the network down (INTENT.md section 7). */
const CATALOGUE_FILE = 'catalogue.json';
const MAX_CATALOGUE_BYTES = 8 * 1024 * 1024;

const EXTENSION = '.vstpreset';
/** `<root>/<Vendor>/<Plugin>/<bank>/...` with room to spare, and no deeper: a
 *  preset tree is shallow, and an unbounded walk is how a scan meets a
 *  directory loop. */
const MAX_DEPTH = 6;
/** A scan reports at most this many presets. Far beyond a real library, and it
 *  bounds both the walk and the payload crossing the IPC boundary. */
const MAX_PRESETS = 5000;
/** No `.vstpreset` legitimately approaches this. It bounds what a single read
 *  can pull into memory. */
const MAX_FILE_BYTES = 32 * 1024 * 1024;

const fail = (reason) => ({ ok: false, reason });

/**
 * The directories a scan looks in, in the order presets should be offered.
 *
 * `userDataDir` is passed by the main process (`app.getPath('userData')`); the
 * environment fallbacks keep the module usable outside Electron.
 */
function defaultRoots({ userDataDir = null, env = process.env } = {}) {
  const roots = [];
  const userData = userDataDir
    || (env.APPDATA ? path.join(env.APPDATA, 'minilab-hub') : null);
  if (userData) roots.push({ id: 'minihub', label: 'MiniHub', dir: path.join(userData, 'presets') });
  if (env.LOCALAPPDATA) {
    roots.push({ id: 'user', label: 'User', dir: path.join(env.LOCALAPPDATA, 'VST3 Presets') });
  }
  if (env.CommonProgramFiles) {
    roots.push({ id: 'shared', label: 'Shared', dir: path.join(env.CommonProgramFiles, 'VST3 Presets') });
  }
  return roots;
}

/** Absolute, normalized, with a trailing separator so a prefix test cannot be
 *  fooled by a sibling directory whose name merely starts the same way. */
function boundary(dir) {
  const resolved = path.resolve(dir);
  return resolved.endsWith(path.sep) ? resolved : resolved + path.sep;
}

/**
 * True when `filePath` really sits inside one of the roots.
 *
 * The renderer names a preset by its path, so this is what stops a crafted
 * `..\..\` from turning "read a preset" into "read any file". The comparison is
 * case-insensitive because Windows paths are.
 */
function isInsideRoots(filePath, roots) {
  const resolved = path.resolve(filePath).toLowerCase();
  return roots.some((root) => resolved.startsWith(boundary(root.dir).toLowerCase()));
}

/** Every `.vstpreset` under `dir`, breadth-first, bounded in depth and count. */
function walkPresets(dir, remaining) {
  const found = [];
  const queue = [{ dir, depth: 0 }];
  while (queue.length > 0 && found.length < remaining) {
    const current = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch (err) {
      continue; // a root that does not exist is the normal case, not an error
    }
    for (const entry of entries) {
      if (found.length >= remaining) break;
      // Symbolic links are skipped rather than followed: they are how a walk
      // leaves the tree it was told to stay in, and how it meets a loop.
      if (entry.isSymbolicLink()) continue;
      const full = path.join(current.dir, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < MAX_DEPTH) queue.push({ dir: full, depth: current.depth + 1 });
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(EXTENSION)) {
        found.push(full);
      }
    }
  }
  return found;
}

/** The class id of a preset, read from its header alone, or null. */
function classIdOf(filePath) {
  let handle = null;
  try {
    handle = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(48);
    const read = fs.readSync(handle, header, 0, header.length, 0);
    if (read < header.length) return null;
    const result = readHeader(header);
    return result.ok ? result.header.classId : null;
  } catch (err) {
    return null;
  } finally {
    if (handle !== null) {
      try {
        fs.closeSync(handle);
      } catch (err) {
        /* the descriptor is going away with the process anyway */
      }
    }
  }
}

/**
 * List the presets on this machine, newest first within each root.
 *
 * `classId` filters to one plugin -- the Preset node's whole purpose. A file
 * whose header does not parse is skipped in silence: a stray file in a preset
 * folder is not a reason to fail the library.
 */
function listPresets({ roots = defaultRoots(), classId = null } = {}) {
  const wanted = classId === null ? null : String(classId).toUpperCase();
  const presets = [];
  for (const root of roots) {
    const rootBoundary = boundary(root.dir);
    for (const filePath of walkPresets(root.dir, MAX_PRESETS - presets.length)) {
      const id = classIdOf(filePath);
      if (!id) continue;
      if (wanted !== null && id !== wanted) continue;
      let stats;
      try {
        stats = fs.statSync(filePath);
      } catch (err) {
        continue;
      }
      // `<Vendor>/<Plugin>/...` when the file follows the standard layout.
      const relative = path.resolve(filePath).slice(rootBoundary.length).split(path.sep);
      presets.push({
        path: path.resolve(filePath),
        name: path.basename(filePath, path.extname(filePath)),
        classId: id,
        source: root.id,
        vendor: relative.length > 1 ? relative[0] : null,
        plugin: relative.length > 2 ? relative[1] : null,
        size: stats.size,
        modifiedMs: stats.mtimeMs
      });
    }
  }
  return { ok: true, presets };
}

/**
 * Read one preset and return its chunks base64-encoded, ready for
 * `loadPresetChunks`.
 *
 * The path is re-validated against the roots rather than trusted: the caller is
 * the renderer, and "read the preset at this path" must not become "read this
 * file".
 */
function readPresetChunks(filePath, { roots = defaultRoots() } = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) return fail('invalid-path');
  if (!filePath.toLowerCase().endsWith(EXTENSION)) return fail('not-a-preset-path');
  if (!isInsideRoots(filePath, roots)) return fail('outside-preset-roots');

  const resolved = path.resolve(filePath);
  let stats;
  try {
    stats = fs.statSync(resolved);
  } catch (err) {
    return fail('not-found');
  }
  if (!stats.isFile()) return fail('not-a-file');
  if (stats.size > MAX_FILE_BYTES) return fail('too-large');

  let bytes;
  try {
    bytes = fs.readFileSync(resolved);
  } catch (err) {
    return fail('unreadable');
  }

  const result = readPreset(bytes);
  if (!result.ok) return result;

  return {
    ok: true,
    classId: result.preset.classId,
    component: result.preset.component.toString('base64'),
    controller: result.preset.controller ? result.preset.controller.toString('base64') : null
  };
}

/**
 * One path segment, made safe for a name that arrived over the network.
 *
 * Anything outside a conservative set is dropped rather than escaped: a preset
 * called `..\..\Startup\evil` must become a harmless name, not a clever one.
 * A segment that ends up empty, or made only of dots, falls back.
 */
function sanitizeSegment(value, fallback) {
  const cleaned = String(value === null || value === undefined ? '' : value)
    .replace(/[^A-Za-z0-9 ._-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  if (cleaned.length === 0 || /^\.+$/.test(cleaned)) return fallback;
  return cleaned;
}

/** The root downloads are written into: MiniHub's own, never a plugin folder. */
function ownRoot(roots) {
  return roots.find((root) => root.id === 'minihub') || null;
}

/**
 * Write a downloaded preset into MiniHub's own store.
 *
 * Atomic, like every other user-file write in this application: a temporary
 * file then a rename, so an interrupted download cannot leave a half file that
 * later reads as corrupt (DECISIONS.md D-009).
 *
 * The filename comes from a remote catalogue, so every path segment is
 * sanitized and the result is checked to be inside the root before anything is
 * written -- the same containment the read path enforces.
 */
function savePresetFile({ roots = defaultRoots(), vendor, plugin, fileName, bytes } = {}) {
  const root = ownRoot(roots);
  if (!root) return fail('no-writable-root');
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) return fail('empty-content');
  if (bytes.length > MAX_FILE_BYTES) return fail('too-large');

  const safeName = sanitizeSegment(fileName, 'preset.vstpreset');
  if (!safeName.toLowerCase().includes('.')) return fail('not-a-preset-path');
  const target = path.join(
    path.resolve(root.dir),
    sanitizeSegment(vendor, 'Unknown vendor'),
    sanitizeSegment(plugin, 'Unknown plugin'),
    safeName
  );
  if (!isInsideRoots(target, [root])) return fail('outside-preset-roots');

  const temporary = `${target}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temporary, bytes);
    fs.renameSync(temporary, target);
  } catch (err) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch (cleanupErr) {
      /* nothing better to do; the write already failed */
    }
    return fail('write-failed');
  }
  return { ok: true, path: target };
}

/** The last refreshed catalogue, or an empty one. Never throws: a missing or
 *  damaged cache simply means nothing is remembered yet. */
function readCatalogueCache({ roots = defaultRoots() } = {}) {
  const root = ownRoot(roots);
  if (!root) return { ok: true, entries: [], refreshedAt: null };
  try {
    const file = path.join(path.resolve(root.dir), CATALOGUE_FILE);
    const stats = fs.statSync(file);
    if (stats.size > MAX_CATALOGUE_BYTES) return { ok: true, entries: [], refreshedAt: null };
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      ok: true,
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      refreshedAt: typeof parsed.refreshedAt === 'string' ? parsed.refreshedAt : null
    };
  } catch (err) {
    return { ok: true, entries: [], refreshedAt: null };
  }
}

/** Remember a refreshed catalogue, atomically. */
function writeCatalogueCache({ roots = defaultRoots() } = {}, entries = []) {
  const root = ownRoot(roots);
  if (!root) return fail('no-writable-root');
  const file = path.join(path.resolve(root.dir), CATALOGUE_FILE);
  const temporary = `${file}.tmp`;
  const document = JSON.stringify({
    refreshedAt: new Date().toISOString(),
    entries: Array.isArray(entries) ? entries : []
  }, null, 2);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temporary, document, 'utf8');
    fs.renameSync(temporary, file);
  } catch (err) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch (cleanupErr) {
      /* ignore */
    }
    return fail('write-failed');
  }
  return { ok: true };
}

module.exports = {
  defaultRoots,
  savePresetFile,
  sanitizeSegment,
  readCatalogueCache,
  writeCatalogueCache,
  CATALOGUE_FILE,
  listPresets,
  readPresetChunks,
  isInsideRoots,
  EXTENSION,
  MAX_DEPTH,
  MAX_PRESETS,
  MAX_FILE_BYTES
};
