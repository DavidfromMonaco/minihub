'use strict';

const { installConsoleStreamGuards } = require('./consoleStreamGuard');
installConsoleStreamGuards();

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
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
const { loadSettings, saveSettings, persistPluginStateChunk } = require('./settings');
const { createEngineEventTrace } = require('./engineEventTrace');
const { EngineProcess } = require('./engine');
const diagnostics = require('./diagnostics');
const { isValidSetVstParameterCommand } = require('./vstParameterCommand');
const { isValidSetVstParameterLearnCommand } = require('./vstParameterLearnCommand');
const { isValidSelectDeviceCommand } = require('./audioDeviceCommand');
const { isValidLoadPresetChunksCommand } = require('./presetCommand');
const {
  defaultRoots, listPresets, readPresetChunks, savePresetFile,
  readCatalogueCache, writeCatalogueCache
} = require('./presetStore');
const { fetchCatalogue, downloadEntry, normalizeEntry } = require('./presetSource');
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
ipcMain.on('project:dirty-state', (event, dirty) => {
  // Only the canonical main renderer may control the BrowserWindow close
  // guard. Clip Editors and stale WebContents cannot clear this state.
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return;
  projectCloseGuard?.setDirty(dirty === true);
});

function projectsDirectory() {
  return path.join(app.getPath('documents'), 'MiniHub', 'Projects');
}
ipcMain.handle('project:default-directory', () => projectsDirectory());
ipcMain.handle('project:pick-open', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    defaultPath: projectsDirectory(), properties: ['openFile'],
    filters: [{ name: 'MiniHub Project', extensions: ['minihub'] }]
  });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle('project:pick-save', async (_event, name) => {
  const safeName = String(name || 'Untitled').replace(/[<>:"/\\|?*]/g, '-');
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: path.join(projectsDirectory(), `${safeName}.minihub`),
    filters: [{ name: 'MiniHub Project', extensions: ['minihub'] }]
  });
  return result.canceled ? null : result.filePath;
});
ipcMain.handle('audio:pick-save', async (_event, name, requestedFormat) => {
  const format = audioExportFormat(requestedFormat);
  const definition = AUDIO_EXPORT_FORMATS[format];
  const safeName = String(name || 'MiniHub Take').replace(/[<>:"/\\|?*]/g, '-');
  const result = await dialog.showSaveDialog(mainWindow, { defaultPath: path.join(app.getPath('music'), `${safeName}.${definition.extension}`), filters: [{ name: definition.label, extensions: [definition.extension] }] });
  return result.canceled ? null : audioExportFilePath(result.filePath, format);
});
ipcMain.handle('audio:pick-open', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    defaultPath: app.getPath('music'), properties: ['openFile'],
    filters: [{ name: 'Audio', extensions: ['wav', 'mp3', 'aif', 'aiff', 'flac', 'ogg'] }]
  });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle('audio:commit-take', (_event, sourcePath, name) => {
  try {
    const fs = require('fs');
    if (typeof sourcePath !== 'string' || !fs.statSync(sourcePath).isFile()) throw new Error('Recorded take does not exist');
    const safeName = String(name || 'MiniHub Take').replace(/[<>:"/\\|?*]/g, '-');
    const directory = path.join(app.getPath('music'), 'MiniHub Recordings');
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
// --- Local preset library -------------------------------------------------
//
// The renderer has no disk, so the scan and the read happen here. Both are
// bounded by the same roots, resolved once: `presetStore` re-validates every
// path against them, because "read the preset at this path" arriving from the
// renderer must never become "read this file".
//
// Reading returns base64 chunks to the renderer, which then issues the ordinary
// `loadPresetChunks` engine command. Routing the bytes straight to the engine
// from here would save one hop, but it would put a second path to the engine
// beside `engine:command` -- and DECISIONS.md D-007 exists so that the surface
// the engine can receive stays one readable list.
let presetRoots = null;
const resolvePresetRoots = () => {
  if (presetRoots === null) presetRoots = defaultRoots({ userDataDir: app.getPath('userData') });
  return presetRoots;
};

ipcMain.handle('presets:library', (_event, filter) => {
  const requested = filter && typeof filter.classId === 'string' ? filter.classId : null;
  if (requested !== null && !/^[0-9A-Fa-f]{32}$/.test(requested)) {
    return { ok: false, reason: 'invalid-class-id' };
  }
  try {
    return listPresets({ roots: resolvePresetRoots(), classId: requested });
  } catch (err) {
    return { ok: false, reason: 'scan-failed' };
  }
});

/**
 * A source declaration from settings, or null.
 *
 * Settings are a file the user can edit, so a declaration is validated here
 * rather than trusted; `presetSource` validates the URL it actually fetches
 * again.
 */
const validSource = (raw, index) => {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && raw.id.length > 0 && raw.id.length <= 64
    ? raw.id
    : `source-${index + 1}`;
  if (raw.kind === 'index') {
    return typeof raw.url === 'string' ? { id, kind: 'index', url: raw.url } : null;
  }
  if (raw.kind === 'github') {
    return {
      id,
      kind: 'github',
      owner: raw.owner,
      repo: raw.repo,
      path: raw.path,
      ref: raw.ref,
      plugin: typeof raw.plugin === 'string' ? raw.plugin : null,
      vendor: typeof raw.vendor === 'string' ? raw.vendor : null
    };
  }
  return null;
};

const configuredSources = () => {
  const stored = loadSettings().presetSources;
  return Array.isArray(stored)
    ? stored.map(validSource).filter((source) => source !== null).slice(0, 20)
    : [];
};

ipcMain.handle('presets:sources', () => ({ ok: true, sources: configuredSources() }));

/**
 * The remote catalogue: the cache by default, a refresh only when asked.
 *
 * Nothing here runs on its own. INTENT.md section 7 forbids an automatic update
 * check, and the cache is what keeps the browser useful with the network down:
 * a refresh that fails leaves the previous answer in place rather than emptying
 * the list.
 */
ipcMain.handle('presets:catalogue', async (_event, options) => {
  const roots = resolvePresetRoots();
  if (!options || options.refresh !== true) {
    return { ...readCatalogueCache({ roots }), refreshed: false };
  }
  const sources = configuredSources();
  if (sources.length === 0) {
    return { ok: true, entries: [], refreshedAt: null, refreshed: true, sources: 0 };
  }

  const entries = [];
  const failures = [];
  for (const source of sources) {
    // eslint-disable-next-line no-await-in-loop
    const answer = await fetchCatalogue(source);
    if (answer.ok) entries.push(...answer.entries);
    else failures.push({ source: source.id, reason: answer.reason });
  }
  if (entries.length === 0 && failures.length > 0) {
    // Every source failed: keep what was remembered instead of wiping it.
    return { ...readCatalogueCache({ roots }), refreshed: true, failures };
  }
  writeCatalogueCache({ roots }, entries);
  return { ok: true, entries, refreshedAt: new Date().toISOString(), refreshed: true, failures };
});

/** Download one catalogue entry into MiniHub own preset store. */
ipcMain.handle('presets:download', async (_event, raw) => {
  // The renderer hands back an entry it was given; re-normalizing it means a
  // tampered one cannot widen what gets fetched or where it lands.
  const entry = normalizeEntry(raw, 'download');
  if (!entry) return { ok: false, reason: 'invalid-entry' };

  const downloaded = await downloadEntry(entry);
  if (!downloaded.ok) return downloaded;

  const saved = savePresetFile({
    roots: resolvePresetRoots(),
    vendor: entry.vendor,
    plugin: entry.plugin,
    fileName: entry.fileName,
    bytes: downloaded.bytes
  });
  if (!saved.ok) return saved;
  return { ok: true, path: saved.path, applicable: entry.applicable };
});

ipcMain.handle('presets:read', (_event, filePath) => {
  try {
    return readPresetChunks(filePath, { roots: resolvePresetRoots() });
  } catch (err) {
    return { ok: false, reason: 'read-failed' };
  }
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
  if (type === 'loadPresetChunks') {
    if (!isValidLoadPresetChunksCommand(msg)) {
      console.log('[engine:command] REJECTED invalid-request: loadPresetChunks');
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
