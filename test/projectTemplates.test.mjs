import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectManager } from '../src/renderer/js/core/projectManager.js';

/**
 * What separates a template from a project.
 *
 * A template is the same file in another folder, so almost everything about it
 * is already covered by the project tests. What is NOT shared is the whole
 * point of the feature, and it is all negative: saving a template must move
 * nothing about the open project, and starting from one must leave the template
 * on disk untouched no matter how long the session that follows runs.
 *
 * Each of those is one line of code away from being wrong -- a `Save As` with
 * another picker in front of it would look identical and silently make every
 * Ctrl+S overwrite the template the project came from.
 */

/** A hub with the pieces `snapshot()` reads, and a record of what it emitted. */
function makeHub() {
  const events = [];
  return {
    events: { emit: (type, payload) => events.push({ type, payload }) },
    emitted: events,
    network: { serialize: () => [] },
    settings: {
      get: () => null,
      async setMany(values) { events.push({ type: 'settings:setMany', payload: values }); }
    },
    sequencer: { model: { snapshot: () => null } }
  };
}

async function withStubbedGlobals(run) {
  const previous = { alert: globalThis.alert, confirm: globalThis.confirm };
  const alerts = [];
  Object.defineProperty(globalThis, 'alert', { configurable: true, value: (message) => alerts.push(message) });
  Object.defineProperty(globalThis, 'confirm', { configurable: true, value: () => true });
  try {
    // Awaited INSIDE the try: returning the promise would restore the real
    // globals before the first await inside `run` had even been reached.
    return await run(alerts);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[name];
      else Object.defineProperty(globalThis, name, { configurable: true, value });
    }
  }
}

test('Save as Template writes the template and moves nothing about the open project', async () => {
  const hub = makeHub();
  const writes = [];
  const api = {
    capturePluginStates: async () => ({ ok: true }),
    templatePickSave: async (name) => { writes.push(`picked:${name}`); return 'D:/Templates/Live Rig.minihub'; },
    projectPickSave: async () => { throw new Error('the PROJECT picker must stay out of this'); },
    async projectWrite(filePath, project) { writes.push({ filePath, name: project.name }); return { ok: true }; }
  };
  const manager = new ProjectManager(hub, api);
  manager._loading = false;
  manager.currentProjectPath = 'D:/Projects/Tuesday.minihub';
  manager.currentProjectName = 'Tuesday';
  manager.dirty = true;

  await withStubbedGlobals(async () => {
    assert.equal(await manager.saveAsTemplate(), true);
  });

  assert.deepEqual(writes, [
    'picked:Tuesday',
    { filePath: 'D:/Templates/Live Rig.minihub', name: 'Live Rig' }
  ], 'the template is named by its own file, not by the project it came from');
  assert.equal(manager.currentProjectPath, 'D:/Projects/Tuesday.minihub', 'the project keeps its file');
  assert.equal(manager.currentProjectName, 'Tuesday', 'the project keeps its name');
  assert.equal(manager.dirty, true, 'saving a template has not saved the project');
  assert.equal(hub.emitted.some((entry) => entry.type === 'settings:setMany'), false,
    'a template never becomes the recent project Home would reopen and overwrite');
  assert.equal(hub.emitted.at(-1).type, 'project:template-saved');
});

test('Save as Template refuses to write a snapshot whose VST state was never captured', async () => {
  const hub = makeHub();
  let written = 0;
  const api = {
    capturePluginStates: async () => ({ ok: false, reason: 'engine-not-started' }),
    templatePickSave: async () => { throw new Error('nothing may be picked before the capture succeeds'); },
    async projectWrite() { written += 1; return { ok: true }; }
  };
  const manager = new ProjectManager(hub, api);
  manager._loading = false;

  const alerts = await withStubbedGlobals(async (seen) => {
    assert.equal(await manager.saveAsTemplate(), false);
    return seen;
  });
  assert.equal(written, 0);
  assert.match(alerts[0], /engine-not-started/);
  assert.equal(hub.emitted.at(-1).payload.reason, 'plugin-state-capture-failed');
});

test('a project started from a template has no file, and an identity of its own', async () => {
  const hub = makeHub();
  const template = {
    format: 'minihub-project', version: 1, projectId: 'template-identity', name: 'Live Rig',
    createdAt: '2020-01-01T00:00:00.000Z', modifiedAt: '2020-01-01T00:00:00.000Z',
    network: { connections: [{ from: 'a' }], layout: {}, viewport: null },
    nodeInstances: { instances: [{ id: 'vst-001' }], idSeq: {} },
    transport: { bpm: 96 }
  };
  const api = {
    templatePickOpen: async () => ({ filePath: 'D:/Templates/Live Rig.minihub' }),
    projectRead: async () => ({ ok: true, project: template })
  };
  const manager = new ProjectManager(hub, api);
  manager._loading = false;
  let replaced = null;
  manager._replace = async (project, filePath, unsaved) => { replaced = { project, filePath, unsaved }; return true; };

  await withStubbedGlobals(async () => {
    assert.equal(await manager.newFromTemplate(), true);
  });

  assert.equal(replaced.filePath, null,
    'no file means the first Ctrl+S opens the PROJECT picker, never the template');
  assert.equal(replaced.unsaved, true);
  assert.equal(replaced.project.name, 'Live Rig', 'the template names the project it starts');
  assert.deepEqual(replaced.project.nodeInstances, template.nodeInstances, 'its content comes over whole');
  assert.equal(replaced.project.transport.bpm, 96);
  assert.notEqual(replaced.project.projectId, 'template-identity',
    'two projects born of one template are two projects');
  assert.notEqual(replaced.project.createdAt, template.createdAt);
  assert.equal(template.projectId, 'template-identity', 'the template object itself is not rewritten');
});

test('an empty templates folder explains how a template is made instead of opening a dialog', async () => {
  const hub = makeHub();
  let reads = 0;
  const api = {
    templatePickOpen: async () => ({ empty: true, directory: 'D:/Templates' }),
    projectRead: async () => { reads += 1; return { ok: false }; }
  };
  const manager = new ProjectManager(hub, api);
  manager._loading = false;
  manager._replace = () => { throw new Error('nothing may be replaced'); };

  const alerts = await withStubbedGlobals(async (seen) => {
    assert.equal(await manager.newFromTemplate(), false);
    return seen;
  });
  assert.equal(reads, 0);
  assert.match(alerts[0], /Save as Template/, 'the message names the action that makes one');
  assert.equal(hub.emitted.at(-1).payload.reason, 'no-templates');
});

test('a cancelled template dialog leaves the current project exactly where it was', async () => {
  const hub = makeHub();
  const api = {
    capturePluginStates: async () => ({ ok: true }),
    templatePickOpen: async () => ({ cancelled: true }),
    templatePickSave: async () => null,
    projectWrite: async () => { throw new Error('a cancelled dialog writes nothing'); }
  };
  const manager = new ProjectManager(hub, api);
  manager._loading = false;
  manager.currentProjectPath = 'D:/Projects/Tuesday.minihub';
  manager.currentProjectName = 'Tuesday';
  manager.dirty = true;
  manager._replace = () => { throw new Error('a cancelled dialog replaces nothing'); };

  const alerts = await withStubbedGlobals(async (seen) => {
    assert.equal(await manager.saveAsTemplate(), false);
    assert.equal(await manager.newFromTemplate(), false);
    return seen;
  });
  assert.deepEqual(alerts, [], 'a step back into the application is not a failure to report');
  assert.equal(manager.currentProjectPath, 'D:/Projects/Tuesday.minihub');
  assert.equal(manager.dirty, true);
});
