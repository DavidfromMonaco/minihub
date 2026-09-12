'use strict';

/**
 * Contract: MiniHub opens ITS pages, and the renderer never picks the address.
 *
 * ROADMAP item 15. `shell.openExternal` hands a string to the operating
 * system's handler for that string's scheme, so a renderer that chooses the
 * string chooses which program Windows launches. MiniHub's renderer is also the
 * process that displays a profile file written by a stranger (D-020), which is
 * what makes this worth a test rather than a comment.
 *
 * The rule the tests hold: a NAME goes over the IPC, a URL comes out of
 * `externalLinks.js`, and anything else is refused.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const repo = path.join(__dirname, '..');
const { SITE_DESTINATIONS, externalUrlFor } = require('../src/main/externalLinks');
const read = (file) => fs.readFileSync(path.join(repo, file), 'utf8');

// ---- the address list -----------------------------------------------------------

test('a named destination resolves to its page', () => {
  assert.equal(externalUrlFor('setups'), 'https://minihub.site/setups/');
});

test('anything that is not one of our names is refused', () => {
  for (const name of [
    'https://example.com',          // a URL, which is exactly what must not work
    'file:///C:/Windows/System32',  // the reason this file exists
    'SETUPS', ' setups', 'setups/', '', null, undefined, 42, {},
    '__proto__', 'constructor', 'toString'  // an object's own furniture is not a destination
  ]) {
    assert.equal(externalUrlFor(name), null, `${String(name)} must not resolve`);
  }
});

test('every destination is https, checked rather than assumed', () => {
  for (const [name, url] of Object.entries(SITE_DESTINATIONS)) {
    assert.ok(url.startsWith('https://'), `${name} is not https`);
    assert.equal(externalUrlFor(name), url);
  }
});

test('the table cannot be extended at runtime', () => {
  assert.throws(() => { SITE_DESTINATIONS.evil = 'file:///C:/'; }, TypeError);
  assert.equal(externalUrlFor('evil'), null);
});

// ---- the wiring, end to end -------------------------------------------------------

test('preload exposes the destination by name, over the site channel', () => {
  const exposed = {};
  const invoked = [];
  const electron = {
    contextBridge: { exposeInMainWorld: (key, value) => { exposed[key] = value; } },
    ipcRenderer: {
      sendSync: () => ({ source: 'none' }),
      invoke: (channel, ...args) => { invoked.push([channel, ...args]); return Promise.resolve(true); },
      on: () => {}, removeListener: () => {}
    }
  };
  const PRELOAD = path.join(repo, 'src', 'main', 'preload.js');
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'electron') return electron;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(PRELOAD)];
    require(PRELOAD);
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve(PRELOAD)];
  }

  exposed.hubAPI.siteOpen('setups');
  assert.deepEqual(invoked, [['site:open', 'setups']],
    'a name crosses the bridge; a URL never does');
});

test('main answers that channel and asks externalLinks, not its caller', () => {
  const source = read('src/main/main.js');
  assert.match(source, /ipcMain\.handle\('site:open'/, 'the channel is served');
  const handler = source.slice(source.indexOf("ipcMain.handle('site:open'"));
  const body = handler.slice(0, handler.indexOf('\n});'));
  assert.match(body, /externalUrlFor\(destination\)/, 'the name is resolved here, not trusted');
  assert.match(body, /if \(!url\) return false;/, 'and an unknown name never reaches the shell');
  assert.equal(/openExternal\((?!url\))/.test(body), false,
    'openExternal takes the resolved URL and nothing else');
});

// ---- the label and the address say the same thing ---------------------------------

test('the button names the host it actually opens', () => {
  // The label is the only warning the user gets that a click leaves MiniHub --
  // there is no confirmation dialog, on purpose. A label naming one host while
  // the table opens another is a lie with no failing test behind it.
  const shell = read('src/renderer/js/ui/controllerProfileSection.js');
  const label = shell.match(/id="profile-setups">([^<]+)</);
  assert.ok(label, 'the Browse setups button is in the profile panel');
  const host = new URL(SITE_DESTINATIONS.setups).host;
  assert.ok(label[1].includes(host), `"${label[1]}" does not name ${host}`);
});

test('the renderer holds no URL of its own', () => {
  for (const file of ['src/renderer/js/ui/controllerProfileSection.js',
    'src/renderer/js/modules/minilab/minilabModule.js']) {
    assert.equal(/https?:\/\//.test(read(file)), false,
      `${file} spells a URL; the address list lives in src/main/externalLinks.js`);
  }
});
