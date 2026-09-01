import test from 'node:test';
import assert from 'node:assert/strict';
import { createHomeModule } from '../src/renderer/js/modules/home/homeModule.js';
import { PROJECT_WORKSPACE_MODULE, shouldConsumeStagedProject } from '../src/renderer/js/core/projectManager.js';

test('Home first render needs only cached recent-project metadata', () => {
  let engineTouched = false;
  const hub = {
    settings: { get: (key) => ({ recentProjectName: 'Ambient', recentProjectPath: 'C:/Ambient.minihub' })[key] },
    project: { newProject() {}, newFromBasicTemplate() {}, load() {} }
  };
  Object.defineProperty(hub, 'engine', { get() { engineTouched = true; throw new Error('engine must not be read'); } });
  const container = { innerHTML: '', onclick: null };
  createHomeModule(hub).mount(container);
  assert.equal(engineTouched, false);
  assert.match(container.innerHTML, />Ambient</);
  assert.doesNotMatch(container.innerHTML, /VST|Engine|loading/i);
});

test('Home recent tile does not deserialize or open the project', () => {
  let loads = 0;
  const hub = {
    settings: { get: (key) => key === 'recentProjectName' ? 'Cached Name' : 'C:/large.minihub' },
    project: { newProject() {}, newFromBasicTemplate() {}, load() { loads += 1; } }
  };
  const container = { innerHTML: '', onclick: null };
  createHomeModule(hub).mount(container);
  assert.equal(loads, 0);
  assert.match(container.innerHTML, /Cached Name/);
});

test('a click on a tile pictogram or label still runs the tile action', () => {
  const calls = [];
  const hub = {
    settings: { get: (key) => key === 'recentProjectName' ? 'Ambient' : 'C:/Ambient.minihub' },
    project: {
      newProject() { calls.push('new'); },
      newFromBasicTemplate() { calls.push('template'); },
      load(path) { calls.push(`load:${path || ''}`); }
    }
  };
  const container = { innerHTML: '', onclick: null };
  const home = createHomeModule(hub);
  home.mount(container);

  // The click never lands on the button itself - it lands on the pictogram or
  // the label inside it.
  const tile = (action) => ({ dataset: { projectAction: action } });
  const childOf = (action) => ({ closest: () => tile(action) });
  container.onclick({ target: childOf('new') });
  container.onclick({ target: childOf('template') });
  container.onclick({ target: childOf('recent') });
  container.onclick({ target: childOf('load') });
  assert.deepEqual(calls, ['new', 'template', 'load:C:/Ambient.minihub', 'load:']);

  // A click on empty space is not an action.
  container.onclick({ target: { closest: () => null } });
  assert.equal(calls.length, 4);

  // Home must not keep listening on the shared content element.
  home.unmount();
  assert.equal(container.onclick, null);
});

test('staged full project handoff is consumed only by an intentional renderer reload', () => {
  assert.equal(shouldConsumeStagedProject('navigate'), false);
  assert.equal(shouldConsumeStagedProject('back_forward'), false);
  assert.equal(shouldConsumeStagedProject(undefined), false);
  assert.equal(shouldConsumeStagedProject('reload'), true);
});

test('new, loaded, and template projects use Routing as their workspace destination', () => {
  assert.equal(PROJECT_WORKSPACE_MODULE, 'routing');
});
