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
  assert.equal(externalUrlFor('site'), 'https://minihub.site/');
  assert.equal(externalUrlFor('source'), 'https://github.com/DavidfromMonaco/minihub');
});

test('a bug report is a pre-filled issue form, with the answers nobody remembers', () => {
  // The report destination exists so that "which version?" is already answered
  // when the page opens. It is a LINK: MiniHub sends nothing, and the report
  // exists only once the reporter posts it themselves (INTENT.md §7).
  const url = new URL(externalUrlFor('report'));
  assert.equal(url.host, 'github.com');
  assert.match(url.pathname, /\/issues\/new$/);
  assert.equal(url.pathname.startsWith(new URL(SITE_DESTINATIONS.source).pathname), true,
    'the report goes to the repository the Source code button opens, not to another one');

  const body = url.searchParams.get('body');
  const { version } = require('../package.json');
  assert.match(body, new RegExp(`MiniHub ${version.replace(/\./g, '\\.')}`), 'the version is filled in');
  assert.match(body, /Windows \d+\.\d+/, 'the Windows build is filled in');
  assert.match(body, /What happened/, 'and the reporter is asked the questions, not the environment');
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

test('every Home button names the host it actually opens', () => {
  // Same rule as the Browse setups button above, for the three places Home
  // offers. Home is the first page a stranger sees, so a label promising
  // minihub.site while the table opens github.com would be the first thing
  // MiniHub ever lied about.
  const home = read('src/renderer/js/modules/home/homeModule.js');
  for (const destination of ['site', 'source', 'report']) {
    const button = home.slice(home.indexOf(`departure('${destination}'`));
    const label = button.slice(0, button.indexOf(')'));
    assert.ok(label, `Home has no ${destination} button`);
    const host = new URL(SITE_DESTINATIONS[destination]).host;
    assert.ok(label.includes(host), `${destination}: "${label}" does not name ${host}`);
  }
});

test('the renderer holds no URL of its own', () => {
  for (const file of ['src/renderer/js/ui/controllerProfileSection.js',
    'src/renderer/js/modules/minilab/minilabModule.js',
    'src/renderer/js/modules/home/homeModule.js']) {
    assert.equal(/https?:\/\//.test(read(file)), false,
      `${file} spells a URL; the address list lives in src/main/externalLinks.js`);
  }
});
