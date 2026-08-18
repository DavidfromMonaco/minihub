'use strict';

/**
 * Temporary startup diagnostics logger.
 *
 * Writes a plain-text lifecycle trace to a file in the Electron userData dir so
 * the exact startup paths and event sequence are captured even when the user
 * does not see the console. Used to prove the launched instance runs the same
 * build/code as the one that was tested.
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
