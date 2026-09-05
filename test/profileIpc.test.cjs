'use strict';

/**
 * What `preload.js` puts on the page, and when.
 *
 * The load-bearing claim of this workstream is that the profile is present
 * BEFORE the renderer's first module evaluates. `MINILAB_NODE_ID` is a
 * module-level constant derived from it, so anything asynchronous arrives after
 * every consumer has frozen its value — and MiniHub would then decode with one
 * profile while naming its routing node after another.
 *
 * That claim lives in one word, `sendSync`, and nothing else in the repository
 * would fail if it became `invoke`: the profile would simply be a Promise, the
 * fallback would take over, and the shipped keyboard would appear to work. So it
 * is asserted here, against the real preload loaded with a stubbed Electron.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const PRELOAD = path.join(__dirname, '..', 'src', 'main', 'preload.js');

/** Load preload.js with `require('electron')` replaced, and record what it did. */
function loadPreload({ syncAnswer = { source: 'none' } } = {}) {
  const exposed = {};
  const order = [];
  const invoked = [];
  const electron = {
    contextBridge: {
      exposeInMainWorld: (key, value) => { exposed[key] = value; order.push(['expose', key]); }
    },
    ipcRenderer: {
      sendSync: (channel) => { order.push(['sendSync', channel]); return syncAnswer; },
      invoke: (channel, ...args) => { invoked.push([channel, ...args]); return Promise.resolve('answered'); },
      on: () => {},
      removeListener: () => {}
    }
  };

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
  return { exposed, order, invoked };
}

test('the profiles are fetched synchronously, and before anything else is exposed', () => {
  const handover = [{ source: 'file', fileName: 'vega-49.json', profile: { profileId: 'vega-49' }, error: null }];
  const { exposed, order } = loadPreload({ syncAnswer: handover });

  assert.deepEqual(order[0], ['sendSync', 'profile:current'],
    'anything asynchronous here arrives after the module graph has already frozen the node id');
  assert.deepEqual(exposed.hubProfiles, handover);
  assert.ok(exposed.hubAPI, 'and the rest of the bridge is still there');
});

test('the handover reaches the renderer verbatim, including the ways it can fail', () => {
  for (const handover of [
    [],                                                                            // nothing chosen
    [{ source: 'unreadable', fileName: 'gone.json', profile: null, error: 'ENOENT' }],
    // Two keyboards asked for, one of them missing: preload carries the pair as
    // it is, so the renderer can run one and name the other as absent.
    [{ source: 'file', fileName: 'minilab-3.json', profile: { profileId: 'minilab-3' }, error: null },
      { source: 'unreadable', fileName: 'beatstep.json', profile: null, error: 'ENOENT' }]
  ]) {
    const { exposed } = loadPreload({ syncAnswer: handover });
    assert.deepEqual(exposed.hubProfiles, handover,
      'the renderer decides what to do about a failure; preload does not get to soften it');
  }
});

test('the five profile calls exist and reach the channels main answers', async () => {
  const { exposed, invoked } = loadPreload();
  const api = exposed.hubAPI;

  await api.profileList();
  await api.profilePick();
  await api.profileImport('{"profileId":"vega-49"}');
  await api.profileSelect('vega-49.json');
  await api.profileForget('vega-49.json');

  assert.deepEqual(invoked, [
    ['profile:list'],
    ['profile:pick'],
    ['profile:import', '{"profileId":"vega-49"}'],
    ['profile:select', 'vega-49.json'],
    ['profile:forget', 'vega-49.json']
  ]);
});

/**
 * D-007: the IPC surface is a fixed allow-list, not a pass-through. Every channel
 * this file can reach is named in it, so a channel added on one side and not the
 * other shows up here rather than as a call that silently answers undefined.
 */
test('the bridge reaches exactly the channels main declares, and no others', () => {
  const source = require('node:fs').readFileSync(PRELOAD, 'utf8');
  const channels = new Set([...source.matchAll(/ipcRenderer\.(?:invoke|send|sendSync|on)\(\s*'([^']+)'/g)]
    .map((match) => match[1]));

  const mainSource = require('node:fs').readFileSync(
    path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8'
  );
  const answered = new Set([...mainSource.matchAll(/ipcMain\.(?:handle|on)\(\s*'([^']+)'/g)]
    .map((match) => match[1]));
  // Channels main SENDS to the renderer are answered by listeners, not handlers.
  const pushed = new Set([...mainSource.matchAll(/\.send\(\s*'([^']+)'/g)].map((match) => match[1]));

  for (const channel of channels) {
    if (!channel.startsWith('profile:')) continue;
    assert.ok(answered.has(channel) || pushed.has(channel),
      `${channel} is reachable from preload and answered by nobody in main`);
  }
  for (const channel of ['profile:current', 'profile:list', 'profile:pick', 'profile:import', 'profile:select', 'profile:forget']) {
    assert.ok(channels.has(channel), `${channel} is answered by main and reachable from nowhere`);
  }
});
