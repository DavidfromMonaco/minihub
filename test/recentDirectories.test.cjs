'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  PURPOSES,
  SETTINGS_KEY,
  rememberedDirectory,
  withDirectory,
  withDirectoryOfFile,
  carryDirectoryMemory
} = require('../src/main/recentDirectories');

const anywhere = () => true;
const nowhere = () => false;

test('each kind of file keeps its own folder', () => {
  let settings = { selectedInputId: 'port-1' };
  settings = withDirectoryOfFile(settings, 'project', 'D:/Music/Sets/Live.minihub');
  settings = withDirectoryOfFile(settings, 'audioExport', 'E:/Bounces/Live Mix.wav');
  settings = withDirectory(settings, 'audioRecordings', 'E:/Takes');

  assert.equal(rememberedDirectory(settings, 'project', { isDirectory: anywhere }), 'D:/Music/Sets');
  assert.equal(rememberedDirectory(settings, 'audioExport', { isDirectory: anywhere }), 'E:/Bounces');
  assert.equal(rememberedDirectory(settings, 'audioRecordings', { isDirectory: anywhere }), 'E:/Takes');
  assert.equal(rememberedDirectory(settings, 'audioImport', { isDirectory: anywhere }), null,
    'an unused picker still opens on its own default');
  assert.equal(settings.selectedInputId, 'port-1', 'unrelated preferences are untouched');
});

test('a folder chosen as a folder is kept whole, not reduced to its parent', () => {
  // The recordings folder is chosen in Settings, not derived from a saved file.
  // Running it through the file path rule would file every take one level up.
  const chosen = withDirectory({}, 'audioRecordings', 'E:/Takes/Session 4');
  assert.equal(rememberedDirectory(chosen, 'audioRecordings', { isDirectory: anywhere }), 'E:/Takes/Session 4');

  const fromFile = withDirectoryOfFile({}, 'audioRecordings', 'E:/Takes/Session 4/take.wav');
  assert.equal(rememberedDirectory(fromFile, 'audioRecordings', { isDirectory: anywhere }), 'E:/Takes/Session 4');
});

test('a folder that no longer exists falls back instead of pointing the dialog nowhere', () => {
  const settings = withDirectoryOfFile({}, 'audioExport', 'X:/Removed Drive/Mix.wav');
  assert.equal(rememberedDirectory(settings, 'audioExport', { isDirectory: anywhere }), 'X:/Removed Drive');
  assert.equal(rememberedDirectory(settings, 'audioExport', { isDirectory: nowhere }), null);
});

test('nothing worth writing leaves the settings object identical', () => {
  const settings = withDirectoryOfFile({}, 'project', 'C:/Projects/Session.minihub');
  assert.equal(withDirectoryOfFile(settings, 'project', 'C:/Projects/Other.minihub'), settings,
    'the same folder twice does not rewrite settings.json');
  assert.equal(withDirectoryOfFile(settings, 'exports', 'C:/Elsewhere/Mix.wav'), settings,
    'an unknown purpose is ignored rather than stored');
  assert.equal(withDirectoryOfFile(settings, 'project', null), settings);
  assert.equal(withDirectoryOfFile(settings, 'project', ''), settings);
  assert.equal(withDirectory(settings, 'project', ''), settings);
  assert.equal(withDirectory(settings, 'project', '.'), settings);
  assert.equal(rememberedDirectory(settings, 'exports', { isDirectory: anywhere }), null);
});

test('a corrupted memory is read as no memory at all', () => {
  for (const stored of [null, 'C:/Projects', 42, { project: 17 }, { project: '  ' }, { unknown: 'C:/x' }]) {
    assert.equal(rememberedDirectory({ [SETTINGS_KEY]: stored }, 'project', { isDirectory: anywhere }), null);
  }
});

test('a renderer settings write cannot erase folders recorded after it loaded', () => {
  // The renderer saves the whole preferences object from the copy it took at
  // launch. Every picker used since then is missing from that copy.
  const onDisk = withDirectoryOfFile({}, 'audioExport', 'E:/Bounces/Mix.wav');
  const fromRenderer = { selectedInputId: 'port-1', metronomeVolume: 0.5 };

  const merged = carryDirectoryMemory(fromRenderer, onDisk);
  assert.deepEqual(merged[SETTINGS_KEY], { audioExport: 'E:/Bounces' });
  assert.equal(merged.metronomeVolume, 0.5);
  assert.equal(fromRenderer[SETTINGS_KEY], undefined, 'the caller object is not mutated');

  const stale = { [SETTINGS_KEY]: { audioExport: 'C:/Users/Public/Music' } };
  assert.deepEqual(carryDirectoryMemory(stale, onDisk)[SETTINGS_KEY], { audioExport: 'E:/Bounces' },
    'the file wins: the main process is the only writer of this key');
  assert.equal(carryDirectoryMemory(stale, {})[SETTINGS_KEY], undefined,
    'with nothing on disk the key is dropped rather than resurrected from the renderer');
});

test('a new project cannot reset where the last one was saved', () => {
  // Creating a project reloads the renderer, which then rewrites the whole
  // preferences object with every project key deleted -- and with no idea a
  // folder was chosen since it loaded. The folder memory is application state,
  // not project state: it has to come through that reload untouched.
  const onDisk = withDirectoryOfFile({}, 'project', 'D:/Sets/Live Set.minihub');
  const rendererAfterNewProject = { selectedInputId: 'input-2', recentProjectPath: null };

  const written = carryDirectoryMemory(rendererAfterNewProject, onDisk);
  assert.equal(rememberedDirectory(written, 'project', { isDirectory: anywhere }), 'D:/Sets',
    'the Save dialog of a brand-new project still opens where the user last saved');
});

test('main resolves and records every folder it offers', () => {
  const main = fs.readFileSync(path.resolve(__dirname, '../src/main/main.js'), 'utf8');
  const handlerFor = (channel) => {
    const start = main.indexOf(channel);
    assert.ok(start >= 0, `${channel} is gone`);
    return main.slice(start, main.indexOf("ipcMain.handle('", start + 1));
  };

  for (const [channel, purpose] of [
    ["ipcMain.handle('project:pick-open'", 'project'],
    ["ipcMain.handle('project:pick-save'", 'project'],
    ["ipcMain.handle('audio:pick-save'", 'audioExport'],
    ["ipcMain.handle('audio:pick-open'", 'audioImport']
  ]) {
    const handler = handlerFor(channel);
    assert.ok(handler.includes(`effectiveDirectory('${purpose}'`),
      `${channel} must open on the folder currently used for ${purpose}`);
    assert.ok(handler.includes(`rememberDirectoryOfFile('${purpose}'`),
      `${channel} must record the folder the user chose for ${purpose}`);
  }

  // A recorded take has no picker: it is filed the instant the take ends. Its
  // folder must still be the user's, which is exactly what a hard-coded path
  // in this handler would quietly take away again.
  const commit = handlerFor("ipcMain.handle('audio:commit-take'");
  assert.ok(commit.includes("effectiveDirectory('audioRecordings')"),
    'a take must be filed in the folder the user chose');
  assert.ok(!/getPath\('music'\)/.test(commit),
    'the take handler must not reach for a built-in folder of its own');

  const choose = handlerFor("ipcMain.handle('directories:choose'");
  assert.ok(choose.includes('isKnownPurpose(purpose)'), 'the renderer cannot name an arbitrary purpose');
  assert.ok(choose.includes("properties: ['openDirectory', 'createDirectory']"),
    'choosing a destination means choosing a folder, and being able to make one');
  assert.ok(choose.includes('rememberDirectory(purpose,'), 'the chosen folder has to outlive the dialog');

  // The built-in folders are starting points; each must be replaceable.
  const fallback = main.slice(main.indexOf('function fallbackDirectory'), main.indexOf('function effectiveDirectory'));
  assert.match(fallback, /'MiniHub Recordings'/, 'takes still have a sensible first-run folder');
  assert.equal(PURPOSES.length, 4, 'a new purpose needs its handler covered above');
});
