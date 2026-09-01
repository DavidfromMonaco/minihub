'use strict';

/**
 * Startup and lifecycle log.
 *
 * Writes a plain-text trace to a file in the Electron userData dir so the
 * startup paths and the Electron/native event sequence are recoverable after
 * the fact, without the user having had a console open. This is the first
 * thing to read when the engine fails to come up on a machine you cannot
 * attach a debugger to.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

let logPathCache = null;

function logPath() {
  if (!logPathCache) logPathCache = path.join(app.getPath('userData'), 'minilab-hub-startup.log');
  return logPathCache;
}

function log(line) {
  try {
    fs.mkdirSync(path.dirname(logPath()), { recursive: true });
    fs.appendFileSync(logPath(), `${new Date().toISOString()}  ${line}\n`);
  } catch (err) {
    /* ignore write errors */
  }
}

function sha256(filePath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch (_) {
    return 'unavailable';
  }
}

function fingerprintGroup(entries) {
  const serialized = entries.map(({ role, hash }) => `${role}:${hash}`).join('|');
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

function runtimeProvenance({ writeLog = false } = {}) {
  const mainEntries = [
    ['main', path.join(__dirname, 'main.js')],
    ['preload', path.join(__dirname, 'preload.js')],
    ['clip-editor-main', path.join(__dirname, 'clipEditorWindows.js')],
    ['clip-editor-preload', path.join(__dirname, 'clipEditorPreload.js')]
  ];
  const rendererRoot = path.join(__dirname, '../renderer');
  const rendererEntries = [
    ['renderer-entry', path.join(rendererRoot, 'index.html')],
    ['renderer-app', path.join(rendererRoot, 'js/app.js')],
    ['renderer-css', path.join(rendererRoot, 'styles/base.css')],
    ['sequencer-renderer', path.join(rendererRoot, 'js/modules/sequencer/sequencerModule.js')],
    ['clip-editor-html', path.join(rendererRoot, 'clip-editor.html')],
    ['clip-editor-renderer', path.join(rendererRoot, 'js/clipEditor.js')],
    ['clip-editor-css', path.join(rendererRoot, 'styles/clip-editor.css')]
  ];
  const inspect = ([role, filePath]) => {
    let bytes = 'missing';
    try { bytes = fs.statSync(filePath).size; } catch (_) { /* logged as missing */ }
    const entry = { role, filePath, bytes, hash: sha256(filePath) };
    if (writeLog) log(`runtime:file role=${role} path=${filePath} bytes=${bytes} sha256=${entry.hash}`);
    return entry;
  };
  const main = mainEntries.map(inspect);
  const renderer = rendererEntries.map(inspect);
  const mainFingerprint = fingerprintGroup(main);
  const rendererFingerprint = fingerprintGroup(renderer);
  const combinedFingerprint = fingerprintGroup([...main, ...renderer]);
  const manifestPath = path.join(app.getAppPath(), 'runtime-provenance.json');
  let manifest = 'none';
  try {
    const value = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest = `${String(value.gitHead || 'unknown').slice(0, 40)}@${String(value.syncedAt || 'unknown')}`;
  } catch (_) { /* development/source launch has no generated manifest */ }
  const nativeEnginePath = path.join(process.resourcesPath || '', 'native', 'mlh-audio-engine.exe');
  const nativeEngine = inspect(['native-engine', nativeEnginePath]);
  const provenance = {
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    executablePath: process.execPath,
    userDataPath: app.getPath('userData'),
    packaged: app.isPackaged,
    manifest,
    fingerprints: { combined: combinedFingerprint, main: mainFingerprint, renderer: rendererFingerprint },
    files: [...main, ...renderer],
    nativeEngine
  };
  if (writeLog) log(`runtime:fingerprint combined=${combinedFingerprint} main=${mainFingerprint} renderer=${rendererFingerprint} manifest=${manifest}`);
  return provenance;
}

function logRuntimeFingerprint() {
  return runtimeProvenance({ writeLog: true });
}

function logStartupInfo() {
  log('========================================');
  log('MiniLab Hub startup');
  log(`timestamp: ${new Date().toISOString()}`);
  log(`process.cwd(): ${process.cwd()}`);
  log(`app.getAppPath(): ${app.getAppPath()}`);
  log(`process.resourcesPath: ${process.resourcesPath}`);
  log(`electron exe: ${process.execPath}`);
  log(`main module dir: ${__dirname}`);
  log(`renderer entry: ${path.join(__dirname, '../renderer/index.html')}`);
  log(`preload: ${path.join(__dirname, 'preload.js')}`);
  log(`native engine candidate (development): ${path.join(__dirname, '../../native/audio-engine/build/Release/mlh-audio-engine.exe')}`);
  log(`app version: ${app.getVersion()}`);
  log(`userData: ${app.getPath('userData')}`);
  logRuntimeFingerprint();
  log('========================================');
}

module.exports = { log, logStartupInfo, logPath, logRuntimeFingerprint, runtimeProvenance };
