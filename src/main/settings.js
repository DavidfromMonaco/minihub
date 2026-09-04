'use strict';

const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { withDirectory, withDirectoryOfFile, carryDirectoryMemory } = require('./recentDirectories');

// APPLICATION-scoped settings only: preferences that belong to this machine and
// survive across projects. Project state (nodes, cables, layout, viewport,
// tempo, sequencer, master) lives in the .minihub file, is stripped on the way
// out by `SettingsStore.applicationData()` and cleared on launch by
// `ProjectManager.bootstrap()`. The authoritative list of those keys is
// `PROJECT_KEYS` in src/renderer/js/core/projectKeys.js; main is CommonJS and
// cannot import that ES module, so the rule is stated instead: nothing below
// may appear in PROJECT_KEYS, and vice versa.
//
// `networkConnections` used to be declared here, which was the visible symptom of
// the confusion: it is project state, and the default `[]` it injected was
// discarded moments later by the bootstrap that deletes every project key.
const DEFAULTS = {
  selectedInputId: null,
  midiInputPreference: null,
  selectedOutputId: null,
  inputOffsets: {}, // inputId -> timing offset in ms
  audioOutputConfig: null, // { deviceName, sampleRate, bufferSize }
  vstCatalog: [], // last successful VST3 scan, reused before the next scan
  metronomeEnabled: false,
  metronomeVolume: 0.35,
  recentProjectPath: null,
  recentProjectName: null,
  recentDirectories: {} // purpose -> last folder chosen in a picker; see recentDirectories.js
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

/**
 * Write the application preferences.
 *
 * `owner` says who produced the object. The renderer sends its whole in-memory
 * copy, taken at launch, so anything main recorded since then (the picker
 * folders) is missing from it and would be erased; those keys are carried over
 * from the file instead. Main's own writes are already built on a fresh read
 * and are taken as-is.
 */
function saveSettings(settings, { owner = 'renderer' } = {}) {
  const next = owner === 'main' ? settings : carryDirectoryMemory(settings, loadSettings());
  // Atomic write: settings are saved on every network/layout change, so a crash
  // (or a power cut) mid-write used to leave a truncated JSON file, which
  // loadSettings then silently discarded along with every node and cable.
  const target = settingsPath();
  const tmp = `${target}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
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

/** Record `directory` as the folder MiniHub uses for `purpose` from now on. */
function rememberDirectory(purpose, directory) {
  const settings = loadSettings();
  const next = withDirectory(settings, purpose, directory);
  if (next === settings) return false;
  return saveSettings(next, { owner: 'main' });
}

/** Same, from a file the user picked in a dialog: its folder is what matters. */
function rememberDirectoryOfFile(purpose, filePath) {
  const settings = loadSettings();
  const next = withDirectoryOfFile(settings, purpose, filePath);
  if (next === settings) return false;
  return saveSettings(next, { owner: 'main' });
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
  return applyPluginStateChunk(settings, message) && saveSettings(settings, { owner: 'main' });
}

module.exports = {
  loadSettings,
  saveSettings,
  rememberDirectory,
  rememberDirectoryOfFile,
  applyPluginStateChunk,
  persistPluginStateChunk,
  DEFAULTS
};
