'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The controller profile, on the page before the first module evaluates.
 *
 * This is the one synchronous call in the preload, and it cannot be anything
 * else. `MINILAB_NODE_ID` in the renderer is a module-level constant derived from
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
contextBridge.exposeInMainWorld('hubProfile', ipcRenderer.sendSync('profile:current'));

contextBridge.exposeInMainWorld('hubAPI', {
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  projectDefaultDirectory: () => ipcRenderer.invoke('project:default-directory'),
  projectPickOpen: () => ipcRenderer.invoke('project:pick-open'),
  projectPickSave: (name) => ipcRenderer.invoke('project:pick-save', name),
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
  capturePluginStates: () => ipcRenderer.invoke('engine:capture-states'),
  focusMainWindow: () => ipcRenderer.invoke('window:focus-main'),
  clipEditorOpen: (clipId) => ipcRenderer.invoke('clip-editor:open', clipId),
  clipEditorReady: () => ipcRenderer.invoke('clip-editor:ready'),
  clipEditorCloseAll: (reason) => ipcRenderer.invoke('clip-editor:close-all', reason),
  clipEditorInvalidate: () => ipcRenderer.invoke('clip-editor:invalidate'),
  clipEditorPublishTransport: (state) => ipcRenderer.invoke('clip-editor:transport-publish', state),
  clipEditorRespond: (response) => ipcRenderer.invoke('clip-editor:respond', response),
  onClipEditorRequest: (callback) => {
    const listener = (_event, request) => callback(request);
    ipcRenderer.on('clip-editor:request', listener);
    return () => ipcRenderer.removeListener('clip-editor:request', listener);
  },

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
  profileForget: (fileName) => ipcRenderer.invoke('profile:forget', fileName)
});
