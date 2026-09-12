'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  ClipEditorWindows, OPERATIONS, AUDITION_MAX_MS, validAudition, validPayload, validTransportState
} = require('../src/main/clipEditorWindows');

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
  assert.equal(validPayload('move-notes', { noteIds: ['note-1'], deltaPpq: 0.25 }), true);
  assert.equal(validPayload('move-notes', { noteIds: ['note-1'], deltaPitch: -12, deltaDurationPpq: 0 }), true);
  assert.equal(validPayload('move-notes', { noteIds: [] }), false, 'a move of nothing is not a move');
  assert.equal(validPayload('move-notes', { noteIds: ['note-1'] }), false, 'a move with no delta is not a move');
  assert.equal(validPayload('move-notes', { noteIds: ['note-1'], deltaPpq: 'far' }), false);
  assert.equal(validPayload('move-notes', { noteIds: ['note-1'], deltaPpq: 1, pitch: 60 }), false,
    'the payload carries deltas only, never absolute note fields');
});

test('the IPC grid allow-list is exactly the grid table the model declares', async () => {
  // Two lists for one vocabulary, because the process boundary forbids one:
  // main is CommonJS, the model is an ES module. This is what makes a drift
  // between them a failing test rather than a quantize refused as invalid.
  const { QUANTIZE_GRIDS: declared } = await import('../src/renderer/js/core/sequencerModel.js');
  for (const grid of Object.keys(declared)) {
    assert.equal(validPayload('quantize', { grid }), true, `${grid} is accepted over IPC`);
  }
  assert.deepEqual([...OPERATIONS].sort(), [
    'add-note', 'delete-notes', 'duplicate-notes', 'move-notes', 'quantize',
    'set-notes', 'set-snap', 'update-audio', 'update-note'
  ], 'the operation allow-list is enumerated, never inferred');
  assert.equal(validPayload('quantize', { grid: '1/6' }), false);

  assert.equal(validPayload('set-notes', { noteIds: ['note-1'], velocity: 100 }), true);
  assert.equal(validPayload('set-notes', { noteIds: ['note-1'], startPpq: 4 }), false,
    'timing belongs to move-notes: absolute and relative never share a payload');
  assert.equal(validPayload('set-notes', { noteIds: ['note-1'] }), false);
  assert.equal(validPayload('duplicate-notes', { noteIds: ['note-1'] }), true);
  assert.equal(validPayload('duplicate-notes', { noteIds: [] }), false);

  const { SNAP_STEPS } = await import('../src/renderer/js/core/sequencerModel.js');
  for (const snap of Object.keys(SNAP_STEPS)) {
    assert.equal(validPayload('set-snap', { snap }), true, `${snap} is a Snap the editor can set`);
  }
  assert.equal(validPayload('set-snap', { snap: '1/6' }), false);
  assert.equal(validPayload('set-snap', { snap: '1/8', velocity: 1 }), false);
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
  // Named rather than counted: a bare number says nothing about which channel
  // was forgotten, and `bind()` being called twice must still leave one
  // handler per channel.
  assert.deepEqual([...handlers.keys()].sort(), [
    'clip-editor:audition', 'clip-editor:close-all', 'clip-editor:get',
    'clip-editor:history', 'clip-editor:invalidate', 'clip-editor:open',
    'clip-editor:ready', 'clip-editor:respond', 'clip-editor:transport',
    'clip-editor:transport-publish', 'clip-editor:update'
  ], 'bind remains idempotent and does not accumulate IPC handlers');

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

test('sounding a note is its own channel, bounded, and refused for a stale project', async () => {
  const { handlers, mainWindow, mainEvent } = rig();
  await handlers.get('clip-editor:open')(mainEvent, 'clip-midi-1');
  const editorEvent = { sender: FakeWindow.instances[0].webContents };

  const promise = handlers.get('clip-editor:audition')(
    editorEvent, 'clip-midi-1', 'project-1', { pitch: 60, velocity: 90, durationMs: 300 }
  );
  const request = mainWindow.webContents.sent.at(-1);
  assert.equal(request.payload.kind, 'audition',
    'not an update: it changes no model state and must not queue behind edits');
  assert.equal(request.payload.expectedProjectId, 'project-1');
  handlers.get('clip-editor:respond')(mainEvent, { requestId: request.payload.requestId, ok: true, sounded: true });
  assert.equal((await promise).sounded, true);

  assert.deepEqual(
    await handlers.get('clip-editor:audition')(editorEvent, 'clip-midi-2', 'project-1', { pitch: 60 }),
    { ok: false, reason: 'invalid-request' },
    'a window cannot sound a note for another clip'
  );

  assert.equal(validAudition({ pitch: 60 }), true);
  assert.equal(validAudition({ pitch: 0 }), true);
  assert.equal(validAudition({ pitch: 127, velocity: 1, durationMs: AUDITION_MAX_MS }), true);
  assert.equal(validAudition({ pitch: 128 }), false);
  assert.equal(validAudition({ pitch: -1 }), false);
  assert.equal(validAudition({ velocity: 90 }), false, 'a pitch is the one field that is required');
  assert.equal(validAudition({ pitch: 60, velocity: 0 }), false);
  assert.equal(validAudition({ pitch: 60, velocity: 128 }), false);
  // The ceiling is not politeness: the renderer schedules the note-off on this
  // number, so an unbounded one is a note held in a VST for the window's life.
  assert.equal(validAudition({ pitch: 60, durationMs: AUDITION_MAX_MS + 1 }), false);
  assert.equal(validAudition({ pitch: 60, durationMs: 0 }), false);
  assert.equal(validAudition({ pitch: 60, sustain: true }), false, 'and no field beyond the three');
  assert.equal(validAudition(null), false);

  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'clipEditorPreload.js'), 'utf8');
  assert.match(preload, /'clip-editor:audition'/, 'the bridge exposes it, or the editor cannot reach it');
});
