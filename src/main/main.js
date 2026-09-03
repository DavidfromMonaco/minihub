'use strict';

const { installConsoleStreamGuards } = require('./consoleStreamGuard');
installConsoleStreamGuards();

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
// Electron's GPU subprocess exits with STATUS_DLL_NOT_FOUND (0xc0000135) on
// the supported Windows runtime used for MiniHub, before the renderer can
// finish loading. MiniHub's UI does not depend on WebGL; select Chromium's
// software renderer synchronously, as required before app.ready, so ordinary
// shortcut launches do not need an undocumented command-line workaround.
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('in-process-gpu');
  app.disableHardwareAcceleration();
}
const path = require('path');
const { FORMATS: AUDIO_EXPORT_FORMATS, audioExportFormat, audioExportFilePath } = require('./audioExportPath');
const { loadSettings, saveSettings, rememberDirectory, rememberDirectoryOfFile, persistPluginStateChunk } = require('./settings');
const { PURPOSES: DIRECTORY_PURPOSES, isKnownPurpose, rememberedDirectory } = require('./recentDirectories');
const { createEngineEventTrace } = require('./engineEventTrace');
const { EngineProcess } = require('./engine');
const diagnostics = require('./diagnostics');
const { isValidSetVstParameterCommand } = require('./vstParameterCommand');
const { isValidSetVstParameterLearnCommand } = require('./vstParameterLearnCommand');
const { isValidSelectDeviceCommand } = require('./audioDeviceCommand');
const { readProject, writeProjectAtomic } = require('./projectFiles');
const { ALLOWED_ENGINE_COMMANDS } = require('./engineCommandPolicy');
const { ClipEditorWindows } = require('./clipEditorWindows');
const { installProjectCloseGuard } = require('./projectCloseGuard');

let mainWindow = null;
let engine = null;
let engineRestartAttempts = 0;
let clipEditorWindows = null;
let projectCloseGuard = null;
const processStartedAt = Date.now() - Math.round(process.uptime() * 1000);
const startupMark = (name) => diagnostics.log(`startup:${name} elapsedMs=${Date.now() - processStartedAt}`);

function createWindow() {
  startupMark('browser-window-create-start');
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#191b1e',
    title: 'MiniLab Hub',
    // Custom app icon (window + taskbar). On Windows the packaged exe already
    // carries the same icon via rcedit; this also covers dev mode (`npm start`)
    // where no custom exe resource exists.
    icon: path.join(__dirname, '../../build/icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  projectCloseGuard = installProjectCloseGuard({
    window: mainWindow,
    dialog,
    requestSave: requestProjectSave,
    log: (line) => diagnostics.log(line)
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  if (!clipEditorWindows) {
    clipEditorWindows = new ClipEditorWindows({
      BrowserWindow, ipcMain, path, mainWindow,
      preloadPath: path.join(__dirname, 'clipEditorPreload.js'),
      editorHtmlPath: path.join(__dirname, '../renderer/clip-editor.html'),
      log: (line) => {
        console.log(`[clip-editor] ${line}`);
        diagnostics.log(`clip-editor:${line}`);
      }
    });
    clipEditorWindows.bind();
  } else {
    clipEditorWindows.setMainWindow(mainWindow);
  }
  startupMark('renderer-load-start');
  mainWindow.webContents.once('dom-ready', () => startupMark('dom-ready'));
  mainWindow.webContents.once('did-finish-load', () => startupMark('renderer-load-complete'));
  mainWindow.on('focus', () => {
    if (engine) engine.send({ v: 1, type: 'foregroundEditors' });
  });

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
    clipEditorWindows?.closeAll('main-window-closed');
    projectCloseGuard?.dispose();
    projectCloseGuard = null;
    mainWindow = null;
  });
}

// --- Native audio engine lifecycle ------------------------------------------

const engineEventTrace = createEngineEventTrace();

function startEngine() {
  if (engine) return;
  engine = new EngineProcess({
    onEvent: (msg) => {
      // Native state capture must survive application shutdown. The renderer
      // may already be gone when the final forced capture arrives, so Electron
      // persists the complete chunk against the same stable plugin identity.
      if (msg.type === 'pluginState') persistPluginStateChunk(msg);
      const eventDetails = msg.type === 'instanceStatus'
        ? ` chain=${String(msg.chainId || '').slice(0, 128)} instance=${String(msg.instanceId || '').slice(0, 64)} generation=${Number.isSafeInteger(msg.generation) ? msg.generation : '?'} status=${String(msg.status || '').slice(0, 32)}`
        : (msg.type === 'hello' && msg.nativeProcess
          ? ` role=${String(msg.nativeProcess.role || '').slice(0, 16)} pid=${Number(msg.nativeProcess.pid) || '?'} parentPid=${Number(msg.nativeProcess.parentPid) || '?'} createdAt=${String(msg.nativeProcess.createdAt || '').slice(0, 64)} audioDeviceOpen=${msg.nativeProcess.audioDeviceOpen === true} lifetime=${String(msg.nativeProcess.lifetime || '').slice(0, 32)} reason=${String(msg.nativeProcess.reason || '').slice(0, 128)}`
        : (msg.type === 'error'
          ? ` code=${String(msg.code || '').slice(0, 64)} message=${String(msg.message || '').slice(0, 256)}`
          : (msg.count !== undefined ? ' count=' + msg.count : '')));
      // Periodic telemetry is not written to disk; runtime telemetry only is,
      // and only when the window it describes actually reports a fault.
      const trace = engineEventTrace(msg, eventDetails);
      if (trace !== null) {
        console.log('[' + trace + ']');
        diagnostics.log(trace);
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('engine:event', msg);
      }
    },
    onStderr: (text) => {
      const bounded = String(text).replace(/[\r\n]+/g, ' ').slice(0, 4096);
      diagnostics.log(`engine:stderr ${bounded}`);
    },
    onStateChange: (state, error) => {
      console.log(`[engine] state: ${state}${error ? ' — ' + error : ''}`);
      diagnostics.log(`engine:state ${state}${error ? ' error=' + error : ''}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('engine:state', { state, error });
      }
      if (state === 'running') engineRestartAttempts = 0;
      if (state === 'error' && engineRestartAttempts < 2) {
        const failed = engine;
        engineRestartAttempts += 1;
        setTimeout(() => {
          if (engine !== failed || failed?.child) return;
          engine = null;
          diagnostics.log(`engine: bounded restart attempt=${engineRestartAttempts}`);
          startEngine();
        }, 250);
      }
    }
  });
  diagnostics.log(`engine:resolved-executable path=${engine.exePath} sha256=${engine.executableSha256()}`);
  startupMark('engine-process-launch');
  engine.start();
}

async function stopEngine() {
  if (!engine) return;
  const e = engine;
  engine = null;
  await e.capturePluginStates();
  // pluginState events are forwarded before the completion marker; allow the
  // renderer's settings IPC writes already in flight to commit.
  await new Promise((resolve) => setTimeout(resolve, 100));
  await e.shutdown();
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
else app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show(); mainWindow.focus();
});

if (hasSingleInstanceLock) app.whenReady().then(() => {
  startupMark('electron-ready');
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
  // app.quit() fires before BrowserWindow's close event. Route a dirty quit
  // through the same Cancel/Discard guard before stopping the native engine;
  // otherwise Cancel would leave the application open with audio shut down.
  if (mainWindow && !mainWindow.isDestroyed() && projectCloseGuard?.isDirty()) {
    event.preventDefault();
    mainWindow.close();
    return;
  }
  if (engine) {
    event.preventDefault();
    await stopEngine();
    app.quit();
  }
});

// --- Settings IPC -----------------------------------------------------------
ipcMain.handle('settings:load', () => loadSettings());
ipcMain.handle('settings:save', (_event, settings) => saveSettings(settings));
ipcMain.on('project:close-state', (event, state) => {
  // Only the canonical main renderer may control the BrowserWindow close
  // guard. Clip Editors and stale WebContents cannot clear this state.
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return;
  projectCloseGuard?.setProjectState(state);
});

// The renderer owns the project file: only it can capture VST state and build a
// valid snapshot, so a close-time save is a round trip rather than a call. The
// wait is bounded because a renderer that has stopped answering must not be
// able to wedge the application open with no way out but the task manager.
const PROJECT_SAVE_TIMEOUT_MS = 20000;
const pendingProjectSaves = new Map();
let projectSaveSequence = 0;

function requestProjectSave(mode) {
  return new Promise((resolve) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      resolve({ ok: false, reason: 'The project window is already gone.' });
      return;
    }
    const requestId = `close-save-${++projectSaveSequence}`;
    const settle = (outcome) => {
      if (!pendingProjectSaves.delete(requestId)) return;
      clearTimeout(timer);
      diagnostics.log(`project:save-request ${requestId} mode=${mode} ok=${outcome.ok === true} reason=${outcome.reason || ''}`);
      resolve(outcome);
    };
    const timer = setTimeout(
      () => settle({ ok: false, reason: 'The project window stopped answering.' }),
      PROJECT_SAVE_TIMEOUT_MS
    );
    pendingProjectSaves.set(requestId, settle);
    mainWindow.webContents.send('project:save-request', { requestId, mode });
  });
}

ipcMain.on('project:save-result', (event, result) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return;
  const settle = pendingProjectSaves.get(result?.requestId);
  if (!settle) return;
  settle({ ok: result?.ok === true, reason: String(result?.reason || '').slice(0, 256) });
});

function projectsDirectory() {
  return path.join(app.getPath('documents'), 'MiniHub', 'Projects');
}

// Where MiniHub puts a kind of file when the user has never said otherwise.
// These are starting points, not destinations: every one of them is replaced by
// the user's own folder as soon as they choose one.
function fallbackDirectory(purpose) {
  if (purpose === 'project') return projectsDirectory();
  if (purpose === 'audioRecordings') return path.join(app.getPath('music'), 'MiniHub Recordings');
  return app.getPath('music');
}

// The folder actually used. A picker opens here, and a recorded take is filed
// here. The built-in folder above applies only when there is no memory yet, or
// when the remembered one has since been deleted or unplugged.
function effectiveDirectory(purpose) {
  return rememberedDirectory(loadSettings(), purpose) || fallbackDirectory(purpose);
}

// Seeing and changing those folders without having to trigger an export first:
// a destination the user cannot name is a destination they cannot find again.
ipcMain.handle('directories:list', () => Object.fromEntries(
  DIRECTORY_PURPOSES.map((purpose) => [purpose, effectiveDirectory(purpose)])
));
ipcMain.handle('directories:choose', async (_event, purpose) => {
  if (!isKnownPurpose(purpose)) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a folder',
    defaultPath: effectiveDirectory(purpose),
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled) return null;
  rememberDirectory(purpose, result.filePaths[0]);
  return result.filePaths[0];
});
ipcMain.handle('directories:open', async (_event, purpose) => {
  if (!isKnownPurpose(purpose)) return false;
  const directory = effectiveDirectory(purpose);
  // A folder MiniHub has only ever promised does not exist yet: nothing has
  // been written there. Create it rather than opening the file manager on an
  // error the user cannot act on.
  try { require('fs').mkdirSync(directory, { recursive: true }); } catch (_) {}
  return (await shell.openPath(directory)) === '';
});
ipcMain.handle('project:default-directory', () => projectsDirectory());
ipcMain.handle('project:pick-open', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    defaultPath: effectiveDirectory('project'), properties: ['openFile'],
    filters: [{ name: 'MiniHub Project', extensions: ['minihub'] }]
  });
  if (result.canceled) return null;
  rememberDirectoryOfFile('project', result.filePaths[0]);
  return result.filePaths[0];
});
ipcMain.handle('project:pick-save', async (_event, name) => {
  const safeName = String(name || 'Untitled').replace(/[<>:"/\\|?*]/g, '-');
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: path.join(effectiveDirectory('project'), `${safeName}.minihub`),
    filters: [{ name: 'MiniHub Project', extensions: ['minihub'] }]
  });
  if (result.canceled) return null;
  rememberDirectoryOfFile('project', result.filePath);
  return result.filePath;
});
ipcMain.handle('audio:pick-save', async (_event, name, requestedFormat) => {
  const format = audioExportFormat(requestedFormat);
  const definition = AUDIO_EXPORT_FORMATS[format];
  const safeName = String(name || 'MiniHub Take').replace(/[<>:"/\\|?*]/g, '-');
  const result = await dialog.showSaveDialog(mainWindow, { defaultPath: path.join(effectiveDirectory('audioExport'), `${safeName}.${definition.extension}`), filters: [{ name: definition.label, extensions: [definition.extension] }] });
  if (result.canceled) return null;
  // Remember the folder the user chose, not the one Electron proposed: the
  // next export opens there instead of walking back to Music every time.
  const filePath = audioExportFilePath(result.filePath, format);
  rememberDirectoryOfFile('audioExport', filePath);
  return filePath;
});
ipcMain.handle('audio:pick-open', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    defaultPath: effectiveDirectory('audioImport'), properties: ['openFile'],
    filters: [{ name: 'Audio', extensions: ['wav', 'mp3', 'aif', 'aiff', 'flac', 'ogg'] }]
  });
  if (result.canceled) return null;
  rememberDirectoryOfFile('audioImport', result.filePaths[0]);
  return result.filePaths[0];
});
ipcMain.handle('audio:commit-take', (_event, sourcePath, name) => {
  try {
    const fs = require('fs');
    if (typeof sourcePath !== 'string' || !fs.statSync(sourcePath).isFile()) throw new Error('Recorded take does not exist');
    const safeName = String(name || 'MiniHub Take').replace(/[<>:"/\\|?*]/g, '-');
    const directory = effectiveDirectory('audioRecordings');
    fs.mkdirSync(directory, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destination = path.join(directory, `${safeName}-${stamp}.wav`);
    fs.copyFileSync(sourcePath, destination, fs.constants.COPYFILE_EXCL);
    return { ok: true, filePath: destination };
  } catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.handle('project:read', (_event, filePath) => {
  try { return { ok: true, project: readProject(filePath), filePath }; }
  catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.handle('project:write', (_event, filePath, project) => {
  try { writeProjectAtomic(filePath, project); return { ok: true, filePath }; }
  catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.handle('engine:capture-states', async () => {
  if (!engine) return { ok: false, reason: 'engine-not-started' };
  return { ok: await engine.capturePluginStates() };
});

// --- Diagnostics IPC --------------------------------------------------------
ipcMain.handle('diagnostics:log', (_event, line) => {
  diagnostics.log(String(line));
  return true;
});
ipcMain.handle('diagnostics:provenance', () => diagnostics.runtimeProvenance());

ipcMain.handle('window:focus-main', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.focus();
  return mainWindow.isFocused();
});

// --- Engine IPC -------------------------------------------------------------

// The renderer may only ask for commands the protocol actually defines. This
// keeps the exposed IPC surface a fixed, reviewable list rather than "whatever
// object the renderer serializes", without changing the protocol itself.
ipcMain.handle('engine:command', (_event, msg) => {
  const type = msg && msg.type;
  const validId = (value, pattern, maxLength) => typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && pattern.test(value);
  if (!ALLOWED_ENGINE_COMMANDS.has(type)) {
    console.log('[engine:command] REJECTED unknown-command:', type);
    return { ok: false, reason: 'unknown-command' };
  }
  if (type === 'getVstParameters') {
    if (!msg || msg.v !== 1
        || !validId(msg.requestId, /^[A-Za-z0-9._:-]+$/, 160)
        || !validId(msg.chainId, /^[A-Za-z][A-Za-z0-9_-]*$/, 128)
        || !validId(msg.instanceId, /^plugin-[1-9][0-9]*$/, 64)) {
      return { ok: false, reason: 'invalid-request' };
    }
  }
  if (type === 'selectDevice' && !isValidSelectDeviceCommand(msg)) {
    return { ok: false, reason: 'invalid-request' };
  }
  if (type === 'setVstParameter') {
    if (!isValidSetVstParameterCommand(msg)) {
      return { ok: false, reason: 'invalid-request' };
    }
  }
  if (type === 'setVstParameterLearn') {
    if (!isValidSetVstParameterLearnCommand(msg)) {
      return { ok: false, reason: 'invalid-request' };
    }
  }
  if (type === 'sequencerQuiesce'
      && !validId(msg.requestId, /^quiesce-[A-Za-z0-9._:-]+$/, 160)) {
    return { ok: false, reason: 'invalid-request' };
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
