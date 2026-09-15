'use strict';

const { installConsoleStreamGuards } = require('./consoleStreamGuard');
installConsoleStreamGuards();

const { app, BrowserWindow, Menu, ipcMain, dialog, shell } = require('electron');
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
const fs = require('fs');
const { FORMATS: AUDIO_EXPORT_FORMATS, audioExportFormat, audioExportFilePath } = require('./audioExportPath');
const { loadSettings, saveSettings, rememberDirectory, rememberDirectoryOfFile, persistPluginStateChunk } = require('./settings');
const { PURPOSES: DIRECTORY_PURPOSES, isKnownPurpose, rememberedDirectory } = require('./recentDirectories');
const { externalUrlFor } = require('./externalLinks');
const controllerProfiles = require('./controllerProfiles');
const { createEngineEventTrace } = require('./engineEventTrace');
const { EngineProcess } = require('./engine');
const diagnostics = require('./diagnostics');
const { isValidSetVstParameterCommand, isValidGetVstParametersCommand } = require('./vstParameterCommand');
const { isValidSetVstParameterLearnCommand } = require('./vstParameterLearnCommand');
const { isValidSelectDeviceCommand } = require('./audioDeviceCommand');
const { readProject, writeProjectAtomic } = require('./projectFiles');
const { ALLOWED_ENGINE_COMMANDS } = require('./engineCommandPolicy');
const { ClipEditorWindows } = require('./clipEditorWindows');
const { BindingsBarWindows } = require('./bindingsBarWindows');
const { installProjectCloseGuard } = require('./projectCloseGuard');
const { quitOnRequest } = require('./quitRequest');
const { installAppMenu } = require('./appMenu');
const { AgentChannel } = require('./agentChannel');
const { PluginBrowser, withWebViewDebugging } = require('./pluginBrowser');

let mainWindow = null;
let agentChannel = null;
let pluginBrowser = null;
// Empty unless a packaged application launched MiniHub; the engine reports it.
let launchedInsidePackage = '';
let engine = null;
let engineRestartAttempts = 0;
let clipEditorWindows = null;
let bindingsBars = null;
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
    title: 'MiniHub',
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
  // Before the page loads: the menu is the only place the project actions
  // live, so it must exist even if the renderer never finishes starting.
  installAppMenu({ Menu, window: mainWindow });
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
  if (!bindingsBars) {
    bindingsBars = new BindingsBarWindows({
      // `screen` is read here, after app ready, and not at the top of the file:
      // Electron refuses the module before then.
      BrowserWindow, ipcMain, screen: require('electron').screen, mainWindow,
      preloadPath: path.join(__dirname, 'bindingsBarPreload.js'),
      htmlPath: path.join(__dirname, '../renderer/bindings-bar.html'),
      log: (line) => diagnostics.log(`bindings-bar:${line}`)
    });
    bindingsBars.bind();
  } else {
    bindingsBars.setMainWindow(mainWindow);
  }
  startupMark('renderer-load-start');
  mainWindow.webContents.once('dom-ready', () => startupMark('dom-ready'));
  mainWindow.webContents.once('did-finish-load', () => startupMark('renderer-load-complete'));
  // No handler brings plugin windows back when this window takes the focus: the
  // window the person clicks is the one in front. DECISIONS D-040.

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
    // Not owned by this window, so nothing closes them with it -- and a bar left
    // open would keep `window-all-closed` from ever firing.
    bindingsBars?.closeAll('main-window-closed');
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
    // A plugin's web page opens its DevTools port only when its browser starts,
    // and its browser starts inside this process: the argument has to be in the
    // engine's environment from the first instant, or no page is ever reachable.
    env: agentChannelEnabled() ? withWebViewDebugging(process.env) : undefined,
    onEvent: (msg) => {
      if (msg.type === 'hello') recordLaunchContext(msg.nativeProcess);
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
      // Before the renderer: a bar follows its plugin window from here, without
      // waiting on a renderer that may be busy.
      bindingsBars?.onEngineEvent(msg);
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
      bindingsBars?.onEngineState(state);
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

/**
 * Open the agent channel, if it was asked for. INTENT §8 sexies.
 *
 * The environment variable is the demo switch and is named as one: the setting
 * is where the answer belongs, and there is no control in the interface that
 * writes it yet. Inventing that control to make a demo runnable would be
 * inventing product to serve a test.
 *
 * Not asked for is the normal case, and in it nothing is created, nothing
 * listens, and no endpoint file exists.
 */
function agentChannelEnabled() {
  return process.env.MINIHUB_AGENT_CHANNEL === '1' || loadSettings().agentChannel === true;
}

/**
 * Remember whether MiniHub runs under another application's package.
 *
 * Only the engine can tell (Electron has no reliable answer), and the question
 * matters for one reason the person would never guess: a packaged launcher --
 * Codex Desktop -- makes Windows file every folder a plugin creates in AppData
 * inside that launcher's private storage. A plugin logged in under one launch is
 * then logged out under the other. The agent sees this in `describe` and the
 * log keeps it, because nothing on screen will.
 */
function recordLaunchContext(nativeProcess) {
  const name = String(nativeProcess?.packageFamilyName || '').slice(0, 256);
  if (name !== launchedInsidePackage && name) diagnostics.log(`launch:inside-package name=${name}`);
  launchedInsidePackage = name;
}

function startAgentChannel() {
  if (!agentChannelEnabled()) return;
  pluginBrowser = new PluginBrowser({
    queryEngine: (msg, replyType) => (engine ? engine.query(msg, { replyType }) : Promise.resolve(null)),
    fetch: globalThis.fetch,
    WebSocket: globalThis.WebSocket,
    fs,
    log: (line) => diagnostics.log(`plugin-browser:${line}`)
  });
  const endpointPath = path.join(app.getPath('userData'), 'agent-endpoint.json');
  agentChannel = new AgentChannel({
    net: require('net'),
    ipcMain,
    getMainWindow: () => mainWindow,
    writeEndpoint: (endpoint) => {
      try {
        if (endpoint) fs.writeFileSync(endpointPath, JSON.stringify(endpoint, null, 2), { encoding: 'utf8', mode: 0o600 });
        else fs.rmSync(endpointPath, { force: true });
      } catch (error) {
        diagnostics.log(`agent-channel:endpoint:${error && error.message}`);
      }
    },
    log: (line) => {
      console.log(`[agent-channel] ${line}`);
      diagnostics.log(`agent-channel:${line}`);
    }
  });
  agentChannel.bind();
  agentChannel.start();
}

if (hasSingleInstanceLock) app.whenReady().then(() => {
  startupMark('electron-ready');
  diagnostics.logStartupInfo();
  createWindow();
  startEngine();
  startAgentChannel();

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
  // Before the engine, because stopping the engine can defer the quit and the
  // endpoint file must not outlive the door it describes.
  agentChannel?.stop();
  agentChannel = null;
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
// Exit, asked for by a request (the agent channel's `quit`). The same sender
// check as above: a Clip Editor may not close the application it lives in.
ipcMain.on('app:quit', (event, options) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return;
  const discardUnsaved = options?.discardUnsaved === true;
  diagnostics.log(`app:quit requested discardUnsaved=${discardUnsaved}`);
  quitOnRequest({ app, guard: projectCloseGuard, discardUnsaved });
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
/**
 * Open one of MiniHub's own pages in the user's browser.
 *
 * Same shape as `directories:open` just below, and for a stronger reason: the
 * renderer names a destination and `externalLinks.js` answers with the URL, so
 * no string chosen in the renderer ever reaches the operating system. An
 * unknown name is refused rather than opened.
 */
ipcMain.handle('site:open', async (_event, destination) => {
  const url = externalUrlFor(destination);
  if (!url) return false;
  try {
    await shell.openExternal(url);
    return true;
  } catch (_) {
    // No browser, or the shell refused. The page cannot be reached and the
    // caller says so; it is not worth taking the application down.
    return false;
  }
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
/**
 * The controller profiles the user has imported. Application data, not documents:
 * they sit beside settings.json for the same reason it does, and a profile on a
 * disconnected drive would be a MiniHub launching with no controller. See
 * src/main/controllerProfiles.js and DECISIONS.md D-015.
 */
function profilesDirectory() {
  return path.join(app.getPath('userData'), 'profiles');
}

/**
 * The one synchronous channel in this file, and it has to be.
 *
 * `CONTROLLER_NODE_IDS` is a module-level constant in the renderer, evaluated before
 * app.js runs a single line -- so the profile has to be on the page before the
 * first module does. preload asks for it once, here, and nothing else in the
 * session blocks on it.
 */
ipcMain.on('profile:current', (event) => {
  event.returnValue = controllerProfiles.readSelectedProfiles(profilesDirectory(), loadSettings());
});

ipcMain.handle('profile:list', () => ({
  selected: controllerProfiles.selectedFileNames(loadSettings()),
  profiles: controllerProfiles.listProfiles(profilesDirectory())
}));

// Read, not stored: the renderer validates before anything reaches the folder,
// so an invalid file is refused with its faults shown rather than filed away and
// discovered at the next launch.
ipcMain.handle('profile:pick', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    defaultPath: effectiveDirectory('project'), properties: ['openFile'],
    filters: [{ name: 'Controller profile', extensions: ['json'] }]
  });
  if (result.canceled) return null;
  const file = result.filePaths[0];
  try {
    const stat = fs.statSync(file);
    if (stat.size > controllerProfiles.MAX_BYTES) {
      return { fileName: path.basename(file), text: null, error: 'that file is far too large to be a profile' };
    }
    return { fileName: path.basename(file), text: fs.readFileSync(file, 'utf8'), error: null };
  } catch (err) {
    return { fileName: path.basename(file), text: null, error: err.message };
  }
});

// Importing ADDS the keyboard rather than replacing what is loaded. Two
// controllers run at once now, so an import that unselected the MiniLab would
// be an import that unplugs a keyboard the user never mentioned.
ipcMain.handle('profile:import', (_event, text) => {
  const stored = controllerProfiles.storeProfile(profilesDirectory(), text);
  if (!stored.ok) return stored;
  const current = controllerProfiles.selectedFileNames(loadSettings());
  return selectProfileFiles([...current, stored.fileName]);
});

ipcMain.handle('profile:select', (_event, fileNames) => selectProfileFiles(fileNames));

ipcMain.handle('profile:forget', (_event, fileName) =>
  controllerProfiles.forgetProfile(profilesDirectory(), fileName, loadSettings()));

/**
 * Choose which profiles the next launch reads. An empty list means the one that
 * ships, and `null` or a bare name are accepted as the list of none and of one.
 *
 * Written with `owner: 'main'` because this settings object was just read from
 * disk: the renderer's copy is older and carrying its keys over would undo
 * whatever main has recorded since.
 *
 * Every name is checked here AND again on the way out of `selectedFileNames`:
 * what is written passes through a settings file a user can edit, so the two
 * checks are not the same check twice.
 */
function selectProfileFiles(fileNames) {
  const list = Array.isArray(fileNames) ? fileNames : (fileNames === null || fileNames === undefined ? [] : [fileNames]);
  if (list.some((name) => !controllerProfiles.isSafeFileName(name))) {
    return { ok: false, error: 'not a profile file name' };
  }
  if (list.length > controllerProfiles.MAX_SELECTED) {
    return { ok: false, error: `MiniHub runs at most ${controllerProfiles.MAX_SELECTED} controllers at once` };
  }
  const settings = loadSettings();
  if (list.length === 0) delete settings[controllerProfiles.SETTINGS_KEY];
  else settings[controllerProfiles.SETTINGS_KEY] = list;
  if (!saveSettings(settings, { owner: 'main' })) {
    return { ok: false, error: 'the choice could not be written to disk' };
  }
  return { ok: true, fileNames: controllerProfiles.selectedFileNames(settings) };
}

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

/**
 * Put MiniHub's window in front of the person, for an agent about to work in it.
 *
 * Not `window:focus-main`: Windows refuses the foreground to a process the
 * person is not using, so `focus()` alone leaves the window behind whatever they
 * are in and flashes the taskbar -- verified with a browser in front. Passing
 * through the always-on-top band puts the window above everything without
 * taking the keyboard from what they are typing in, and leaving the band at once
 * hands the order straight back to them: the next window they click goes in
 * front of MiniHub as usual. DECISIONS D-040.
 */
ipcMain.handle('window:show-main', (event) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return false;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.setAlwaysOnTop(true);
  mainWindow.setAlwaysOnTop(false);
  mainWindow.moveTop();
  return mainWindow.isVisible() && !mainWindow.isMinimized();
});

/**
 * The windows an agent may be working in, as facts it cannot see for itself.
 *
 * The plugin editors are the renderer's to report (it tracks them from the
 * engine); these are the ones only this process knows: whether MiniHub's own
 * window is even on screen -- a launch with a hidden window style leaves it
 * invisible while everything else answers -- and which clips have a window.
 */
ipcMain.handle('window:state', (event) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return null;
  return {
    main: {
      visible: mainWindow.isVisible(),
      minimized: mainWindow.isMinimized(),
      focused: mainWindow.isFocused()
    },
    clipEditors: clipEditorWindows ? clipEditorWindows.openClipIds() : [],
    launchedInsidePackage: launchedInsidePackage || null
  };
});

// A plugin's web page, acted on for an agent. Only the main renderer may ask,
// and only while the agent channel exists: see src/main/pluginBrowser.js.
ipcMain.handle('plugin-browser:request', (event, request) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
    return { ok: false, reason: 'invalid-request' };
  }
  if (!pluginBrowser) return { ok: false, reason: 'agent-channel-off' };
  return pluginBrowser.handle(request && typeof request === 'object' ? request : {});
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
  if (type === 'getVstParameters' && !isValidGetVstParametersCommand(msg)) {
    return { ok: false, reason: 'invalid-request' };
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
