'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { loadSettings, saveSettings } = require('./settings');
const { EngineProcess } = require('./engine');
const diagnostics = require('./diagnostics');

let mainWindow = null;
let engine = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#191b1e',
    title: 'MiniLab Hub',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  // Relay renderer console messages to the main-process log so native-engine and
  // renderer issues are visible in one place. Electron >= 37 passes a single
  // details object; the old (event, level, message) signature logged `undefined`.
  mainWindow.webContents.on('console-message', (details) => {
    const level = details && details.level;
    const message = details && details.message;
    const tag = level === 'error' || level === 'warning' ? '[renderer]' : '[renderer:info]';
    console.log(tag, message);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// --- Native audio engine lifecycle ------------------------------------------

function startEngine() {
  if (engine) return;
  engine = new EngineProcess({
    onEvent: (msg) => {
      console.log(`[engine:event] ${msg.type}${msg.count !== undefined ? ' count=' + msg.count : ''}`);
      diagnostics.log(`engine:event ${msg.type}${msg.count !== undefined ? ' count=' + msg.count : ''}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('engine:event', msg);
      }
    },
    onStateChange: (state, error) => {
      console.log(`[engine] state: ${state}${error ? ' — ' + error : ''}`);
      diagnostics.log(`engine:state ${state}${error ? ' error=' + error : ''}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('engine:state', { state, error });
      }
    }
  });
  engine.start();
}

async function stopEngine() {
  if (!engine) return;
  const e = engine;
  engine = null;
  await e.shutdown();
}

app.whenReady().then(() => {
  diagnostics.logStartupInfo();
  createWindow();
  startEngine();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async (event) => {
  if (engine) {
    event.preventDefault();
    await stopEngine();
    app.quit();
  }
});

// --- Settings IPC -----------------------------------------------------------
ipcMain.handle('settings:load', () => loadSettings());
ipcMain.handle('settings:save', (_event, settings) => saveSettings(settings));

// --- Diagnostics IPC --------------------------------------------------------
ipcMain.handle('diagnostics:log', (_event, line) => {
  diagnostics.log(String(line));
  return true;
});

// --- Engine IPC -------------------------------------------------------------

// The renderer may only ask for commands the protocol actually defines. This
// keeps the exposed IPC surface a fixed, reviewable list rather than "whatever
// object the renderer serializes", without changing the protocol itself.
const ALLOWED_ENGINE_COMMANDS = new Set([
  'hello',
  'listDevices',
  'selectDevice',
  'getDeviceState',
  'scanVst3',
  'listPlugins',
  'createInstance',
  'removeInstance',
  'reorderChain',
  'setBypass',
  'midi',
  'setChainMidiEnabled',
  'setChainOutputEnabled',
  'openEditor',
  'closeEditor',
  'getState',
  'setState'
  // 'shutdown' is deliberately absent: the engine lifecycle belongs to the
  // main process, not to the renderer.
]);

ipcMain.handle('engine:command', (_event, msg) => {
  const type = msg && msg.type;
  if (!ALLOWED_ENGINE_COMMANDS.has(type)) {
    console.log('[engine:command] REJECTED unknown-command:', type);
    return { ok: false, reason: 'unknown-command' };
  }
  if (!engine) {
    console.log('[engine:command] REJECTED engine-not-started:', type);
    return { ok: false, reason: 'engine-not-started' };
  }
  const ok = engine.send(msg);
  if (!ok) console.log(`[engine:command] ${type} -> WRITE FAILED`);
  return { ok };
});

ipcMain.handle('engine:state', () => {
  return { state: engine ? engine.state : 'stopped', error: engine ? engine.error : null };
});
