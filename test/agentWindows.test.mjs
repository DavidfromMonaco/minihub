import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { ModuleSystem } from '../src/renderer/js/core/moduleSystem.js';
import { EventBus } from '../src/renderer/js/core/eventBus.js';

const require = createRequire(import.meta.url);
const { ALLOWED_ENGINE_COMMANDS } = require('../src/main/engineCommandPolicy.js');
const { ClipEditorWindows } = require('../src/main/clipEditorWindows.js');

/**
 * Contract: the person chooses which window is in front, and an agent can put
 * the windows it works in on screen. DECISIONS D-040.
 *
 * The first half is a regression that came back once already in spirit: a
 * helpful "bring the plugins back" on focus reads, to the person, as a window
 * that refuses to go behind MiniHub. Nothing but a check on the source can say
 * it is gone, because the behaviour lives across three processes.
 */

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('MiniHub taking the focus sends no plugin window back in front', () => {
  const main = read('src/main/main.js');
  assert.doesNotMatch(main, /foregroundEditors/);
  assert.doesNotMatch(main, /mainWindow\.on\(\s*['"]focus['"]/, 'no focus handler on the main window at all');
  assert.equal(ALLOWED_ENGINE_COMMANDS.has('foregroundEditors'), false);
  assert.doesNotMatch(read('native/audio-engine/src/engine.cpp'), /"foregroundEditors"/,
    'the engine does not answer the command either, so nothing can revive it by sending it');
});

test('only the main process may ask the engine where a plugin page is', () => {
  // Main connects to the ports the answer names. A renderer able to send this
  // could not choose the port, but it could make main ask on its behalf.
  assert.equal(ALLOWED_ENGINE_COMMANDS.has('getEditorBrowsers'), false);
});

function modules() {
  const system = new ModuleSystem({ events: new EventBus() });
  const mounted = [];
  for (const id of ['home', 'routing']) system.register({ id, mount: () => mounted.push(id) });
  return { system, mounted };
}

test('a page can be shown without a container once pages have been shown somewhere', () => {
  const { system, mounted } = modules();
  assert.equal(system.show('routing'), false, 'before any page is on screen there is nowhere to show one');
  assert.deepEqual(mounted, []);

  const content = { innerHTML: '' };
  system.activate('home', content);
  assert.equal(system.show('routing'), true);
  assert.equal(system.activeId, 'routing');
  assert.equal(system.show('routing'), true, 'a page already on screen is shown, not refused');
  assert.deepEqual(mounted, ['home', 'routing'], 'showing the page that is already there does not mount it twice');
  assert.equal(system.show('nowhere'), false);
});

test('only clips with a live window are reported open', () => {
  const live = { isDestroyed: () => false, webContents: { isDestroyed: () => false } };
  const gone = { isDestroyed: () => true, webContents: { isDestroyed: () => true } };
  const windows = new ClipEditorWindows({ BrowserWindow: class {}, ipcMain: { handle() {} }, path: {} });
  windows.windows.set('clip-1', live);
  windows.windows.set('clip-2', gone);
  assert.deepEqual(windows.openClipIds(), ['clip-1']);
});
