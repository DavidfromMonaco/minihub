import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectManager } from '../src/renderer/js/core/projectManager.js';

test('project replacement is visibly refused while Record is active', async () => {
  const calls = [];
  const blocked = [];
  const hub = {
    sequencer: {
      recording: true,
      stopRecording() { calls.push('record:stop'); }
    },
    events: { emit(type, payload) { blocked.push({ type, payload }); } },
    engine: {
      async sequencerQuiesce() { calls.push('quiesce'); },
      setChainMidiEnabled(id, enabled) { calls.push(`midi:${id}:${enabled}`); },
      setChainOutputEnabled(id, enabled) { calls.push(`audio:${id}:${enabled}`); },
      removeInstance(chainId, instanceId) { calls.push(`remove:${chainId}:${instanceId}`); }
    },
    nodes: { list: () => [{ id: 'vst-001', type: 'vst', content: { plugins: [{ id: 'plugin-1' }] } }] }
  };
  const staged = new Map();
  const oldSessionStorage = globalThis.sessionStorage;
  const oldLocation = globalThis.location;
  const oldAlert = globalThis.alert;
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    setItem(key, value) { staged.set(key, value); }
  } });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: {
    reload() { calls.push('reload'); }
  } });
  Object.defineProperty(globalThis, 'alert', { configurable: true, value: (message) => calls.push(`alert:${message}`) });
  try {
    const manager = new ProjectManager(hub, {});
    assert.equal(await manager._replace({ projectId: 'next' }, 'C:/next.minihub'), false);
  } finally {
    if (oldSessionStorage === undefined) delete globalThis.sessionStorage;
    else Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: oldSessionStorage });
    if (oldLocation === undefined) delete globalThis.location;
    else Object.defineProperty(globalThis, 'location', { configurable: true, value: oldLocation });
    if (oldAlert === undefined) delete globalThis.alert;
    else Object.defineProperty(globalThis, 'alert', { configurable: true, value: oldAlert });
  }
  assert.deepEqual(calls, ['alert:Cannot change project while recording. Stop recording first.']);
  assert.equal(staged.size, 0, 'no replacement project is staged');
  assert.deepEqual(blocked, [{
    type: 'project:blocked',
    payload: {
      reason: 'recording-active',
      action: 'change project',
      message: 'Cannot change project while recording. Stop recording first.'
    }
  }]);
});

test('project replacement still stops transport and panics when not recording', async () => {
  const calls = [];
  const hub = {
    sequencer: { recording: false, stopRecording() { calls.push('unexpected-record-stop'); } },
    engine: {
      async sequencerQuiesce() { calls.push('quiesce'); await Promise.resolve(); calls.push('quiesce:queued'); }
    },
    nodes: { list: () => [] }
  };
  const oldSessionStorage = globalThis.sessionStorage;
  const oldLocation = globalThis.location;
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { setItem() {} } });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { reload() { calls.push('reload'); } } });
  try {
    await new ProjectManager(hub, {})._replace({ projectId: 'next' }, null, true);
  } finally {
    if (oldSessionStorage === undefined) delete globalThis.sessionStorage;
    else Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: oldSessionStorage });
    if (oldLocation === undefined) delete globalThis.location;
    else Object.defineProperty(globalThis, 'location', { configurable: true, value: oldLocation });
  }
  assert.deepEqual(calls, ['quiesce', 'quiesce:queued', 'reload']);
});

test('project replacement closes Clip Editors before native quiesce and renderer handoff', async () => {
  const calls = [];
  const hub = {
    sequencer: { recording: false },
    engine: { async sequencerQuiesce() { calls.push('quiesce'); } },
    nodes: { list: () => [] }
  };
  const api = { async clipEditorCloseAll(reason) { calls.push(`close:${reason}`); } };
  const oldSessionStorage = globalThis.sessionStorage;
  const oldLocation = globalThis.location;
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { setItem() { calls.push('stage'); } } });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { reload() { calls.push('reload'); } } });
  try {
    await new ProjectManager(hub, api)._replace({ projectId: 'next' }, null, true);
  } finally {
    if (oldSessionStorage === undefined) delete globalThis.sessionStorage;
    else Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: oldSessionStorage });
    if (oldLocation === undefined) delete globalThis.location;
    else Object.defineProperty(globalThis, 'location', { configurable: true, value: oldLocation });
  }
  assert.deepEqual(calls, ['stage', 'close:project-transition', 'quiesce', 'reload']);
});

test('project staging failure leaves the current native runtime completely untouched', async () => {
  const calls = [];
  const hub = {
    sequencer: { recording: false },
    events: { emit(type) { calls.push(type); } },
    engine: { sequencerQuiesce() { throw new Error('must not quiesce'); } },
    nodes: { list() { throw new Error('must not tear down'); } }
  };
  const api = { clipEditorCloseAll() { throw new Error('must not close editors'); } };
  const oldSessionStorage = globalThis.sessionStorage;
  const oldAlert = globalThis.alert;
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    setItem() { calls.push('stage'); throw new Error('storage denied'); }
  } });
  Object.defineProperty(globalThis, 'alert', { configurable: true, value: () => calls.push('alert') });
  try {
    assert.equal(await new ProjectManager(hub, api)._replace({ projectId: 'next' }, null, true), false);
  } finally {
    if (oldSessionStorage === undefined) delete globalThis.sessionStorage;
    else Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: oldSessionStorage });
    if (oldAlert === undefined) delete globalThis.alert;
    else Object.defineProperty(globalThis, 'alert', { configurable: true, value: oldAlert });
  }
  assert.deepEqual(calls, ['stage', 'project:transition-error', 'alert']);
});

test('reload failure restores the quiesced old project before any VST teardown', async () => {
  const calls = [];
  const hub = {
    sequencer: {
      recording: false,
      beginProjectTransition() { calls.push('begin'); },
      finishProjectTransition(committed) { calls.push(`finish:${committed}`); },
      syncNative() { calls.push('resync'); }
    },
    engine: { async sequencerQuiesce() { calls.push('quiesce'); } },
    nodes: { list() { throw new Error('must not tear down when reload fails'); } }
  };
  const api = {
    clipEditorCloseAll() { calls.push('close'); },
    clipEditorReady() { calls.push('ready'); }
  };
  const oldSessionStorage = globalThis.sessionStorage;
  const oldLocation = globalThis.location;
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    setItem() { calls.push('stage'); }, removeItem() { calls.push('unstage'); }
  } });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: {
    reload() { calls.push('reload'); throw new Error('navigation rejected'); }
  } });
  try {
    await assert.rejects(new ProjectManager(hub, api)._replace({ projectId: 'next' }, null, true),
      /navigation rejected/);
  } finally {
    if (oldSessionStorage === undefined) delete globalThis.sessionStorage;
    else Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: oldSessionStorage });
    if (oldLocation === undefined) delete globalThis.location;
    else Object.defineProperty(globalThis, 'location', { configurable: true, value: oldLocation });
  }
  assert.deepEqual(calls, [
    'stage', 'begin', 'close', 'quiesce', 'reload',
    'finish:false', 'unstage', 'resync', 'ready'
  ]);
});

test('project replacement rechecks Record after the quiesce acknowledgement', async () => {
  const calls = [];
  const hub = {
    sequencer: { recording: false, syncNative() { calls.push('resync'); } },
    events: { emit(type) { calls.push(type); } },
    engine: {
      async sequencerQuiesce() {
        calls.push('quiesce');
        await Promise.resolve();
        hub.sequencer.recording = true;
      }
    },
    nodes: { list: () => { calls.push('teardown'); return []; } }
  };
  const oldSessionStorage = globalThis.sessionStorage;
  const oldLocation = globalThis.location;
  const oldAlert = globalThis.alert;
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    setItem() { calls.push('stage'); }
  } });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: {
    reload() { calls.push('reload'); }
  } });
  Object.defineProperty(globalThis, 'alert', { configurable: true, value: () => calls.push('alert') });
  try {
    const manager = new ProjectManager(hub, {});
    assert.equal(await manager._replace({ projectId: 'next' }, null), false);
    assert.equal(manager._transitionPending, false, 'transition lock is always released');
  } finally {
    if (oldSessionStorage === undefined) delete globalThis.sessionStorage;
    else Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: oldSessionStorage });
    if (oldLocation === undefined) delete globalThis.location;
    else Object.defineProperty(globalThis, 'location', { configurable: true, value: oldLocation });
    if (oldAlert === undefined) delete globalThis.alert;
    else Object.defineProperty(globalThis, 'alert', { configurable: true, value: oldAlert });
  }
  assert.deepEqual(calls, ['stage', 'quiesce', 'project:blocked', 'alert', 'resync'],
    'a late Record prevents teardown/reload and republishes the old arrangement');
});

test('an aborted project transition reopens Clip Editor creation for the current renderer', async () => {
  const calls = [];
  const hub = {
    sequencer: { recording: false, syncNative() { calls.push('resync'); } },
    events: { emit() { calls.push('blocked'); } },
    engine: { async sequencerQuiesce() { calls.push('quiesce'); hub.sequencer.recording = true; } },
    nodes: { list: () => { throw new Error('must not tear down'); } }
  };
  const api = {
    clipEditorCloseAll() { calls.push('close'); },
    clipEditorReady() { calls.push('ready'); }
  };
  const oldSessionStorage = globalThis.sessionStorage;
  const oldLocation = globalThis.location;
  const oldAlert = globalThis.alert;
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    setItem() { calls.push('stage'); }, removeItem() { calls.push('unstage'); }
  } });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { reload() { calls.push('reload'); } } });
  Object.defineProperty(globalThis, 'alert', { configurable: true, value: () => calls.push('alert') });
  try {
    assert.equal(await new ProjectManager(hub, api)._replace({ projectId: 'next' }, null), false);
  } finally {
    if (oldSessionStorage === undefined) delete globalThis.sessionStorage;
    else Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: oldSessionStorage });
    if (oldLocation === undefined) delete globalThis.location;
    else Object.defineProperty(globalThis, 'location', { configurable: true, value: oldLocation });
    if (oldAlert === undefined) delete globalThis.alert;
    else Object.defineProperty(globalThis, 'alert', { configurable: true, value: oldAlert });
  }
  assert.deepEqual(calls, ['stage', 'close', 'quiesce', 'blocked', 'alert', 'unstage', 'resync', 'ready']);
});

test('a native acknowledgement reports late Record and aborts while replaying the old-project event buffer', async () => {
  const calls = [];
  const hub = {
    sequencer: {
      recording: false,
      beginProjectTransition() { calls.push('begin'); },
      finishProjectTransition(committed) { calls.push(`finish:${committed}`); },
      syncNative() { calls.push('resync'); }
    },
    events: { emit(type) { calls.push(type); } },
    engine: { async sequencerQuiesce() { calls.push('quiesce'); return { wasRecording: true }; } },
    nodes: { list: () => { throw new Error('must not tear down after late Record'); } }
  };
  const api = {
    clipEditorCloseAll() { calls.push('close'); },
    clipEditorReady() { calls.push('ready'); }
  };
  const oldSessionStorage = globalThis.sessionStorage;
  const oldLocation = globalThis.location;
  const oldAlert = globalThis.alert;
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    setItem() { calls.push('stage'); }, removeItem() { calls.push('unstage'); }
  } });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { reload() { calls.push('reload'); } } });
  Object.defineProperty(globalThis, 'alert', { configurable: true, value: () => calls.push('alert') });
  try {
    assert.equal(await new ProjectManager(hub, api)._replace({ projectId: 'next' }, null), false);
  } finally {
    if (oldSessionStorage === undefined) delete globalThis.sessionStorage;
    else Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: oldSessionStorage });
    if (oldLocation === undefined) delete globalThis.location;
    else Object.defineProperty(globalThis, 'location', { configurable: true, value: oldLocation });
    if (oldAlert === undefined) delete globalThis.alert;
    else Object.defineProperty(globalThis, 'alert', { configurable: true, value: oldAlert });
  }
  assert.deepEqual(calls, [
    'stage', 'begin', 'close', 'quiesce', 'project:blocked', 'alert',
    'finish:false', 'unstage', 'resync', 'ready'
  ]);
});

test('New and Basic template are refused before any project transition while recording', async () => {
  const messages = [];
  const hub = {
    sequencer: { recording: true },
    events: { emit(type, payload) { messages.push({ type, payload }); } }
  };
  const oldAlert = globalThis.alert;
  Object.defineProperty(globalThis, 'alert', { configurable: true, value: (message) => messages.push(message) });
  try {
    const manager = new ProjectManager(hub, {});
    manager._replace = () => { throw new Error('replacement must not start'); };
    assert.equal(await manager.newProject(), false);
    assert.equal(await manager.newFromBasicTemplate(), false);
  } finally {
    if (oldAlert === undefined) delete globalThis.alert;
    else Object.defineProperty(globalThis, 'alert', { configurable: true, value: oldAlert });
  }
  assert.equal(messages.filter((entry) => typeof entry === 'string').length, 2,
    'both user actions produce a visible refusal');
  assert.ok(messages.filter((entry) => typeof entry === 'string')
    .every((message) => /Stop recording first\./.test(message)));
});

test('Load is refused before picker/read and rechecked after each asynchronous boundary', async () => {
  const oldAlert = globalThis.alert;
  Object.defineProperty(globalThis, 'alert', { configurable: true, value: () => {} });
  try {
    {
      const calls = [];
      const hub = { sequencer: { recording: true }, events: { emit() {} } };
      const api = {
        projectPickOpen() { calls.push('pick'); },
        projectRead() { calls.push('read'); }
      };
      assert.equal(await new ProjectManager(hub, api).load(), false);
      assert.deepEqual(calls, [], 'an already-active take prevents even opening the picker');
    }

    {
      const calls = [];
      const hub = { sequencer: { recording: false }, events: { emit() {} } };
      const api = {
        async projectPickOpen() { calls.push('pick'); hub.sequencer.recording = true; return 'C:/picked.minihub'; },
        projectRead() { calls.push('read'); }
      };
      assert.equal(await new ProjectManager(hub, api).load(), false);
      assert.deepEqual(calls, ['pick'], 'Record starting in the picker prevents the disk read');
    }

    {
      const calls = [];
      const hub = { sequencer: { recording: false }, events: { emit() {} } };
      const api = {
        async projectRead() {
          calls.push('read');
          hub.sequencer.recording = true;
          return { ok: true, project: { projectId: 'loaded' } };
        }
      };
      const manager = new ProjectManager(hub, api);
      manager._replace = () => { calls.push('replace'); return true; };
      assert.equal(await manager.load('C:/direct.minihub'), false);
      assert.deepEqual(calls, ['read'], 'Record starting during the read prevents replacement');
    }
  } finally {
    if (oldAlert === undefined) delete globalThis.alert;
    else Object.defineProperty(globalThis, 'alert', { configurable: true, value: oldAlert });
  }
});

test('Save refuses stale snapshots when native VST state capture rejects or throws', async () => {
  const oldAlert = globalThis.alert;
  const alerts = [];
  Object.defineProperty(globalThis, 'alert', { configurable: true, value: (message) => alerts.push(message) });
  try {
    for (const capture of [
      async () => ({ ok: false, reason: 'engine-not-started' }),
      async () => { throw new Error('capture-timeout'); }
    ]) {
      let writes = 0;
      const events = [];
      const hub = {
        events: { emit(type, payload) { events.push({ type, payload }); } },
        settings: { async setMany() { throw new Error('must not mark recent project'); } }
      };
      const api = {
        capturePluginStates: capture,
        async projectWrite() { writes += 1; return { ok: true }; }
      };
      const manager = new ProjectManager(hub, api);
      manager.currentProjectPath = 'C:/existing.minihub';
      manager.dirty = true;

      assert.equal(await manager.save(false), false);
      assert.equal(manager.dirty, true, 'a failed capture cannot mark the project clean');
      assert.equal(writes, 0, 'no stale project snapshot reaches disk');
      assert.equal(events.at(-1).type, 'project:save-error');
      assert.equal(events.at(-1).payload.reason, 'plugin-state-capture-failed');
    }
  } finally {
    if (oldAlert === undefined) delete globalThis.alert;
    else Object.defineProperty(globalThis, 'alert', { configurable: true, value: oldAlert });
  }
  assert.equal(alerts.length, 2, 'both failure modes are visible');
  assert.match(alerts[0], /engine-not-started/);
  assert.match(alerts[1], /capture-timeout/);
});

test('failed Save As does not partially commit the candidate name or path', async () => {
  const oldAlert = globalThis.alert;
  Object.defineProperty(globalThis, 'alert', { configurable: true, value: () => {} });
  let attemptedSnapshot;
  const hub = {
    events: { emit() {} },
    graph: { serialize: () => [] },
    settings: { get: () => null, async setMany() { throw new Error('must not update recents'); } },
    sequencer: { model: { snapshot: () => null } }
  };
  const api = {
    capturePluginStates: async () => ({ ok: true }),
    projectPickSave: async () => 'C:/FailedName.minihub',
    async projectWrite(_filePath, snapshot) { attemptedSnapshot = snapshot; return { ok: false, error: 'disk-full' }; }
  };
  try {
    const manager = new ProjectManager(hub, api);
    Object.assign(manager, {
      currentProjectPath: 'C:/Original.minihub', currentProjectName: 'Original', dirty: true
    });
    assert.equal(await manager.save(true), false);
    assert.equal(attemptedSnapshot.name, 'FailedName', 'the candidate file contents use the Save As name');
    assert.equal(manager.currentProjectName, 'Original');
    assert.equal(manager.currentProjectPath, 'C:/Original.minihub');
    assert.equal(manager.dirty, true);
  } finally {
    if (oldAlert === undefined) delete globalThis.alert;
    else Object.defineProperty(globalThis, 'alert', { configurable: true, value: oldAlert });
  }
});

test('Cancel on a dirty New, Basic, or Load performs no picker, quiesce, staging, or reload', async () => {
  const oldConfirm = globalThis.confirm;
  const oldSessionStorage = globalThis.sessionStorage;
  const oldLocation = globalThis.location;
  const calls = [];
  Object.defineProperty(globalThis, 'confirm', { configurable: true, value: (message) => { calls.push(`confirm:${message}`); return false; } });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    setItem() { calls.push('stage'); }, removeItem() { calls.push('unstage'); }
  } });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { reload() { calls.push('reload'); } } });
  try {
    const hub = {
      sequencer: { recording: false },
      events: { emit(type) { if (type === 'project:blocked') calls.push('blocked'); } },
      engine: { sequencerQuiesce() { calls.push('quiesce'); } },
      nodes: { list() { calls.push('teardown'); return []; } }
    };
    const api = {
      projectPickOpen() { calls.push('pick'); },
      projectRead() { calls.push('read'); }
    };
    const manager = new ProjectManager(hub, api);
    manager._loading = false;
    manager.dirty = true;

    assert.equal(await manager.newProject(), false);
    assert.equal(await manager.newFromBasicTemplate(), false);
    assert.equal(await manager.load(), false);
  } finally {
    if (oldConfirm === undefined) delete globalThis.confirm;
    else Object.defineProperty(globalThis, 'confirm', { configurable: true, value: oldConfirm });
    if (oldSessionStorage === undefined) delete globalThis.sessionStorage;
    else Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: oldSessionStorage });
    if (oldLocation === undefined) delete globalThis.location;
    else Object.defineProperty(globalThis, 'location', { configurable: true, value: oldLocation });
  }
  assert.equal(calls.filter((call) => call.startsWith('confirm:')).length, 3);
  assert.equal(calls.filter((call) => call === 'blocked').length, 3);
  assert.ok(!calls.some((call) => ['pick', 'read', 'quiesce', 'stage', 'unstage', 'reload', 'teardown'].includes(call)));
});

test('approved dirty New and Load carry one explicit discard authorization into replacement', async () => {
  const oldConfirm = globalThis.confirm;
  let confirmations = 0;
  Object.defineProperty(globalThis, 'confirm', { configurable: true, value: () => { confirmations += 1; return true; } });
  try {
    const hub = { sequencer: { recording: false }, events: { emit() {} } };
    const api = {
      async projectRead() { return { ok: true, project: { projectId: 'loaded' } }; }
    };
    const manager = new ProjectManager(hub, api);
    manager.dirty = true;
    const replacements = [];
    manager._replace = (...args) => { replacements.push(args); return true; };

    assert.equal(await manager.newProject(), true);
    manager.dirty = true;
    assert.equal(await manager.load('C:/loaded.minihub'), true);
    assert.equal(confirmations, 2);
    assert.equal(replacements.length, 2);
    assert.deepEqual(replacements.map((args) => args[3]), [
      { discardApproved: true }, { discardApproved: true }
    ]);
  } finally {
    if (oldConfirm === undefined) delete globalThis.confirm;
    else Object.defineProperty(globalThis, 'confirm', { configurable: true, value: oldConfirm });
  }
});

test('project identity publication tells the close guard what to save and where', () => {
  const published = [];
  const hub = { events: { emit() {} } };
  const manager = new ProjectManager(hub, { projectSetCloseState(state) { published.push(state); } });
  manager.publish();
  manager.dirty = true;
  manager.publish();
  manager.currentProjectPath = 'C:/Projects/Session 4.minihub';
  manager.currentProjectName = 'Session 4';
  manager.publish();
  assert.deepEqual(published, [
    { dirty: false, hasFile: false, name: 'Untitled' },
    { dirty: true, hasFile: false, name: 'Untitled' },
    { dirty: true, hasFile: true, name: 'Session 4' }
  ]);
});

test('a close-time save on a project with a file writes it in place, with no picker and no alert', async () => {
  const oldAlert = globalThis.alert;
  const alerts = [];
  Object.defineProperty(globalThis, 'alert', { configurable: true, value: (message) => alerts.push(message) });
  const written = [];
  try {
    const hub = {
      events: { emit() {} },
      graph: { serialize: () => [] },
      settings: { get: () => null, async setMany() {} },
      sequencer: { model: { snapshot: () => null } }
    };
    const api = {
      capturePluginStates: async () => ({ ok: true }),
      projectPickSave: async () => { throw new Error('a project with a file must not open a picker'); },
      async projectWrite(filePath) { written.push(filePath); return { ok: true }; }
    };
    const manager = new ProjectManager(hub, api);
    Object.assign(manager, {
      currentProjectPath: 'C:/Projects/Session 4.minihub', currentProjectName: 'Session 4', dirty: true, _loading: false
    });

    assert.deepEqual(await manager.saveForClose(), { ok: true, reason: '' });
    assert.deepEqual(written, ['C:/Projects/Session 4.minihub']);
    assert.equal(manager.dirty, false);
    assert.deepEqual(alerts, [], 'the close guard owns the dialogs while the window is closing');
  } finally {
    if (oldAlert === undefined) delete globalThis.alert;
    else Object.defineProperty(globalThis, 'alert', { configurable: true, value: oldAlert });
  }
});

test('a close-time save reports a dismissed picker as cancelled, and a failure as its message', async () => {
  const oldAlert = globalThis.alert;
  const alerts = [];
  Object.defineProperty(globalThis, 'alert', { configurable: true, value: (message) => alerts.push(message) });
  try {
    const hub = {
      events: { emit() {} },
      graph: { serialize: () => [] },
      settings: { get: () => null, async setMany() {} },
      sequencer: { model: { snapshot: () => null } }
    };
    const cancelled = new ProjectManager(hub, {
      capturePluginStates: async () => ({ ok: true }),
      projectPickSave: async () => null,
      projectWrite: async () => { throw new Error('nothing may be written after a cancelled picker'); }
    });
    Object.assign(cancelled, { dirty: true, _loading: false });
    assert.deepEqual(await cancelled.saveForClose(), { ok: false, reason: 'cancelled' });
    assert.equal(cancelled.dirty, true);

    const failed = new ProjectManager(hub, {
      capturePluginStates: async () => ({ ok: false, reason: 'engine-not-started' }),
      projectWrite: async () => ({ ok: true })
    });
    Object.assign(failed, { currentProjectPath: 'C:/Projects/Session 4.minihub', dirty: true, _loading: false });
    const outcome = await failed.saveForClose();
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason, /engine-not-started/);
    assert.equal(failed.dirty, true);
    assert.deepEqual(alerts, [], 'a close-time failure travels back as a reason, not as a modal');
  } finally {
    if (oldAlert === undefined) delete globalThis.alert;
    else Object.defineProperty(globalThis, 'alert', { configurable: true, value: oldAlert });
  }
});

test('the close-time save request is always answered, even when saving throws', async () => {
  const hub = { events: { emit() {} } };
  let handler;
  const results = [];
  const api = {
    onProjectSaveRequest(callback) { handler = callback; return () => {}; },
    projectSaveResult(result) { results.push(result); },
    capturePluginStates: async () => { throw new Error('engine gone'); }
  };
  const manager = new ProjectManager(hub, api);
  manager.bindCloseSave();
  Object.assign(manager, { dirty: true, _loading: false });

  await handler({ requestId: 'close-save-1', mode: 'save' });
  assert.equal(results.length, 1);
  assert.equal(results[0].requestId, 'close-save-1');
  assert.equal(results[0].ok, false);
  assert.match(results[0].reason, /engine gone/);

  manager.dirty = false;
  await handler({ requestId: 'close-save-2', mode: 'save' });
  assert.deepEqual(results[1], { requestId: 'close-save-2', ok: true, reason: '' },
    'a clean project answers immediately instead of rewriting the file');
});
