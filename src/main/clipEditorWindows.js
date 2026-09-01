'use strict';

const CLIP_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const OPERATIONS = new Set(['quantize', 'add-note', 'update-note', 'delete-notes', 'update-audio']);
const TRANSPORT_ACTIONS = new Set(['return-start', 'play', 'stop']);
const QUANTIZE_GRIDS = new Set(['1/4', '1/8', '1/16', '1/32', '1/8 triplet', '1/16 triplet']);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const validIdList = (value) => Array.isArray(value) && value.length <= 65536
  && value.every((id) => typeof id === 'string' && CLIP_ID.test(id));

function validPayload(operation, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try { if (JSON.stringify(value).length > 65536) return false; } catch (_) { return false; }
  if (operation === 'quantize') {
    return (value.grid === undefined || QUANTIZE_GRIDS.has(value.grid))
      && (value.strength === undefined || (finite(value.strength) && Number(value.strength) >= 0 && Number(value.strength) <= 100))
      && (value.scope === undefined || ['selected', 'entire'].includes(value.scope))
      && (value.timing === undefined || ['starts', 'starts+ends'].includes(value.timing))
      && (value.selectedNoteIds === undefined || validIdList(value.selectedNoteIds));
  }
  if (operation === 'add-note') {
    return ['startPpq', 'durationPpq', 'pitch', 'velocity', 'channel'].every((key) => finite(value[key]));
  }
  if (operation === 'update-note') {
    if (!CLIP_ID.test(String(value.noteId || '')) || !value.changes || typeof value.changes !== 'object' || Array.isArray(value.changes)) return false;
    const keys = Object.keys(value.changes);
    return keys.length > 0 && keys.every((key) => ['startPpq', 'durationPpq', 'pitch', 'velocity', 'channel'].includes(key) && finite(value.changes[key]));
  }
  if (operation === 'delete-notes') return validIdList(value.noteIds);
  if (operation === 'update-audio') {
    const keys = Object.keys(value);
    return keys.length > 0 && keys.every((key) => ['trimStartSeconds', 'trimEndSeconds', 'gain'].includes(key) && finite(value[key]));
  }
  return false;
}

function validTransportState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.length <= 6
    && keys.every((key) => ['ppqPosition', 'playing', 'recording', 'bpm'].includes(key))
    && (value.ppqPosition === undefined || (finite(value.ppqPosition) && value.ppqPosition >= 0))
    && (value.bpm === undefined || (finite(value.bpm) && value.bpm >= 20 && value.bpm <= 300))
    && (value.playing === undefined || typeof value.playing === 'boolean')
    && (value.recording === undefined || typeof value.recording === 'boolean');
}

class ClipEditorWindows {
  constructor({ BrowserWindow, ipcMain, path, mainWindow, preloadPath, editorHtmlPath, requestTimeoutMs = 5000, log = () => {} }) {
    Object.assign(this, { BrowserWindow, ipcMain, path, mainWindow, preloadPath, editorHtmlPath, requestTimeoutMs, log });
    this.windows = new Map();
    this.windowContents = new WeakMap();
    this.pending = new Map();
    this.requestSeq = 0;
    this.bound = false;
    this.acceptingOpens = true;
  }

  setMainWindow(window) { this.mainWindow = window; }

  _contents(window) { return window ? this.windowContents.get(window) || window.webContents : null; }

  _isContentsLive(contents) {
    return !!contents && (typeof contents.isDestroyed !== 'function' || !contents.isDestroyed());
  }

  _isWindowLive(window) {
    return !!window && !window.isDestroyed() && this._isContentsLive(this._contents(window));
  }

  _isMainSender(event) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return false;
    const contents = this.mainWindow.webContents;
    return this._isContentsLive(contents) && event?.sender?.id === contents.id;
  }

  _editorForSender(event) {
    for (const [clipId, window] of this.windows) {
      const contents = this._contents(window);
      if (this._isWindowLive(window) && contents.id === event?.sender?.id) return { clipId, window, contents };
    }
    return null;
  }

  _retire(clipId, window, reason) {
    if (this.windows.get(clipId) === window) this.windows.delete(clipId);
    const contents = this._contents(window);
    if (contents) this._rejectPendingFor(contents.id, reason);
  }

  _broadcast(channel, payload) {
    for (const [clipId, window] of [...this.windows]) {
      if (!this._isWindowLive(window)) {
        this._retire(clipId, window, 'editor-renderer-gone');
        if (!window.isDestroyed()) window.close();
        continue;
      }
      this._contents(window).send(channel, payload);
    }
  }

  bind() {
    if (this.bound) return;
    this.bound = true;
    this.ipcMain.handle('clip-editor:open', (event, clipId) => {
      if (!this._isMainSender(event) || !CLIP_ID.test(String(clipId || ''))) return { ok: false, reason: 'invalid-request' };
      if (!this.acceptingOpens) return { ok: false, reason: 'project-transition' };
      return this.open(String(clipId));
    });
    this.ipcMain.handle('clip-editor:get', (event, clipId) => {
      const editor = this._editorForSender(event);
      if (!editor || editor.clipId !== clipId) return { ok: false, reason: 'invalid-request' };
      return this._requestCanonical(editor, 'get', null, null, '');
    });
    this.ipcMain.handle('clip-editor:update', (event, clipId, expectedProjectId, operation, payload) => {
      const editor = this._editorForSender(event);
      if (!editor || editor.clipId !== clipId || !PROJECT_ID.test(String(expectedProjectId || ''))
          || !OPERATIONS.has(operation) || !validPayload(operation, payload)) return { ok: false, reason: 'invalid-request' };
      return this._requestCanonical(editor, 'update', operation, payload, expectedProjectId);
    });
    this.ipcMain.handle('clip-editor:transport', (event, clipId, expectedProjectId, action) => {
      const editor = this._editorForSender(event);
      if (!editor || editor.clipId !== clipId || !PROJECT_ID.test(String(expectedProjectId || ''))
          || !TRANSPORT_ACTIONS.has(action)) return { ok: false, reason: 'invalid-request' };
      return this._requestCanonical(editor, 'transport', action, null, expectedProjectId);
    });
    this.ipcMain.handle('clip-editor:respond', (event, response) => {
      if (!this._isMainSender(event) || !response || typeof response.requestId !== 'string') return false;
      const pending = this.pending.get(response.requestId);
      if (!pending) return false;
      this.pending.delete(response.requestId);
      clearTimeout(pending.timer);
      pending.resolve(response);
      return true;
    });
    this.ipcMain.handle('clip-editor:invalidate', (event) => {
      if (!this._isMainSender(event)) return false;
      this._broadcast('clip-editor:changed');
      return true;
    });
    this.ipcMain.handle('clip-editor:transport-publish', (event, state) => {
      if (!this._isMainSender(event) || !validTransportState(state)) return false;
      this._broadcast('clip-editor:transport-state', state);
      return true;
    });
    this.ipcMain.handle('clip-editor:close-all', (event, reason) => {
      if (!this._isMainSender(event)) return false;
      const boundedReason = typeof reason === 'string' ? reason : 'project-transition';
      if (boundedReason === 'project-transition') this.acceptingOpens = false;
      this.closeAll(boundedReason);
      return true;
    });
    this.ipcMain.handle('clip-editor:ready', (event) => {
      if (!this._isMainSender(event)) return false;
      this.acceptingOpens = true;
      return true;
    });
  }

  open(clipId) {
    const existing = this.windows.get(clipId);
    if (this._isWindowLive(existing)) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      return { ok: true, reused: true };
    }
    if (existing) {
      this._retire(clipId, existing, 'editor-renderer-gone');
      if (!existing.isDestroyed()) existing.close();
    }
    const window = new this.BrowserWindow({
      width: 1080,
      height: 720,
      minWidth: 720,
      minHeight: 480,
      show: false,
      parent: this.mainWindow,
      modal: false,
      backgroundColor: '#191b1e',
      title: 'MiniHub Clip Editor',
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    });
    const contents = window.webContents;
    this.windowContents.set(window, contents);
    this.windows.set(clipId, window);
    window.once('ready-to-show', () => { if (!window.isDestroyed()) window.show(); });
    window.on('closed', () => {
      this._retire(clipId, window, 'editor-closed');
    });
    contents.on?.('console-message', (details, level, message, line, sourceId) => {
      const severity = details?.level ?? level ?? 'info';
      const text = details?.message ?? message ?? '';
      const source = details?.sourceId ?? sourceId ?? '';
      const lineNumber = details?.lineNumber ?? line ?? 0;
      this.log(`console clip=${clipId} level=${severity} source=${source}:${lineNumber} message=${String(text).slice(0, 4096)}`);
    });
    contents.on?.('preload-error', (_event, preloadPath, error) => {
      this.log(`preload-error clip=${clipId} path=${preloadPath} error=${error?.stack || error?.message || error}`);
    });
    contents.on?.('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (isMainFrame) this.log(`load-error clip=${clipId} code=${code} description=${description} url=${url}`);
    });
    contents.on?.('render-process-gone', (_event, details) => {
      this.log(`renderer-gone clip=${clipId} reason=${details?.reason || 'unknown'} exitCode=${details?.exitCode ?? 'unknown'}`);
      this._retire(clipId, window, 'editor-renderer-gone');
      if (!window.isDestroyed()) window.close();
    });
    const load = window.loadFile(this.editorHtmlPath, { query: { clipId } });
    Promise.resolve(load).catch((error) => {
      this.log(`load-rejected clip=${clipId} error=${error?.stack || error?.message || error}`);
      this._retire(clipId, window, 'editor-load-failed');
      if (!window.isDestroyed()) window.close();
    });
    return { ok: true, reused: false };
  }

  _requestCanonical(editor, kind, operation, payload, expectedProjectId) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return Promise.resolve({ ok: false, reason: 'main-window-unavailable' });
    const mainContents = this.mainWindow.webContents;
    if (!this._isContentsLive(mainContents) || !this._isContentsLive(editor.contents)) {
      return Promise.resolve({ ok: false, reason: 'renderer-unavailable' });
    }
    const requestId = `clip-request-${++this.requestSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ ok: false, reason: 'main-renderer-timeout' });
      }, this.requestTimeoutMs);
      this.pending.set(requestId, { resolve, timer, editorWebContentsId: editor.contents.id });
      mainContents.send('clip-editor:request', {
        requestId, kind, clipId: editor.clipId, expectedProjectId, operation, payload
      });
    });
  }

  _rejectPendingFor(webContentsId, reason) {
    for (const [requestId, pending] of this.pending) {
      if (pending.editorWebContentsId !== webContentsId) continue;
      this.pending.delete(requestId);
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, reason });
    }
  }

  closeAll(reason = 'closed') {
    for (const [clipId, window] of [...this.windows]) {
      this._retire(clipId, window, reason);
      if (!window.isDestroyed()) window.close();
    }
    this.windows.clear();
  }
}

module.exports = {
  ClipEditorWindows, CLIP_ID, PROJECT_ID, OPERATIONS, TRANSPORT_ACTIONS, validPayload, validTransportState
};
