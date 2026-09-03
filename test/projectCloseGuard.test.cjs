'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { installProjectCloseGuard } = require('../src/main/projectCloseGuard');

class FakeWindow extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.closeAttempts = 0;
  }
  isDestroyed() { return this.destroyed; }
  close() {
    this.closeAttempts += 1;
    let prevented = false;
    this.emit('close', { preventDefault() { prevented = true; } });
    if (!prevented) {
      this.destroyed = true;
      this.emit('closed');
    }
    return !prevented;
  }
}

/** Let the close decision -- dialogs, save round trip -- run to completion. */
const settle = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** A guard wired to recording stubs, so each test asserts on what was asked. */
function harness({ responses = [], save = async () => ({ ok: true }) } = {}) {
  const window = new FakeWindow();
  const dialogs = [];
  const saves = [];
  const guard = installProjectCloseGuard({
    window,
    dialog: {
      async showMessageBox(_window, options) {
        dialogs.push(options);
        return { response: responses[dialogs.length - 1] ?? 0 };
      }
    },
    requestSave: async (mode) => {
      saves.push(mode);
      return save(mode);
    }
  });
  return { window, guard, dialogs, saves };
}

test('a clean project closes with no dialog and no save', async () => {
  const { window, guard, dialogs, saves } = harness();
  guard.setProjectState({ dirty: false, hasFile: true, name: 'Clean' });

  assert.equal(window.close(), true);
  await settle();
  assert.equal(window.destroyed, true);
  assert.deepEqual(dialogs, []);
  assert.deepEqual(saves, []);
});

test('a dirty project with a file on disk is saved on the way out, silently', async () => {
  const { window, guard, dialogs, saves } = harness();
  guard.setProjectState({ dirty: true, hasFile: true, name: 'Session 4' });

  assert.equal(window.close(), false, 'the operating-system close waits for the save');
  await settle();
  assert.deepEqual(saves, ['save'], 'exactly one save, and no Save As picker');
  assert.deepEqual(dialogs, [], 'a project that has a home never asks anything');
  assert.equal(window.destroyed, true);
  assert.equal(window.closeAttempts, 2, 'one user attempt plus the authorized close');
  assert.equal(guard.isDirty(), false);
});

test('a project that has never been saved asks, and Cancel keeps the window alive', async () => {
  const { window, guard, dialogs, saves } = harness({ responses: [2] });
  guard.setProjectState({ dirty: true, hasFile: false, name: 'Untitled' });

  assert.equal(window.close(), false);
  await settle();
  assert.equal(window.destroyed, false);
  assert.equal(guard.isDirty(), true, 'a cancelled close leaves the project unsaved, not clean');
  assert.deepEqual(saves, [], 'Cancel writes nothing');
  assert.equal(dialogs.length, 1);
  assert.deepEqual(dialogs[0].buttons, ['Save…', 'Quit without saving', 'Cancel']);
  assert.equal(dialogs[0].defaultId, 0, 'saving is the default, losing the project is not');
  assert.equal(dialogs[0].cancelId, 2);
  assert.match(dialogs[0].message, /Untitled/);
});

test('Quit without saving closes an unsaved project without writing it', async () => {
  const { window, guard, saves } = harness({ responses: [1] });
  guard.setProjectState({ dirty: true, hasFile: false, name: 'Untitled' });

  assert.equal(window.close(), false);
  await settle();
  assert.equal(window.destroyed, true);
  assert.deepEqual(saves, []);
});

test('Save on an unsaved project runs the picker, and dismissing it aborts the close', async () => {
  const { window, guard, dialogs, saves } = harness({
    responses: [0], save: async () => ({ ok: false, reason: 'cancelled' })
  });
  guard.setProjectState({ dirty: true, hasFile: false, name: 'Untitled' });

  assert.equal(window.close(), false);
  await settle();
  assert.deepEqual(saves, ['save-as']);
  assert.equal(window.destroyed, false, 'dismissing the picker is a step back into the app');
  assert.equal(guard.isDirty(), true);
  assert.equal(dialogs.length, 1, 'no second dialog is stacked on a cancelled picker');
});

test('a failed save never closes silently: the loss has to be confirmed', async () => {
  const { window, guard, dialogs, saves } = harness({
    responses: [1], save: async () => ({ ok: false, reason: 'Disk full.' })
  });
  guard.setProjectState({ dirty: true, hasFile: true, name: 'Session 4' });

  assert.equal(window.close(), false);
  await settle();
  assert.deepEqual(saves, ['save']);
  assert.equal(dialogs.length, 1);
  assert.deepEqual(dialogs[0].buttons, ['Close without saving', 'Cancel']);
  assert.equal(dialogs[0].defaultId, 1, 'the default is to keep the project, not to lose it');
  assert.match(dialogs[0].detail, /Disk full\./);
  assert.equal(window.destroyed, false, 'Cancel on that dialog keeps the project open');
  assert.equal(guard.isDirty(), true);
});

test('a renderer that never answers still ends in a decision, not in a wedged window', async () => {
  const { window, guard, dialogs } = harness({
    responses: [0], save: async () => ({ ok: false, reason: 'The project window stopped answering.' })
  });
  guard.setProjectState({ dirty: true, hasFile: true, name: 'Session 4' });

  assert.equal(window.close(), false);
  await settle();
  assert.match(dialogs[0].detail, /stopped answering/);
  assert.equal(window.destroyed, true, 'Close without saving remains reachable');
});

test('repeated close attempts share one decision, and internal authorization bypasses it', async () => {
  const window = new FakeWindow();
  let releaseSave;
  let saves = 0;
  const guard = installProjectCloseGuard({
    window,
    dialog: { async showMessageBox() { throw new Error('a project with a file must not ask'); } },
    requestSave: () => {
      saves += 1;
      return new Promise((resolve) => { releaseSave = resolve; });
    }
  });
  guard.setProjectState({ dirty: true, hasFile: true, name: 'Session 4' });

  assert.equal(window.close(), false);
  assert.equal(window.close(), false);
  assert.equal(saves, 1, 'clicking the close button twice does not save twice');
  assert.equal(guard.isResolving(), true);

  releaseSave({ ok: false, reason: 'cancelled' });
  await settle();
  assert.equal(window.destroyed, false);
  assert.equal(guard.isResolving(), false);

  guard.allowCloseOnce();
  assert.equal(window.close(), true);
  assert.equal(window.destroyed, true);
  assert.equal(saves, 1);
});

test('a disposed guard stops intercepting the close', async () => {
  const { window, guard, saves } = harness();
  guard.setProjectState({ dirty: true, hasFile: true, name: 'Session 4' });
  guard.dispose();

  assert.equal(window.close(), true);
  await settle();
  assert.deepEqual(saves, []);
});

test('main/preload close-time IPC is narrow and owned by the canonical renderer', () => {
  const root = path.resolve(__dirname, '..');
  const preload = fs.readFileSync(path.join(root, 'src/main/preload.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');
  assert.match(preload, /projectSetCloseState:\s*\(state\)\s*=>\s*ipcRenderer\.send\('project:close-state'/);
  assert.match(preload, /projectSaveResult:\s*\(result\)\s*=>\s*ipcRenderer\.send\('project:save-result'/);
  // Both halves of the round trip, checked against each other: a renamed
  // channel on one side alone would leave every close-time save unanswered
  // until the timeout, with the tests above still green.
  assert.match(preload, /ipcRenderer\.on\('project:save-request'/);
  assert.match(main, /webContents\.send\('project:save-request'/);
  assert.match(main, /ipcMain\.on\('project:close-state'/);
  assert.match(main, /ipcMain\.on\('project:save-result'/);
  for (const channel of ['project:close-state', 'project:save-result']) {
    const handler = main.slice(main.indexOf("ipcMain.on('" + channel + "'"));
    assert.match(handler.slice(0, 400), /event\.sender\s*!==\s*mainWindow\.webContents/,
      'a Clip Editor or stale renderer cannot drive ' + channel);
  }
  assert.match(main, /installProjectCloseGuard/);
  assert.match(main, /PROJECT_SAVE_TIMEOUT_MS/,
    'the close-time save round trip is bounded, so a stuck renderer cannot wedge the quit');
  const beforeQuit = main.slice(main.indexOf("app.on('before-quit'"));
  assert.ok(beforeQuit.indexOf('projectCloseGuard?.isDirty()') < beforeQuit.indexOf('if (engine)'),
    'the close decision is resolved before shutdown can stop the native engine');
});
