'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const repo = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(repo, relativePath), 'utf8');

test('the authoritative start path builds native, syncs packaged resources, then launches dist', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.scripts['build:native'], /native\/audio-engine\/build.*Release.*mlh_audio_engine/);
  assert.equal(pkg.scripts.package, 'npm run build:native && npm run sync:dist');
  assert.equal(pkg.scripts.start, 'npm run package && node scripts/launch-dist.mjs');

  const sync = read('scripts/sync-dist.mjs');
  assert.match(sync, /nativeSource.*native.*audio-engine.*build.*Release.*mlh-audio-engine\.exe/);
  assert.match(sync, /scannerSource.*native.*audio-engine.*build.*Release.*mlh-vst3-scanner\.exe/);
  assert.match(sync, /copyFileSync\(nativeSource, nativeTarget\)/);
  assert.match(sync, /copyFileSync\(scannerSource, scannerTarget\)/);
  assert.match(sync, /runtime-provenance\.json/);
  assert.match(sync, /synced coherent Electron runtime/);
  assert.match(sync, /applicationFiles/);
  assert.match(sync, /electronRuntime/);
  assert.match(sync, /packagedExecutable/);

  const launcher = read('scripts/launch-dist.mjs');
  assert.match(launcher, /dist.*MiniHub.*MiniHub\.exe/);
  assert.match(launcher, /spawn\(executable, process\.argv\.slice\(2\)/);
});

test('generated package provenance hashes the complete app, native tools, executable, and Electron runtime', (t) => {
  const packageRoot = path.join(repo, 'dist', 'MiniHub');
  const manifestPath = path.join(packageRoot, 'resources', 'app', 'runtime-provenance.json');
  // Invariant 11 compares a PACKAGE to its sources, so it can only be checked
  // where a package exists. CI never has one: the native SDKs are ~682 MB and
  // deliberately unversioned, so `npm run build:native` cannot run there. The
  // check stays mandatory where it means something -- a developer machine after
  // `npm run sync:dist`, which section 8 makes part of the definition of done --
  // and says out loud that it stood down, instead of failing for a missing
  // precondition and burying every real failure under a red run.
  if (!fs.existsSync(manifestPath)) {
    t.skip('no packaged build under dist/MiniHub — run npm run sync:dist');
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const hash = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

  assert.ok(Object.keys(manifest.applicationFiles || {}).length >= 70,
    'manifest must cover the complete application payload');
  for (const [relativePath, expected] of Object.entries(manifest.applicationFiles)) {
    const packagedPath = path.join(packageRoot, 'resources', 'app', ...relativePath.split('/'));
    assert.equal(hash(packagedPath), expected, `packaged app hash mismatch: ${relativePath}`);
    const sourcePath = path.join(repo, ...relativePath.split('/'));
    if (fs.existsSync(sourcePath)) assert.equal(hash(sourcePath), expected, `source/package mismatch: ${relativePath}`);
  }

  const electronFiles = manifest.electronRuntime?.files || {};
  assert.ok(Object.keys(electronFiles).length >= 70, 'manifest must cover DLL/PAK/locales Electron');
  for (const [relativePath, expected] of Object.entries(electronFiles)) {
    const packagedPath = path.join(packageRoot, ...relativePath.split('/'));
    const sourcePath = path.join(repo, 'node_modules', 'electron', 'dist', ...relativePath.split('/'));
    assert.equal(hash(packagedPath), expected, `packaged Electron hash mismatch: ${relativePath}`);
    assert.equal(hash(sourcePath), expected, `Electron installation/package mismatch: ${relativePath}`);
  }

  assert.equal(hash(path.join(packageRoot, 'resources', 'native', 'mlh-audio-engine.exe')),
    manifest.nativeEngine.sha256);
  assert.equal(hash(path.join(packageRoot, 'resources', 'native', 'mlh-vst3-scanner.exe')),
    manifest.vst3Scanner.sha256);
  assert.equal(hash(path.join(packageRoot, 'resources', 'native', 'lame.exe')),
    manifest.mp3Encoder.sha256);
  assert.equal(hash(path.join(packageRoot, 'resources', 'native', 'LAME-COPYING.txt')),
    manifest.mp3Encoder.licenseSha256);
  assert.equal(hash(path.join(packageRoot, 'MiniHub.exe')), manifest.packagedExecutable.sha256);
});

test('startup diagnostics fingerprint the loaded main, preload, renderer, CSS, and clip editor files', () => {
  const diagnostics = read('src/main/diagnostics.js');
  for (const role of [
    'main', 'preload', 'renderer-entry', 'renderer-css', 'sequencer-renderer',
    'clip-editor-main', 'clip-editor-preload', 'clip-editor-html', 'clip-editor-renderer', 'clip-editor-css'
  ]) assert.match(diagnostics, new RegExp(`['\"]${role}['\"]`));
  assert.match(diagnostics, /runtime:fingerprint combined=/);
  assert.match(diagnostics, /mkdirSync\(path\.dirname\(logPath\(\)\), \{ recursive: true \}\)/);
  assert.match(diagnostics, /native-engine/);

  const main = read('src/main/main.js');
  const preload = read('src/main/preload.js');
  assert.match(main, /ipcMain\.handle\('diagnostics:provenance'.*diagnostics\.runtimeProvenance\(\)/);
  assert.match(preload, /runtimeProvenance: \(\) => ipcRenderer\.invoke\('diagnostics:provenance'\)/);
});

test('Windows startup selects software rendering before Electron becomes ready', () => {
  const main = read('src/main/main.js');
  const inProcessAt = main.indexOf("app.commandLine.appendSwitch('in-process-gpu')");
  const disableAt = main.indexOf("app.disableHardwareAcceleration()");
  const readyAt = main.indexOf('app.whenReady()');
  assert.ok(inProcessAt >= 0, 'the failing GPU subprocess must be kept out of the normal launch path');
  assert.ok(disableAt >= 0, 'the packaged main process must disable the crashing GPU path');
  assert.ok(readyAt > disableAt && readyAt > inProcessAt,
    'both Windows GPU selections must happen synchronously before app.ready');
  assert.match(main, /process\.platform\s*===\s*['"]win32['"][\s\S]*appendSwitch\(['"]in-process-gpu['"]\)[\s\S]*app\.disableHardwareAcceleration\(\)/);
});
