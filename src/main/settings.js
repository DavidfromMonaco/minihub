'use strict';

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  selectedInputId: null,
  midiInputPreference: null,
  selectedOutputId: null,
  inputOffsets: {}, // inputId -> timing offset in ms
  audioOutputConfig: null,
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

function applyPluginStateChunk(settings, message) {
  if (!settings || !message || typeof message.state !== 'string') return false;
  const instances = settings.nodeInstances && settings.nodeInstances.instances;
  if (!Array.isArray(instances)) return false;

  const node = instances.find((item) => item && item.id === message.chainId && item.type === 'vst');
  const plugins = node && node.content && node.content.plugins;
  if (!Array.isArray(plugins)) return false;

  const plugin = plugins.find((item) => item &&
    item.id === message.instanceId && item.pluginId === message.pluginId);
  if (!plugin) return false;
  plugin.state = message.state;
  return true;
}

function persistPluginStateChunk(message) {
  const settings = loadSettings();
  return applyPluginStateChunk(settings, message) && saveSettings(settings);
}

module.exports = {
  loadSettings,
  saveSettings,
  applyPluginStateChunk,
  persistPluginStateChunk,
  DEFAULTS
};
