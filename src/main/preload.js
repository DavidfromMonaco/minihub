'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hubAPI', {
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),

  // --- Startup diagnostics ---
  diagnosticsLog: (line) => ipcRenderer.invoke('diagnostics:log', line),

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
