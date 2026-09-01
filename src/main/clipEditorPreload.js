'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clipEditorAPI', {
  get: (clipId) => ipcRenderer.invoke('clip-editor:get', clipId),
  update: (clipId, expectedProjectId, operation, payload) => ipcRenderer.invoke(
    'clip-editor:update', clipId, expectedProjectId, operation, payload
  ),
  transport: (clipId, expectedProjectId, action) => ipcRenderer.invoke(
    'clip-editor:transport', clipId, expectedProjectId, action
  ),
  onChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('clip-editor:changed', listener);
    return () => ipcRenderer.removeListener('clip-editor:changed', listener);
  },
  onTransportState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('clip-editor:transport-state', listener);
    return () => ipcRenderer.removeListener('clip-editor:transport-state', listener);
  }
});
