'use strict';

/**
 * The local preset library.
 *
 * The scan is what makes a Preset node able to offer only what belongs to the
 * plugin it is cabled to, and `readPresetChunks` is the one place where a path
 * chosen in the renderer reaches the disk. Both are exercised against a real
 * temporary tree rather than a mocked filesystem, because what is being checked
 * -- directory walking, path containment, header reads -- is exactly the part a
 * mock would define away.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { writePreset } = require('../src/main/presetFile.js');
const {
  defaultRoots,
  listPresets,
  readPresetChunks,
  isInsideRoots,
  savePresetFile,
  sanitizeSegment,
  readCatalogueCache,
  writeCatalogueCache,
  MAX_DEPTH
} = require('../src/main/presetStore.js');

const MASSIVE = '5653544E6924486D6173736976652078';
const DEXED = 'ABCDEF019182FAEB4447534244657864';

function tempTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minihub-presets-'));
  return { dir, roots: [{ id: 'user', label: 'User', dir }] };
}

function putPreset(root, relative, classId, component = 'state') {
  const full = path.join(root, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const written = writePreset({ classId, component: Buffer.from(component, 'latin1') });
  assert.equal(written.ok, true, written.reason);
  fs.writeFileSync(full, written.buffer);
  return full;
}

// ---- Where a scan looks -----------------------------------------------------

test('the default roots follow the Steinberg layout plus MiniHub own store', () => {
  const roots = defaultRoots({
    env: { APPDATA: 'C:/AppData', LOCALAPPDATA: 'C:/Local', CommonProgramFiles: 'C:/Common' }
  });
  const byId = Object.fromEntries(roots.map((r) => [r.id, r.dir]));
  assert.equal(byId.minihub, path.join('C:/AppData', 'minilab-hub', 'presets'));
  assert.equal(byId.user, path.join('C:/Local', 'VST3 Presets'));
  assert.equal(byId.shared, path.join('C:/Common', 'VST3 Presets'));
});

test('an explicit userData directory wins over the environment', () => {
  const roots = defaultRoots({ userDataDir: 'D:/elsewhere', env: { APPDATA: 'C:/AppData' } });
  assert.equal(roots[0].dir, path.join('D:/elsewhere', 'presets'));
});

test('a root that does not exist yields nothing, not a failure', () => {
  // The normal state of a fresh machine: the folders are simply not there.
  const result = listPresets({ roots: [{ id: 'user', label: 'User', dir: 'Z:/nope/never' }] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.presets, []);
});

// ---- What a scan reports ----------------------------------------------------

test('presets are found with their class id, vendor and plugin', () => {
  const { dir, roots } = tempTree();
  try {
    putPreset(dir, path.join('Native Instruments', 'Massive X', 'Deep Bass.vstpreset'), MASSIVE);
    const { presets } = listPresets({ roots });

    assert.equal(presets.length, 1);
    assert.equal(presets[0].name, 'Deep Bass');
    assert.equal(presets[0].classId, MASSIVE);
    assert.equal(presets[0].vendor, 'Native Instruments');
    assert.equal(presets[0].plugin, 'Massive X');
    assert.equal(presets[0].source, 'user');
    assert.ok(presets[0].size > 48);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('filtering by class id is what a Preset node cables to', () => {
  const { dir, roots } = tempTree();
  try {
    putPreset(dir, path.join('NI', 'Massive X', 'a.vstpreset'), MASSIVE);
    putPreset(dir, path.join('NI', 'Massive X', 'b.vstpreset'), MASSIVE);
    putPreset(dir, path.join('DS', 'Dexed', 'c.vstpreset'), DEXED);

    assert.equal(listPresets({ roots }).presets.length, 3);
    const massive = listPresets({ roots, classId: MASSIVE }).presets;
    assert.equal(massive.length, 2);
    assert.ok(massive.every((p) => p.classId === MASSIVE));
    // Case is not the caller's problem.
    assert.equal(listPresets({ roots, classId: DEXED.toLowerCase() }).presets.length, 1);
    assert.equal(listPresets({ roots, classId: 'F'.repeat(32) }).presets.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('files that are not readable presets are skipped, not fatal', () => {
  const { dir, roots } = tempTree();
  try {
    putPreset(dir, path.join('NI', 'Massive X', 'good.vstpreset'), MASSIVE);
    fs.writeFileSync(path.join(dir, 'NI', 'Massive X', 'readme.txt'), 'not a preset');
    fs.writeFileSync(path.join(dir, 'NI', 'Massive X', 'broken.vstpreset'), 'garbage');
    fs.writeFileSync(path.join(dir, 'NI', 'Massive X', 'tiny.vstpreset'), Buffer.alloc(4));

    const { presets } = listPresets({ roots });
    assert.equal(presets.length, 1, 'only the real preset is offered');
    assert.equal(presets[0].name, 'good');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the walk stops at a bounded depth', () => {
  const { dir, roots } = tempTree();
  try {
    const shallow = path.join('a', 'b', 'shallow.vstpreset');
    const deep = path.join(...Array(MAX_DEPTH + 3).fill('d'), 'deep.vstpreset');
    putPreset(dir, shallow, MASSIVE);
    putPreset(dir, deep, MASSIVE);

    const names = listPresets({ roots }).presets.map((p) => p.name);
    assert.ok(names.includes('shallow'));
    assert.ok(!names.includes('deep'), 'an unbounded walk is how a scan meets a loop');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Reading one preset -----------------------------------------------------

test('a preset reads back as base64 chunks ready for the engine', () => {
  const { dir, roots } = tempTree();
  try {
    const file = putPreset(dir, path.join('NI', 'Massive X', 'p.vstpreset'), MASSIVE, 'component-bytes');
    const result = readPresetChunks(file, { roots });

    assert.equal(result.ok, true, result.reason);
    assert.equal(result.classId, MASSIVE);
    assert.equal(Buffer.from(result.component, 'base64').toString('latin1'), 'component-bytes');
    assert.equal(result.controller, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a path outside the roots is refused, however it is spelled', () => {
  const { dir, roots } = tempTree();
  const outside = path.join(os.tmpdir(), 'minihub-outside.vstpreset');
  try {
    const written = writePreset({ classId: MASSIVE, component: Buffer.from('x') });
    fs.writeFileSync(outside, written.buffer);

    assert.equal(readPresetChunks(outside, { roots }).reason, 'outside-preset-roots');

    // The traversal that a naive prefix check would let through.
    const traversal = path.join(dir, '..', path.basename(outside));
    assert.equal(readPresetChunks(traversal, { roots }).reason, 'outside-preset-roots');

    // A sibling directory whose name merely starts like the root.
    assert.equal(isInsideRoots(dir + '-evil/x.vstpreset', roots), false);
    assert.equal(isInsideRoots(path.join(dir, 'x.vstpreset'), roots), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  }
});

test('only a .vstpreset path is ever opened', () => {
  const { dir, roots } = tempTree();
  try {
    const secret = path.join(dir, 'settings.json');
    fs.writeFileSync(secret, '{"secret":true}');
    assert.equal(readPresetChunks(secret, { roots }).reason, 'not-a-preset-path');
    assert.equal(readPresetChunks('', { roots }).reason, 'invalid-path');
    assert.equal(readPresetChunks(null, { roots }).reason, 'invalid-path');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing file, a directory and a corrupt preset each answer with a reason', () => {
  const { dir, roots } = tempTree();
  try {
    assert.equal(readPresetChunks(path.join(dir, 'gone.vstpreset'), { roots }).reason, 'not-found');

    const asDirectory = path.join(dir, 'folder.vstpreset');
    fs.mkdirSync(asDirectory);
    assert.equal(readPresetChunks(asDirectory, { roots }).reason, 'not-a-file');

    const corrupt = path.join(dir, 'corrupt.vstpreset');
    fs.writeFileSync(corrupt, Buffer.alloc(64));
    assert.equal(readPresetChunks(corrupt, { roots }).reason, 'not-a-vstpreset');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Writing a download -----------------------------------------------------

test('a name from the network becomes a harmless path segment', () => {
  // Written without escapes on purpose: what is being tested is a literal
  // backslash, and an escaped one in the source is a different string.
  const BS = String.fromCharCode(92);
  const climb = `..${BS}..${BS}Startup${BS}evil`;

  // Separators become spaces, so what was structure becomes one plain name.
  const cleaned = sanitizeSegment(climb, 'fallback');
  assert.ok(!cleaned.includes(BS) && !cleaned.includes('/'), 'no separator survives');
  assert.equal(cleaned, '.. .. Startup evil');
  assert.equal(sanitizeSegment('../../etc/passwd', 'fallback'), '.. .. etc passwd');
  assert.equal(sanitizeSegment('C:/absolute', 'fallback'), 'C absolute');

  // A segment that is nothing but dots would still name a parent directory.
  assert.equal(sanitizeSegment('..', 'fallback'), 'fallback');
  assert.equal(sanitizeSegment('...', 'fallback'), 'fallback');
  assert.equal(sanitizeSegment('', 'fallback'), 'fallback');
  assert.equal(sanitizeSegment(null, 'fallback'), 'fallback');

  assert.equal(sanitizeSegment('Deep Bass.vstpreset', 'x'), 'Deep Bass.vstpreset');
  assert.equal(sanitizeSegment('a'.repeat(200), 'x').length, 80);
});

test('a download is written atomically inside MiniHub own root', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minihub-store-'));
  const roots = [{ id: 'minihub', label: 'MiniHub', dir }];
  try {
    const written = writePreset({ classId: MASSIVE, component: Buffer.from('bytes') });
    const result = savePresetFile({
      roots, vendor: 'NI', plugin: 'Massive X', fileName: 'Deep Bass.vstpreset', bytes: written.buffer
    });

    assert.equal(result.ok, true, result.reason);
    assert.equal(result.path, path.join(dir, 'NI', 'Massive X', 'Deep Bass.vstpreset'));
    assert.equal(fs.existsSync(result.path), true);
    // No temporary file survives a successful write.
    assert.equal(fs.existsSync(`${result.path}.tmp`), false);
    // And the scan picks it up immediately.
    assert.equal(listPresets({ roots, classId: MASSIVE }).presets.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a hostile file name cannot escape the store', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minihub-store-'));
  const roots = [{ id: 'minihub', label: 'MiniHub', dir }];
  try {
    const result = savePresetFile({
      roots,
      vendor: '..',
      plugin: '../../..',
      fileName: '../../../evil.vstpreset',
      bytes: Buffer.from('x')
    });
    assert.equal(result.ok, true, result.reason);
    assert.equal(isInsideRoots(result.path, roots), true, 'the write stayed inside the root');
    // Exactly three segments below the root: vendor, plugin, file. The climbing
    // was flattened into names, not honoured as structure.
    const below = path.relative(dir, result.path).split(path.sep);
    assert.equal(below.length, 3);
    assert.ok(below.every((segment) => segment !== '..'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty or extensionless download is refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minihub-store-'));
  const roots = [{ id: 'minihub', label: 'MiniHub', dir }];
  try {
    assert.equal(savePresetFile({ roots, fileName: 'a.vstpreset', bytes: Buffer.alloc(0) }).reason, 'empty-content');
    assert.equal(savePresetFile({ roots, fileName: 'a.vstpreset' }).reason, 'empty-content');
    assert.equal(savePresetFile({ roots, fileName: 'noextension', bytes: Buffer.from('x') }).reason, 'not-a-preset-path');
    // Downloads never land in a plugin folder; only MiniHub own root is writable.
    const readOnly = [{ id: 'user', label: 'User', dir }];
    assert.equal(savePresetFile({ roots: readOnly, fileName: 'a.vstpreset', bytes: Buffer.from('x') }).reason, 'no-writable-root');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Remembering a catalogue ------------------------------------------------

test('a refreshed catalogue survives so the library works offline', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minihub-store-'));
  const roots = [{ id: 'minihub', label: 'MiniHub', dir }];
  try {
    assert.deepEqual(readCatalogueCache({ roots }).entries, [], 'nothing remembered yet');

    const entries = [{ name: 'Deep', url: 'https://example.org/a.vstpreset', classId: MASSIVE }];
    assert.equal(writeCatalogueCache({ roots }, entries).ok, true);

    const back = readCatalogueCache({ roots });
    assert.deepEqual(back.entries, entries);
    assert.match(back.refreshedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(fs.existsSync(path.join(dir, 'catalogue.json.tmp')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a damaged cache reads as empty rather than throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minihub-store-'));
  const roots = [{ id: 'minihub', label: 'MiniHub', dir }];
  try {
    fs.writeFileSync(path.join(dir, 'catalogue.json'), 'not json at all');
    const back = readCatalogueCache({ roots });
    assert.deepEqual(back.entries, []);
    assert.equal(back.refreshedAt, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
