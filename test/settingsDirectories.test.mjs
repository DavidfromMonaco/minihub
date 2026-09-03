import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSettingsModal } from '../src/renderer/js/ui/settingsModal.js';

/**
 * A root element just real enough for a panel that renders with innerHTML.
 *
 * The shared DOM shim throws HTML away on assignment, which is fine for modules
 * that build elements one by one -- this one builds a string, so the string is
 * what has to be observable.
 */
function fakeRoot() {
  const root = {
    html: '',
    classes: new Set(['hidden']),
    backdropListeners: [],
    buttons: []
  };
  root.classList = {
    add: (c) => root.classes.add(c),
    remove: (c) => root.classes.delete(c),
    contains: (c) => root.classes.has(c)
  };
  root.addEventListener = (type, fn) => { if (type === 'click') root.backdropListeners.push(fn); };
  Object.defineProperty(root, 'innerHTML', {
    get: () => root.html,
    set: (value) => {
      root.html = value;
      root.buttons = [...value.matchAll(/<button[^>]*\sdata-(choose|open)="([^"]+)"/g)]
        .map(([, kind, purpose]) => ({
          dataset: { [kind]: purpose },
          kind,
          purpose,
          handlers: [],
          addEventListener(_type, fn) { this.handlers.push(fn); },
          click() { return Promise.all(this.handlers.map((fn) => fn())); }
        }));
    }
  });
  root.querySelector = (selector) => {
    if (selector === '#close-settings' || selector === '#reset-settings') {
      return { addEventListener() {} };
    }
    return null;
  };
  root.querySelectorAll = (selector) => {
    const kind = selector === '[data-choose]' ? 'choose' : selector === '[data-open]' ? 'open' : null;
    return root.buttons.filter((button) => button.kind === kind);
  };
  return root;
}

function harness({ directories, chosen = null } = {}) {
  const calls = [];
  const api = {
    async listDirectories() { calls.push('list'); return directories; },
    async chooseDirectory(purpose) { calls.push(`choose:${purpose}`); return chosen; },
    async openDirectory(purpose) { calls.push(`open:${purpose}`); return true; }
  };
  const hub = {
    api,
    events: { emit() {} },
    settings: { async set() {} },
    midi: {
      selectedInputId: null, selectedOutputId: null,
      getInput: () => null, getOutput: () => null,
      listInputs: () => [], listOutputs: () => [],
      selectInput() {}, selectOutput() {}
    }
  };
  const root = fakeRoot();
  const openButton = { addEventListener(_type, fn) { openButton.fire = fn; } };
  const modal = buildSettingsModal(hub, root, openButton);
  return { modal, root, calls, openButton };
}

const DIRECTORIES = {
  project: 'D:\\Sets',
  audioExport: 'E:\\Bounces',
  audioImport: 'C:\\Users\\me\\Music',
  audioRecordings: 'E:\\Takes'
};

test('Settings shows every destination folder MiniHub writes into', async () => {
  const { modal, root, calls } = harness({ directories: DIRECTORIES });
  await modal.show();

  assert.deepEqual(calls, ['list']);
  for (const [label, directory] of [
    ['Recordings', 'E:\\Takes'],
    ['Audio exports', 'E:\\Bounces'],
    ['Projects', 'D:\\Sets']
  ]) {
    assert.ok(root.html.includes(label), `${label} is missing from Settings`);
    assert.ok(root.html.includes(directory), `the folder used for ${label} is not shown`);
  }
  assert.ok(!root.html.includes('C:\\Users\\me\\Music'),
    'the import folder is a browsing convenience, not a destination to configure');
  assert.equal(root.querySelectorAll('[data-choose]').length, 3);
  assert.equal(root.querySelectorAll('[data-open]').length, 3);
});

test('choosing a folder records it and shows the new destination immediately', async () => {
  const { modal, root, calls } = harness({ directories: DIRECTORIES, chosen: 'F:\\New Takes' });
  await modal.show();

  const recordings = root.querySelectorAll('[data-choose]').find((b) => b.purpose === 'audioRecordings');
  await recordings.click();

  assert.ok(calls.includes('choose:audioRecordings'));
  assert.ok(root.html.includes('F:\\New Takes'), 'the panel must show where takes go now');
  assert.ok(!root.html.includes('E:\\Takes'), 'the old folder is gone from the panel');
});

test('dismissing the folder dialog changes nothing', async () => {
  const { modal, root } = harness({ directories: DIRECTORIES, chosen: null });
  await modal.show();

  await root.querySelectorAll('[data-choose]')[0].click();
  assert.ok(root.html.includes('E:\\Takes'), 'a cancelled choice leaves the folder alone');
});

test('Open asks the main process to reveal the folder, without touching the memory', async () => {
  const { modal, root, calls } = harness({ directories: DIRECTORIES });
  await modal.show();

  await root.querySelectorAll('[data-open]').find((b) => b.purpose === 'audioExport').click();
  assert.deepEqual(calls, ['list', 'open:audioExport']);
});

test('a folder path is escaped before it reaches innerHTML', async () => {
  const { modal, root } = harness({
    directories: { ...DIRECTORIES, audioRecordings: 'C:\\<img src=x onerror="boom">' }
  });
  await modal.show();

  assert.ok(!root.html.includes('<img src=x'), 'a path is text, never markup');
  assert.ok(root.html.includes('&lt;img src=x'));
});

test('the panel still opens when the main process cannot answer', async () => {
  const { modal, root } = harness({ directories: undefined });
  await modal.show();

  assert.ok(root.html.includes('Recordings'), 'the panel opens rather than staying blank');
  assert.ok(root.html.includes('Not set'),
    'an unknown folder is named as unknown rather than rendered as undefined');
});

test('the backdrop listener is bound once, not on every render', async () => {
  const { modal, root } = harness({ directories: DIRECTORIES, chosen: 'F:\\Elsewhere' });
  await modal.show();
  await root.querySelectorAll('[data-choose]')[0].click();
  await modal.show();

  assert.equal(root.backdropListeners.length, 1);
});
