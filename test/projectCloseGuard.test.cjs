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

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a dirty project close defaults to Cancel and leaves the window alive', async () => {
  const window = new FakeWindow();
  const options = [];
  const guard = installProjectCloseGuard({
    window,
    dialog: { async showMessageBox(_window, value) { options.push(value); return { response: 1 }; } }
  });
  guard.setDirty(true);

  assert.equal(window.close(), false, 'the first operating-system close is intercepted');
  await settle();
  assert.equal(window.destroyed, false);
  assert.equal(guard.isDirty(), true);
  assert.deepEqual(options[0].buttons, ['Discard changes', 'Cancel']);
  assert.equal(options[0].defaultId, 1);
  assert.equal(options[0].cancelId, 1);
});

test('Discard is a one-shot authorization that closes without a second prompt', async () => {
  const window = new FakeWindow();
  let prompts = 0;
  const guard = installProjectCloseGuard({
    window,
    dialog: { async showMessageBox() { prompts += 1; return { response: 0 }; } }
  });
  guard.setDirty(true);

  assert.equal(window.close(), false);
  await settle();
  assert.equal(window.destroyed, true);
  assert.equal(window.closeAttempts, 2, 'one user attempt plus the authorized close');
  assert.equal(prompts, 1);
  assert.equal(guard.isDirty(), false);
});

test('repeated close events share one pending prompt and internal authorization bypasses it', async () => {
  const window = new FakeWindow();
  let resolveDialog;
  let prompts = 0;
  const guard = installProjectCloseGuard({
    window,
    dialog: { showMessageBox() { prompts += 1; return new Promise((resolve) => { resolveDialog = resolve; }); } }
  });
  guard.setDirty(true);

  assert.equal(window.close(), false);
  assert.equal(window.close(), false);
  assert.equal(prompts, 1);
  resolveDialog({ response: 1 });
  await settle();

  guard.allowCloseOnce();
  assert.equal(window.close(), true);
  assert.equal(window.destroyed, true);
  assert.equal(prompts, 1);
});

test('main/preload dirty IPC is narrow and owned by the canonical renderer', () => {
  const root = path.resolve(__dirname, '..');
  const preload = fs.readFileSync(path.join(root, 'src/main/preload.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');
  assert.match(preload, /projectSetDirty:\s*\(dirty\)\s*=>\s*ipcRenderer\.send\('project:dirty-state'/);
  assert.match(main, /ipcMain\.on\('project:dirty-state'/);
  assert.match(main, /event\.sender\s*!==\s*mainWindow\.webContents/,
    'a Clip Editor or stale renderer cannot clear the close guard');
  assert.match(main, /installProjectCloseGuard/);
  const beforeQuit = main.slice(main.indexOf("app.on('before-quit'"));
  assert.ok(beforeQuit.indexOf('projectCloseGuard?.isDirty()') < beforeQuit.indexOf('if (engine)'),
    'Cancel/Discard is resolved before shutdown can stop the native engine');
});
