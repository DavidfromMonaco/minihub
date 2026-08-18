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
const { app } = require('electron');

let logPathCache = null;

function logPath() {
  if (!logPathCache) logPathCache = path.join(app.getPath('userData'), 'minilab-hub-startup.log');
  return logPathCache;
}

function log(line) {
  try {
    fs.appendFileSync(logPath(), `${new Date().toISOString()}  ${line}\n`);
  } catch (err) {
    /* ignore write errors */
  }
}

function logStartupInfo() {
  log('========================================');
  log('MiniLab Hub startup');
  log(`timestamp: ${new Date().toISOString()}`);
  log(`process.cwd(): ${process.cwd()}`);
  log(`app.getAppPath(): ${app.getAppPath()}`);
  log(`electron exe: ${process.execPath}`);
  log(`main module dir: ${__dirname}`);
  log(`renderer entry: ${path.join(__dirname, '../renderer/index.html')}`);
  log(`preload: ${path.join(__dirname, 'preload.js')}`);
  log(`native engine exe: ${path.join(__dirname, '../../native/audio-engine/build/Release/mlh-audio-engine.exe')}`);
  log(`app version: ${app.getVersion()}`);
  log(`userData: ${app.getPath('userData')}`);
  log('========================================');
}

module.exports = { log, logStartupInfo, logPath };
