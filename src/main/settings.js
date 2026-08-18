'use strict';

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  selectedInputId: null,
  selectedOutputId: null,
  inputOffsets: {}, // inputId -> timing offset in ms
  graphConnections: [] // [{ from: {nodeId, portId}, to: {nodeId, portId} }]
};

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8');
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch (err) {
    return { ...DEFAULTS };
  }
}

function saveSettings(settings) {
  // Atomic write: settings are saved on every graph/layout change, so a crash
  // (or a power cut) mid-write used to leave a truncated JSON file, which
  // loadSettings then silently discarded along with every node and cable.
  const target = settingsPath();
  const tmp = `${target}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
    fs.renameSync(tmp, target);
    return true;
  } catch (err) {
    console.error('Failed to save settings:', err);
    try {
      fs.rmSync(tmp, { force: true });
    } catch (cleanupErr) {
      /* ignore */
    }
    return false;
  }
}

module.exports = { loadSettings, saveSettings, DEFAULTS };
