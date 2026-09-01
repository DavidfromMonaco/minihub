'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ClipEditorWindows, validPayload, validTransportState } = require('../src/main/clipEditorWindows');

let nextWebContentsId = 10;
class FakeWebContents {
  constructor() { this.id = nextWebContentsId++; this.sent = []; this.destroyed = false; }
  isDestroyed() { return this.destroyed; }
  send(channel, payload) {
    if (this.destroyed) throw new Error('Object has been destroyed');
    this.sent.push({ channel, payload });
  }
}

class FakeWindow {
  static instances = [];
  constructor(options) {
    this.options = options;
    this.webContents = new FakeWebContents();
    this.listeners = new Map();
    this.onceListeners = new Map();
    this.destroyed = false;
    this.minimized = false;
    this.shown = 0;
    this.focused = 0;
    FakeWindow.instances.push(this);
  }
  on(type, callback) { this.listeners.set(type, callback); }
  once(type, callback) { this.onceListeners.set(type, callback); }
  loadFile(file, options) { this.loaded = { file, options }; }
  isDestroyed() { return this.destroyed; }
  isMinimized() { return this.minimized; }
  restore() { this.minimized = false; }
  show() { this.shown += 1; }
  focus() { this.focused += 1; }
  close() { if (this.destroyed) return; this.webContents.destroyed = true; this.destroyed = true; this.listeners.get('closed')?.(); }
}

function rig() {
  FakeWindow.instances = [];
  nextWebContentsId = 10;
  const handlers = new Map();
  const ipcMain = { handle: (channel, callback) => handlers.set(channel, callback) };
  const mainWindow = { webContents: new FakeWebContents(), isDestroyed: () => false };
  const manager = new ClipEditorWindows({
    BrowserWindow: FakeWindow, ipcMain, path: {}, mainWindow,
    preloadPath: 'clipEditorPreload.js', editorHtmlPath: 'clip-editor.html', requestTimeoutMs: 1000
  });
  manager.bind();
  const mainEvent = { sender: mainWindow.webContents };
  return { manager, handlers, mainWindow, mainEvent };
}

test('same clip editor is focused/reused while different stable IDs get distinct windows', async () => {
  const { handlers, mainEvent } = rig();
  assert.deepEqual(await handlers.get('clip-editor:open')(mainEvent, 'clip-midi-1'), { ok: true, reused: false });
  assert.deepEqual(await handlers.get('clip-editor:open')(mainEvent, 'clip-midi-1'), { ok: true, reused: true });
  assert.deepEqual(await handlers.get('clip-editor:open')(mainEvent, 'clip-midi-2'), { ok: true, reused: false });
  assert.equal(FakeWindow.instances.length, 2);
  assert.equal(FakeWindow.instances[0].focused, 1);
  assert.equal(FakeWindow.instances[0].loaded.options.query.clipId, 'clip-midi-1');
  assert.equal(FakeWindow.instances[1].loaded.options.query.clipId, 'clip-midi-2');
  assert.equal(FakeWindow.instances[0].options.webPreferences.contextIsolation, true);
  assert.equal(FakeWindow.instances[0].options.webPreferences.nodeIntegration, false);
  assert.equal(FakeWindow.instances[0].options.modal, false);
});

test('editor get/update requests resolve only through the canonical main renderer', async () => {
  const { handlers, mainWindow, mainEvent } = rig();
  await handlers.get('clip-editor:open')(mainEvent, 'clip-midi-1');
  const editorEvent = { sender: FakeWindow.instances[0].webContents };

  const getPromise = handlers.get('clip-editor:get')(editorEvent, 'clip-midi-1');
  const getRequest = mainWindow.webContents.sent.at(-1);
  assert.equal(getRequest.channel, 'clip-editor:request');
  assert.deepEqual(
    [getRequest.payload.kind, getRequest.payload.clipId],
    ['get', 'clip-midi-1']
  );
  assert.equal(await handlers.get('clip-editor:respond')(mainEvent, {
    requestId: getRequest.payload.requestId, ok: true, state: { clip: { id: 'clip-midi-1' } }
  }), true);
  assert.equal((await getPromise).state.clip.id, 'clip-midi-1');

  const updatePromise = handlers.get('clip-editor:update')(
    editorEvent, 'clip-midi-1', 'project-1', 'quantize', { grid: '1/16', strength: 100 }
  );
  const updateRequest = mainWindow.webContents.sent.at(-1);
  assert.equal(updateRequest.payload.kind, 'update');
  assert.equal(updateRequest.payload.expectedProjectId, 'project-1');
  assert.equal(updateRequest.payload.operation, 'quantize');
  handlers.get('clip-editor:respond')(mainEvent, { requestId: updateRequest.payload.requestId, ok: true, applied: 1 });
  assert.equal((await updatePromise).applied, 1);
});

test('a window cannot address another clip and IPC arguments are bounded', async () => {
  const { handlers, mainEvent } = rig();
  await handlers.get('clip-editor:open')(mainEvent, 'clip-midi-1');
  const editorEvent = { sender: FakeWindow.instances[0].webContents };
  assert.deepEqual(await handlers.get('clip-editor:get')(editorEvent, 'clip-midi-2'), { ok: false, reason: 'invalid-request' });
  assert.deepEqual(await handlers.get('clip-editor:update')(editorEvent, 'clip-midi-1', 'project-1', 'raw-ipc', {}), { ok: false, reason: 'invalid-request' });
  assert.equal(validPayload('delete-notes', { data: 'x'.repeat(70000) }), false);
  assert.equal(validPayload('delete-notes', { noteIds: ['note-1'] }), true);
  assert.equal(validPayload('update-note', { noteId: 'note-1', changes: null }), false);
  assert.equal(validPayload('update-note', { noteId: 'note-1', changes: { startPpq: 'not-a-number' } }), false);
  assert.equal(validPayload('add-note', { startPpq: null, durationPpq: 1, pitch: 60, velocity: 100, channel: 1 }), false);
  assert.equal(validPayload('add-note', { startPpq: 0, durationPpq: 1, pitch: 60, velocity: 100, channel: 1 }), true);
  assert.equal(validPayload('update-audio', { gain: false }), false);
  assert.equal(validPayload('update-audio', { gain: 0 }), true);
  assert.equal(validPayload('delete-notes', { noteIds: [false] }), false);
});

test('invalidation reaches live editors and project replacement closes orphan windows', async () => {
  const { handlers, mainEvent, manager } = rig();
  await handlers.get('clip-editor:open')(mainEvent, 'clip-midi-1');
  await handlers.get('clip-editor:open')(mainEvent, 'clip-audio-1');
  assert.equal(await handlers.get('clip-editor:invalidate')(mainEvent), true);
  assert.ok(FakeWindow.instances.every((window) => window.webContents.sent.some((item) => item.channel === 'clip-editor:changed')));
  assert.equal(await handlers.get('clip-editor:close-all')(mainEvent, 'project-transition'), true);
  assert.equal(manager.windows.size, 0);
  assert.ok(FakeWindow.instances.every((window) => window.destroyed));
  assert.deepEqual(await handlers.get('clip-editor:open')(mainEvent, 'clip-midi-2'), { ok: false, reason: 'project-transition' },
    'the main process keeps the transition lock after the first close pass');
  assert.equal(await handlers.get('clip-editor:ready')(mainEvent), true);
  assert.deepEqual(await handlers.get('clip-editor:open')(mainEvent, 'clip-midi-2'), { ok: true, reused: false },
    'the replacement renderer explicitly unlocks editor creation when its canonical model is ready');
});

test('renderer teardown cannot turn a concurrent editor invalidation into Object has been destroyed', async () => {
  const { handlers, mainEvent, manager } = rig();
  await handlers.get('clip-editor:open')(mainEvent, 'clip-midi-1');
  const editorWindow = FakeWindow.instances[0];

  // Electron may destroy a renderer's WebContents before the BrowserWindow
  // itself reports destroyed/closed. This is the real close/reload race that a
  // plain BrowserWindow.isDestroyed() guard does not cover.
  editorWindow.webContents.destroyed = true;
  assert.equal(editorWindow.isDestroyed(), false);
  assert.equal(await handlers.get('clip-editor:invalidate')(mainEvent), true);
  assert.equal(manager.windows.has('clip-midi-1'), false);
});

test('Clip Editor transport actions proxy to the canonical renderer and native state broadcasts back', async () => {
  const { handlers, mainWindow, mainEvent } = rig();
  await handlers.get('clip-editor:open')(mainEvent, 'clip-midi-1');
  const editor = FakeWindow.instances[0];
  const editorEvent = { sender: editor.webContents };

  const actionPromise = handlers.get('clip-editor:transport')(
    editorEvent, 'clip-midi-1', 'project-1', 'play'
  );
  const request = mainWindow.webContents.sent.at(-1);
  assert.deepEqual(
    [request.channel, request.payload.kind, request.payload.operation, request.payload.clipId],
    ['clip-editor:request', 'transport', 'play', 'clip-midi-1']
  );
  handlers.get('clip-editor:respond')(mainEvent, {
    requestId: request.payload.requestId,
    ok: true,
    transport: { ppqPosition: 0, playing: true, recording: false, bpm: 120 }
  });
  assert.equal((await actionPromise).transport.playing, true);

  const published = { ppqPosition: 3.25, playing: true, recording: false, bpm: 120 };
  assert.equal(await handlers.get('clip-editor:transport-publish')(mainEvent, published), true);
  assert.deepEqual(editor.webContents.sent.at(-1), {
    channel: 'clip-editor:transport-state', payload: published
  });
  assert.deepEqual(await handlers.get('clip-editor:transport')(
    editorEvent, 'clip-midi-1', 'project-1', 'independent-timer'
  ), { ok: false, reason: 'invalid-request' });
  assert.equal(validTransportState({ ppqPosition: 0, playing: false, recording: false, bpm: 120 }), true);
  assert.equal(validTransportState({ ppqPosition: -1, playing: false }), false);
  assert.equal(validTransportState({ ppqPosition: 0, playing: 'yes' }), false);
});

test('sequential open/close cycles replace WebContents IDs and cannot consume stale responses', async () => {
  const { manager, handlers, mainWindow, mainEvent } = rig();
  manager.bind();
  assert.equal(handlers.size, 9, 'bind remains idempotent and does not accumulate IPC handlers');

  await handlers.get('clip-editor:open')(mainEvent, 'clip-midi-1');
  const firstWindow = FakeWindow.instances[0];
  const firstEvent = { sender: firstWindow.webContents };
  const oldRequest = handlers.get('clip-editor:get')(firstEvent, 'clip-midi-1');
  const oldRequestId = mainWindow.webContents.sent.at(-1).payload.requestId;
  firstWindow.close();
  assert.deepEqual(await oldRequest, { ok: false, reason: 'editor-closed' });

  await handlers.get('clip-editor:open')(mainEvent, 'clip-midi-1');
  const secondWindow = FakeWindow.instances[1];
  assert.notEqual(secondWindow.webContents.id, firstWindow.webContents.id);
  assert.equal(await handlers.get('clip-editor:respond')(mainEvent, {
    requestId: oldRequestId, ok: true, state: { clip: { id: 'stale' } }
  }), false, 'the old renderer response cannot resolve a request for the replacement window');

  const secondEvent = { sender: secondWindow.webContents };
  const currentRequest = handlers.get('clip-editor:get')(secondEvent, 'clip-midi-1');
  const currentId = mainWindow.webContents.sent.at(-1).payload.requestId;
  handlers.get('clip-editor:respond')(mainEvent, {
    requestId: currentId, ok: true, state: { clip: { id: 'clip-midi-1' } }
  });
  assert.equal((await currentRequest).state.clip.id, 'clip-midi-1');
});

test('Clip Editor preload is narrowly scoped and no browser security setting is weakened', () => {
  const preload = fs.readFileSync(path.join(__dirname, '../src/main/clipEditorPreload.js'), 'utf8');
  const windows = fs.readFileSync(path.join(__dirname, '../src/main/clipEditorWindows.js'), 'utf8');
  assert.match(preload, /exposeInMainWorld\('clipEditorAPI'/);
  assert.match(preload, /transport:.*ipcRenderer\.invoke/s);
  assert.match(preload, /onTransportState/);
  assert.doesNotMatch(preload, /exposeInMainWorld\([^,]+,\s*ipcRenderer/);
  assert.doesNotMatch(preload, /engine:command|settings:|project:|audio:/);
  assert.match(windows, /contextIsolation:\s*true/);
  assert.match(windows, /nodeIntegration:\s*false/);
  assert.doesNotMatch(windows, /webSecurity\s*:\s*false/);
  assert.doesNotMatch(windows, /loadURL|https?:\/\//);
});
