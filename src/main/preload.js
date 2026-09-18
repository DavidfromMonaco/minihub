'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The controller profile, on the page before the first module evaluates.
 *
 * This is the one synchronous call in the preload, and it cannot be anything
 * else. `CONTROLLER_NODE_IDS` in the renderer is a module-level constant derived from
 * the profile, evaluated when the ES module graph loads -- which is before
 * app.js runs a line, and long before any `await hubAPI.*` could resolve. A
 * profile fetched asynchronously would arrive after every consumer had frozen
 * its value, and MiniHub would decode with one profile while naming its node
 * after another.
 *
 * The cost is one blocking round trip per launch, for a file the main process
 * has already read. What it buys is that changing profile is a window reload and
 * nothing else -- no live swap, and not one of the thirty-odd consumers turned
 * into a function call. See src/renderer/js/midi/loadedProfile.js.
 */
contextBridge.exposeInMainWorld('hubProfiles', ipcRenderer.sendSync('profile:current'));

contextBridge.exposeInMainWorld('hubAPI', {
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  projectDefaultDirectory: () => ipcRenderer.invoke('project:default-directory'),
  projectPickOpen: () => ipcRenderer.invoke('project:pick-open'),
  projectPickSave: (name) => ipcRenderer.invoke('project:pick-save', name),
  // Templates are projects kept in their own folder. Their dialogs are separate
  // from the project ones so that saving a template cannot move where a project
  // is saved next -- see `recentDirectories.js` and main's two handlers.
  // `templatePickOpen` answers an object rather than a path: an empty folder is
  // reported instead of a dialog showing nothing.
  templatePickOpen: () => ipcRenderer.invoke('template:pick-open'),
  templatePickSave: (name) => ipcRenderer.invoke('template:pick-save', name),
  audioPickSave: (name, format) => ipcRenderer.invoke('audio:pick-save', name, format),
  audioPickOpen: () => ipcRenderer.invoke('audio:pick-open'),
  audioCommitTake: (sourcePath, name) => ipcRenderer.invoke('audio:commit-take', sourcePath, name),
  // The folders MiniHub files things into, so Settings can show them, change
  // them, and open them. Main validates the purpose; the renderer never sees a
  // path it did not ask for.
  listDirectories: () => ipcRenderer.invoke('directories:list'),
  chooseDirectory: (purpose) => ipcRenderer.invoke('directories:choose', purpose),
  openDirectory: (purpose) => ipcRenderer.invoke('directories:open', purpose),
  projectRead: (filePath) => ipcRenderer.invoke('project:read', filePath),
  projectWrite: (filePath, project) => ipcRenderer.invoke('project:write', filePath, project),
  // The close guard needs more than a dirty bit: a project that already has a
  // file on disk is saved on the way out, one that has never been saved has to
  // ask where. Both facts belong to the renderer's project identity.
  projectSetCloseState: (state) => ipcRenderer.send('project:close-state', {
    dirty: state?.dirty === true,
    hasFile: state?.hasFile === true,
    name: String(state?.name || 'Untitled')
  }),
  onProjectSaveRequest: (callback) => {
    const listener = (_event, request) => callback(request);
    ipcRenderer.on('project:save-request', listener);
    return () => ipcRenderer.removeListener('project:save-request', listener);
  },
  projectSaveResult: (result) => ipcRenderer.send('project:save-result', result),
  // The application menu is in the main process; the project state it acts on
  // is here. See src/main/appMenu.js and core/menuCommands.js.
  onMenuCommand: (callback) => {
    const listener = (_event, command) => callback(command);
    ipcRenderer.on('menu:command', listener);
    return () => ipcRenderer.removeListener('menu:command', listener);
  },
  capturePluginStates: () => ipcRenderer.invoke('engine:capture-states'),
  focusMainWindow: () => ipcRenderer.invoke('window:focus-main'),
  clipEditorOpen: (clipId) => ipcRenderer.invoke('clip-editor:open', clipId),
  clipEditorReady: () => ipcRenderer.invoke('clip-editor:ready'),
  clipEditorCloseAll: (reason) => ipcRenderer.invoke('clip-editor:close-all', reason),
  clipEditorClose: (clipId) => ipcRenderer.invoke('clip-editor:close', clipId),
  clipEditorInvalidate: () => ipcRenderer.invoke('clip-editor:invalidate'),
  clipEditorPublishTransport: (state) => ipcRenderer.invoke('clip-editor:transport-publish', state),
  clipEditorRespond: (response) => ipcRenderer.invoke('clip-editor:respond', response),
  onClipEditorRequest: (callback) => {
    const listener = (_event, request) => callback(request);
    ipcRenderer.on('clip-editor:request', listener);
    return () => ipcRenderer.removeListener('clip-editor:request', listener);
  },

  // --- The bindings bar docked under each plugin editor (D-021) ---
  // Main places the bars; this renderer draws them, because the bindings they
  // show live here. See src/main/bindingsBarWindows.js.
  bindingsBarRender: (chainId, instanceId, html) => ipcRenderer.invoke('bindings-bar:render', { chainId, instanceId, html }),
  bindingsBarValues: (chainId, instanceId, values, replace) => ipcRenderer.invoke('bindings-bar:values', { chainId, instanceId, values, replace }),
  bindingsBarsOpen: () => ipcRenderer.invoke('bindings-bar:list'),
  onBindingsBarWanted: (callback) => {
    const listener = (_event, bar) => callback(bar);
    ipcRenderer.on('bindings-bar:wanted', listener);
    return () => ipcRenderer.removeListener('bindings-bar:wanted', listener);
  },
  onBindingsBarAction: (callback) => {
    const listener = (_event, action) => callback(action);
    ipcRenderer.on('bindings-bar:action', listener);
    return () => ipcRenderer.removeListener('bindings-bar:action', listener);
  },

  // --- Agent channel (INTENT §8 sexies) ---
  // Shaped exactly like the Clip Editor bridge above, because it is the same
  // problem: something outside this renderer asks it to do something the
  // interface can do, and waits for the answer. The renderer still has no
  // socket -- the door is the main process's, and only requests come through.
  agentRespond: (response) => ipcRenderer.invoke('agent:respond', response),
  onAgentRequest: (callback) => {
    const listener = (_event, request) => callback(request);
    ipcRenderer.on('agent:request', listener);
    return () => ipcRenderer.removeListener('agent:request', listener);
  },
  // A plugin's web page is reached by main, which owns the sockets; the renderer
  // only names the plugin and the gesture. See src/main/pluginBrowser.js.
  pluginBrowser: (request) => ipcRenderer.invoke('plugin-browser:request', request),
  windowState: () => ipcRenderer.invoke('window:state'),
  showMainWindow: () => ipcRenderer.invoke('window:show-main'),
  // Exit, asked for by a request. Nothing comes back: the process that would
  // answer is the one going away. See src/main/quitRequest.js.
  quitApplication: (options) => ipcRenderer.send('app:quit', { discardUnsaved: options?.discardUnsaved === true }),

  // --- Startup diagnostics ---
  diagnosticsLog: (line) => ipcRenderer.invoke('diagnostics:log', line),
  runtimeProvenance: () => ipcRenderer.invoke('diagnostics:provenance'),

  // --- Native audio engine ---
  engineCommand: (msg) => ipcRenderer.invoke('engine:command', msg),
  engineState: () => ipcRenderer.invoke('engine:state'),
  onEngineEvent: (cb) => {
    const listener = (_event, msg) => cb(msg);
    ipcRenderer.on('engine:event', listener);
    return () => ipcRenderer.removeListener('engine:event', listener);
  },
  onEngineState: (cb) => {
    const listener = (_event, state) => cb(state);
    ipcRenderer.on('engine:state', listener);
    return () => ipcRenderer.removeListener('engine:state', listener);
  },
  // Controller profiles. Everything here takes effect at the NEXT launch, which
  // is why choosing one is followed by a window reload rather than by a redraw.
  profileList: () => ipcRenderer.invoke('profile:list'),
  profilePick: () => ipcRenderer.invoke('profile:pick'),
  profileImport: (text) => ipcRenderer.invoke('profile:import', text),
  profileSelect: (fileName) => ipcRenderer.invoke('profile:select', fileName),
  profileForget: (fileName) => ipcRenderer.invoke('profile:forget', fileName),
  // A NAMED place on minihub.site, never a URL: main owns the address list.
  // See src/main/externalLinks.js for why that distinction is the whole point.
  siteOpen: (destination) => ipcRenderer.invoke('site:open', destination)
});
