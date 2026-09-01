'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hubAPI', {
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  projectDefaultDirectory: () => ipcRenderer.invoke('project:default-directory'),
  projectPickOpen: () => ipcRenderer.invoke('project:pick-open'),
  projectPickSave: (name) => ipcRenderer.invoke('project:pick-save', name),
  audioPickSave: (name, format) => ipcRenderer.invoke('audio:pick-save', name, format),
  audioPickOpen: () => ipcRenderer.invoke('audio:pick-open'),
  audioCommitTake: (sourcePath, name) => ipcRenderer.invoke('audio:commit-take', sourcePath, name),
  projectRead: (filePath) => ipcRenderer.invoke('project:read', filePath),
  projectWrite: (filePath, project) => ipcRenderer.invoke('project:write', filePath, project),
  projectSetDirty: (dirty) => ipcRenderer.send('project:dirty-state', dirty === true),
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
  }
});
