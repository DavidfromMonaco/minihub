'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The bindings bar draws what the main renderer sends and says what was clicked.
// Nothing here reads or writes a binding: see src/main/bindingsBarWindows.js.
contextBridge.exposeInMainWorld('bindingsBarAPI', {
  ready: () => ipcRenderer.invoke('bindings-bar:ready'),
  action: (action) => ipcRenderer.invoke('bindings-bar:action', action),
  onRender: (callback) => {
    const listener = (_event, html) => callback(html);
    ipcRenderer.on('bindings-bar:render', listener);
    return () => ipcRenderer.removeListener('bindings-bar:render', listener);
  }
});
