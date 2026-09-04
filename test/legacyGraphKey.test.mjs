import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectManager } from '../src/renderer/js/core/projectManager.js';
import { LEGACY_PROJECT_KEYS, PURGEABLE_PROJECT_KEYS, PROJECT_KEYS } from '../src/renderer/js/core/projectKeys.js';

/** The smallest hub ProjectManager.applySnapshot needs. */
function makeProject() {
  const data = {};
  const hub = {
    settings: { data, get: (key) => data[key] },
    network: { serialize: () => [] },
    sequencer: { model: { snapshot: () => null } },
    events: { emit() {} }
  };
  return { data, project: new ProjectManager(hub, {}) };
}

/**
 * D-019 renamed `graph` to `network` everywhere, including the block a
 * `.minihub` file stores its cables in. Both spellings are format version 1,
 * so nothing in the file itself distinguishes them -- the reader has to accept
 * either. `Saves/Duo Nappe Arpeggios.minihub` is a real piece of music written
 * before the rename, and it is the reason these tests exist.
 */

/** A project shaped the way builds before D-019 wrote one. */
function legacyProject() {
  return {
    format: 'minihub-project',
    version: 1,
    projectId: 'p1',
    name: 'Duo Nappe Arpeggios',
    createdAt: '2026-08-18T00:00:00.000Z',
    modifiedAt: '2026-08-18T00:00:00.000Z',
    graph: {
      connections: [{ from: 'a', fromPort: 'o', to: 'b', toPort: 'i' }],
      layout: { a: { x: 40, y: 80 } },
      viewport: { x: 12, y: 34, scale: 1.5 }
    },
    nodeInstances: { instances: [], idSeq: {} },
    transport: { bpm: 96 }
  };
}

test('a project written before the rename still opens', () => {
  const { data, project } = makeProject();
  project.applySnapshot(legacyProject(), 'Duo Nappe Arpeggios.minihub');

  assert.deepEqual(data.networkConnections, [
    { from: 'a', fromPort: 'o', to: 'b', toPort: 'i' }
  ]);
  assert.deepEqual(data.networkLayout, { a: { x: 40, y: 80 } });
  assert.deepEqual(data.networkViewport, { x: 12, y: 34, scale: 1.5 });
  assert.equal(data.transportBpm, 96);
  assert.equal(project.currentProjectName, 'Duo Nappe Arpeggios');
});

test('the new spelling wins when a project somehow carries both', () => {
  const project = legacyProject();
  project.network = { connections: [], layout: { z: { x: 1, y: 2 } }, viewport: null };

  const { data, project: manager } = makeProject();
  manager.applySnapshot(project, null);

  assert.deepEqual(data.networkConnections, []);
  assert.deepEqual(data.networkLayout, { z: { x: 1, y: 2 } });
});

test('an empty project does not resurrect anything', () => {
  const { data, project } = makeProject();
  project.applySnapshot({ format: 'minihub-project', version: 1, name: 'Empty' }, null);

  assert.deepEqual(data.networkConnections, []);
  assert.deepEqual(data.networkLayout, {});
  assert.equal(data.networkViewport, null);
});

test('legacy keys stay purgeable, so old settings.json cannot leak forward', () => {
  // Dropping them from the purge list is the quiet failure projectKeys.js was
  // written to prevent: stale project state surviving into a new project, and
  // reaching the machine-wide settings file.
  for (const key of LEGACY_PROJECT_KEYS) {
    assert.ok(PURGEABLE_PROJECT_KEYS.includes(key), `${key} must still be purged`);
    assert.ok(!PROJECT_KEYS.includes(key), `${key} must not be written any more`);
  }
  assert.deepEqual(LEGACY_PROJECT_KEYS, ['graphConnections', 'graphLayout', 'graphViewport']);
});
