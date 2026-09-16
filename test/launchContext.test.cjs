'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path').win32;
const { EventEmitter } = require('node:events');
const {
  HANDOFF_FRESH_MS, packageStorageOf, probeAppData, switchesOf, takeHandoff, applyHandoff, settleLaunchPlace
} = require('../src/main/launchContext');

/**
 * Contract: MiniHub runs with the person's AppData, whoever opens it (DECISIONS
 * D-045). The paths are the author's machine on 2026-09-16, where a folder
 * created from the Claude app landed in its package storage although the
 * process had no package identity.
 */

const APPDATA = 'C:\\Users\\me\\AppData\\Roaming';
const TEMP = 'C:\\Users\\me\\AppData\\Local\\Temp';
const NOTE = `${TEMP}\\minihub-relaunch.json`;
const EXE = 'C:\\Users\\me\\Desktop\\MiniHub\\MiniHub.exe';
const CLAUDE = 'Claude_pzs8sxrjxfjjc';
const CODEX = 'OpenAI.Codex_2p2nqsd0c76g0';
const NOW = 1_789_571_694_000;

const intoPackage = (family) => (probe) =>
  probe.replace(APPDATA, `C:\\Users\\me\\AppData\\Local\\Packages\\${family}\\LocalCache\\Roaming`);

/** A file system that resolves paths as told and remembers what it was asked. */
function fakeFs({ resolve = (p) => p, mkdirError = null, realpathError = null, writeError = null } = {}) {
  const files = new Map();
  const made = [];
  const removedDirs = [];
  const fs = {
    mkdirSync(p) { if (mkdirError) throw mkdirError; made.push(p); },
    rmdirSync(p) { removedDirs.push(p); },
    realpathSync: { native(p) { if (realpathError) throw realpathError; return resolve(p); } },
    readFileSync(p) {
      if (!files.has(p)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      return files.get(p);
    },
    writeFileSync(p, text) { if (writeError) throw writeError; files.set(p, String(text)); },
    rmSync(p) { files.delete(p); }
  };
  return { fs, files, made, removedDirs };
}

/** `spawn` whose child reports `outcome` on the next turn: 'spawn', 'error' or nothing. */
function fakeSpawn({ outcome = 'spawn', throws = null } = {}) {
  const calls = [];
  const spawn = (command, args, options) => {
    if (throws) throw throws;
    const child = new EventEmitter();
    child.unref = () => { child.unrefed = true; };
    calls.push({ command, args, options, child });
    setImmediate(() => {
      if (outcome === 'spawn') child.emit('spawn');
      else if (outcome === 'error') child.emit('error', new Error('spawn explorer.exe ENOENT'));
    });
    return child;
  };
  return { spawn, calls };
}

const app = { getPath: (name) => ({ appData: APPDATA, temp: TEMP })[name] };

function settle({ fsRig = fakeFs(), spawnRig = fakeSpawn(), env = {}, argv = [], packaged = true, relaunched = null, spawnWaitMs } = {}) {
  const lines = [];
  const place = settleLaunchPlace({
    app, fs: fsRig.fs, path, spawn: spawnRig.spawn, env, argv, execPath: EXE, packaged,
    tag: '4242-1', now: NOW, relaunched, log: (line) => lines.push(line), spawnWaitMs
  });
  return { place, lines, fsRig, spawnRig };
}

// ---- where a new folder lands ---------------------------------------------------

test('the package holding a redirected folder is read from its storage path', () => {
  assert.equal(packageStorageOf(intoPackage(CLAUDE)(`${APPDATA}\\x`)), CLAUDE);
  assert.equal(packageStorageOf(`C:/Users/me/AppData/Local/Packages/${CODEX}/LocalCache/Local/x`), CODEX);
  assert.equal(packageStorageOf(`${APPDATA}\\x`), '');
  assert.equal(packageStorageOf('C:\\Users\\me\\AppData\\Local\\Packages\\Some.App\\LocalState\\x'), '',
    'only the storage Windows redirects AppData into counts');
  assert.equal(packageStorageOf(undefined), '');
});

test('the probe is made at the top of AppData, read back, and always removed', () => {
  const real = fakeFs();
  assert.deepEqual(probeAppData({ fs: real.fs, path, appData: APPDATA, tag: 't1' }), { redirectedTo: '' });
  assert.deepEqual(real.made, [`${APPDATA}\\minihub-launch-check-t1`]);
  assert.deepEqual(real.removedDirs, real.made);

  const claude = fakeFs({ resolve: intoPackage(CLAUDE) });
  assert.deepEqual(probeAppData({ fs: claude.fs, path, appData: APPDATA, tag: 't2' }), { redirectedTo: CLAUDE });
  assert.deepEqual(claude.removedDirs, claude.made);

  const unreadable = fakeFs({ realpathError: new Error('EPERM') });
  const failed = probeAppData({ fs: unreadable.fs, path, appData: APPDATA, tag: 't3' });
  assert.equal(failed.redirectedTo, '');
  assert.match(failed.error, /EPERM/);
  assert.deepEqual(unreadable.removedDirs, unreadable.made, 'removed even when it could not be read back');

  const refused = fakeFs({ mkdirError: new Error('EACCES') });
  const notMade = probeAppData({ fs: refused.fs, path, appData: APPDATA, tag: 't4' });
  assert.equal(notMade.redirectedTo, '');
  assert.deepEqual(refused.removedDirs, [], 'nothing to remove when nothing was made');
});

test('AppData moved somewhere that is not a package, a roaming share, is not a redirect', () => {
  const share = fakeFs({ resolve: (p) => p.replace('C:\\Users\\me\\AppData\\Roaming', '\\\\server\\profiles\\me\\Roaming') });
  assert.deepEqual(probeAppData({ fs: share.fs, path, appData: APPDATA, tag: 't5' }), { redirectedTo: '' });
});

// ---- what crosses the shell -----------------------------------------------------

test('only well-formed switches are carried from the command line', () => {
  assert.deepEqual(switchesOf([
    '--remote-debugging-port=9333', '--enable-logging', 'C:\\Songs\\test.minihub', '-v',
    '--=x', '--two words', '--js-flags=--max-old-space-size=4096'
  ]), [['remote-debugging-port', '9333'], ['enable-logging', ''], ['js-flags', '--max-old-space-size=4096']]);
  assert.deepEqual(switchesOf(undefined), []);
});

test('a fresh note is read once and gives back the channel switch and the switches', () => {
  const rig = fakeFs();
  rig.files.set(NOTE, JSON.stringify({
    from: CLAUDE, at: NOW - 1500, exe: EXE, agentChannel: true,
    switches: [['remote-debugging-port', '9333'], ['bad name', 'x'], ['ok', 42], 'nope']
  }));
  const note = takeHandoff({ fs: rig.fs, path, tempDir: TEMP, now: NOW, execPath: EXE.toUpperCase() });
  assert.deepEqual(note, { from: CLAUDE, agentChannel: true, switches: [['remote-debugging-port', '9333']] });
  assert.equal(rig.files.has(NOTE), false, 'no later launch inherits it');
  assert.equal(takeHandoff({ fs: rig.fs, path, tempDir: TEMP, now: NOW, execPath: EXE }), null);
});

test('a stale, future, foreign or broken note is dropped, and removed all the same', () => {
  for (const text of [
    JSON.stringify({ from: CLAUDE, at: NOW - HANDOFF_FRESH_MS - 1, exe: EXE, agentChannel: true }),
    JSON.stringify({ from: CLAUDE, at: NOW + 5000, exe: EXE, agentChannel: true }),
    JSON.stringify({ from: CLAUDE, exe: EXE, agentChannel: true }),
    // Written for another copy of MiniHub on the machine: that copy reads it.
    JSON.stringify({ from: CLAUDE, at: NOW - 1500, exe: 'C:\\One Ring\\integration\\MiniHub.exe', agentChannel: true }),
    JSON.stringify({ from: CLAUDE, at: NOW - 1500, agentChannel: true }),
    '{ not json'
  ]) {
    const rig = fakeFs();
    rig.files.set(NOTE, text);
    assert.equal(takeHandoff({ fs: rig.fs, path, tempDir: TEMP, now: NOW, execPath: EXE }), null, text);
    assert.equal(rig.files.has(NOTE), false);
  }
});

test('the note puts back the channel switch and the command-line switches', () => {
  const appended = [];
  const target = { commandLine: { appendSwitch: (...args) => appended.push(args) } };
  const env = {};
  applyHandoff({
    note: { from: CLAUDE, agentChannel: true, switches: [['remote-debugging-port', '9333'], ['enable-logging', '']] },
    app: target, env
  });
  assert.equal(env.MINIHUB_AGENT_CHANNEL, '1');
  assert.deepEqual(appended, [['remote-debugging-port', '9333'], ['enable-logging']]);

  applyHandoff({ note: { from: CLAUDE, agentChannel: false, switches: [] }, app: target, env: {} });
  applyHandoff({ note: null, app: target, env: {} });
  assert.equal(appended.length, 2, 'nothing to put back, nothing touched');
});

// ---- the decision ---------------------------------------------------------------

test('a MiniHub with its own AppData starts where it is', async () => {
  const { place, lines, spawnRig } = settle();
  assert.deepEqual(await place, { leave: false, redirectedTo: '' });
  assert.equal(spawnRig.calls.length, 0);
  assert.deepEqual(lines, ['launch:appdata-check redirected=false']);
});

test('a MiniHub inside the Claude app hands its launch to the shell, with a note for the next one', async () => {
  const fsRig = fakeFs({ resolve: intoPackage(CLAUDE) });
  const { place, lines, spawnRig } = settle({
    fsRig, env: { MINIHUB_AGENT_CHANNEL: '1' }, argv: ['--remote-debugging-port=9333']
  });
  assert.deepEqual(await place, { leave: true, redirectedTo: CLAUDE });
  assert.equal(spawnRig.calls.length, 1);
  const [call] = spawnRig.calls;
  assert.equal(call.command, 'explorer.exe', 'the shell starts it, as a double-click does');
  assert.deepEqual(call.args, [EXE]);
  assert.equal(call.options.detached, true);
  assert.equal(call.child.unrefed, true);
  assert.deepEqual(lines, [`launch:relaunching-outside name=${CLAUDE}`]);

  // What the MiniHub the shell starts reads, in its own process.
  const note = takeHandoff({ fs: fsRig.fs, path, tempDir: TEMP, now: NOW + 2000, execPath: EXE });
  assert.deepEqual(note, { from: CLAUDE, agentChannel: true, switches: [['remote-debugging-port', '9333']] });
});

test('a MiniHub the shell started, still redirected, stays and says so rather than loop', async () => {
  const { place, lines, spawnRig } = settle({
    fsRig: fakeFs({ resolve: intoPackage(CODEX) }),
    relaunched: { from: CODEX, agentChannel: false, switches: [] }
  });
  assert.deepEqual(await place, { leave: false, redirectedTo: CODEX });
  assert.equal(spawnRig.calls.length, 0);
  assert.deepEqual(lines, [`launch:still-inside-package name=${CODEX} relaunched-from=${CODEX}`]);
});

test('an arrival that the check finds at home is logged as such', async () => {
  const { place, lines } = settle({ relaunched: { from: CLAUDE, agentChannel: false, switches: [] } });
  assert.deepEqual(await place, { leave: false, redirectedTo: '' });
  assert.deepEqual(lines, [`launch:appdata-check redirected=false relaunched-from=${CLAUDE}`]);
});

test('an unpackaged run is not handed to the shell, which would start Electron instead', async () => {
  const { place, spawnRig, lines } = settle({ fsRig: fakeFs({ resolve: intoPackage(CLAUDE) }), packaged: false });
  assert.deepEqual(await place, { leave: false, redirectedTo: CLAUDE });
  assert.equal(spawnRig.calls.length, 0);
  assert.deepEqual(lines, [`launch:still-inside-package name=${CLAUDE} unpackaged`]);
});

test('when the shell cannot be reached, MiniHub starts where it is and takes its note back', async () => {
  for (const spawnRig of [
    fakeSpawn({ outcome: 'error' }),
    fakeSpawn({ throws: new Error('spawn EPERM') }),
    fakeSpawn({ outcome: 'none' })
  ]) {
    const fsRig = fakeFs({ resolve: intoPackage(CLAUDE) });
    const { place, lines } = settle({ fsRig, spawnRig, spawnWaitMs: 20 });
    assert.deepEqual(await place, { leave: false, redirectedTo: CLAUDE });
    assert.equal(fsRig.files.has(NOTE), false, 'no later launch inherits a note for a relaunch that never happened');
    assert.equal(lines.length, 1);
    assert.match(lines[0], new RegExp(`^launch:relaunch-failed name=${CLAUDE} error=`));
  }
});

test('a note that cannot be written keeps MiniHub where it is', async () => {
  const { place, spawnRig, lines } = settle({
    fsRig: fakeFs({ resolve: intoPackage(CLAUDE), writeError: new Error('EROFS') })
  });
  assert.deepEqual(await place, { leave: false, redirectedTo: CLAUDE });
  assert.equal(spawnRig.calls.length, 0);
  assert.match(lines[0], /^launch:relaunch-failed .*EROFS/);
});

test('a check that cannot run lets MiniHub start, and is logged', async () => {
  const { place, lines, spawnRig } = settle({ fsRig: fakeFs({ mkdirError: new Error('EACCES: denied') }) });
  assert.deepEqual(await place, { leave: false, redirectedTo: '' });
  assert.equal(spawnRig.calls.length, 0);
  assert.deepEqual(lines, ['launch:appdata-check failed error=EACCES: denied']);
});
