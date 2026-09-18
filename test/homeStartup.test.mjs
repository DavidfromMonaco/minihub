import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHomeModule } from '../src/renderer/js/modules/home/homeModule.js';
import { PROJECT_WORKSPACE_MODULE, shouldConsumeStagedProject } from '../src/renderer/js/core/projectManager.js';

test('Home first render needs only cached recent-project metadata', () => {
  let engineTouched = false;
  const hub = {
    settings: { get: (key) => ({ recentProjectName: 'Ambient', recentProjectPath: 'C:/Ambient.minihub' })[key] },
    project: { newProject() {}, newFromTemplate() {}, load() {} }
  };
  Object.defineProperty(hub, 'engine', { get() { engineTouched = true; throw new Error('engine must not be read'); } });
  const container = { innerHTML: '', onclick: null };
  createHomeModule(hub).mount(container);
  assert.equal(engineTouched, false);
  assert.match(container.innerHTML, />Ambient</);
  // The page is allowed to SAY what MiniHub hosts -- it now explains the
  // product, VST3 included. What it must never do is wait for any of it: no
  // placeholder, nothing "loading", nothing scanned.
  assert.doesNotMatch(container.innerHTML, /loading|scanning|please wait/i);
});

test('Home recent tile does not deserialize or open the project', () => {
  let loads = 0;
  const hub = {
    settings: { get: (key) => key === 'recentProjectName' ? 'Cached Name' : 'C:/large.minihub' },
    project: { newProject() {}, newFromTemplate() {}, load() { loads += 1; } }
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
      newFromTemplate() { calls.push('template'); },
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

test('a departure button asks main for a NAMED place, and says so when it fails', async () => {
  const asked = [];
  const error = { hidden: true, textContent: '' };
  const hub = {
    settings: { get: () => null },
    project: { newProject() {}, newFromTemplate() {}, load() {} },
    api: { siteOpen: (destination) => { asked.push(destination); return Promise.resolve(destination !== 'site'); } }
  };
  const container = { innerHTML: '', onclick: null, querySelector: () => error };
  const home = createHomeModule(hub);
  home.mount(container);

  // The three places Home offers, and the fact that a URL is not one of them:
  // the renderer only ever spells a name (src/main/externalLinks.js owns the
  // addresses, and refuses anything it does not know).
  assert.match(container.innerHTML, /data-site="source"/);
  assert.match(container.innerHTML, /data-site="site"/);
  assert.match(container.innerHTML, /data-site="report"/);
  assert.doesNotMatch(container.innerHTML, /https?:\/\//);

  container.onclick({ target: { closest: () => ({ dataset: { site: 'source' } }) } });
  await Promise.resolve();
  assert.deepEqual(asked, ['source']);
  assert.equal(error.hidden, true, 'a page that opened says nothing');

  // A browser that refuses is the only case the user cannot see: opening the
  // browser IS the success feedback, so silence would look like a dead button.
  container.onclick({ target: { closest: () => ({ dataset: { site: 'site' } }) } });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(error.hidden, false);
  assert.match(error.textContent, /could not be opened/i);
});

test('every picture the Home cards name is really on disk', () => {
  const hub = {
    settings: { get: () => null },
    project: { newProject() {}, newFromTemplate() {}, load() {} }
  };
  const container = { innerHTML: '', onclick: null };
  createHomeModule(hub).mount(container);

  // A renamed or missing picture leaves a card with a silent hole in it: no
  // error, no log, just a photo that never arrives. The paths are relative to
  // the document, so they are resolved from src/renderer/ exactly as Chromium
  // resolves them.
  const renderer = fileURLToPath(new URL('../src/renderer/', import.meta.url));
  const referenced = [...container.innerHTML.matchAll(/src="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(referenced.length, 4, 'one picture per card');
  for (const reference of referenced) {
    assert.ok(fs.existsSync(path.join(renderer, reference)), `${reference} is referenced but absent`);
  }
});

test('staged full project handoff is consumed only by an intentional renderer reload', () => {
  assert.equal(shouldConsumeStagedProject('navigate'), false);
  assert.equal(shouldConsumeStagedProject('back_forward'), false);
  assert.equal(shouldConsumeStagedProject(undefined), false);
  assert.equal(shouldConsumeStagedProject('reload'), true);
});

test('Home says MiniHub is not welded to the keyboard it is named after', () => {
  // The page carries the product's own claim, so the claim is held by a test:
  // a redesign that drops this sentence leaves MiniHub looking like software
  // for one keyboard, which is what INTENT section 5 calls a defect.
  const hub = { settings: { get: () => null }, project: {} };
  const container = { innerHTML: '', onclick: null };
  createHomeModule(hub).mount(container);

  const key = container.innerHTML.indexOf('home-about-key');
  assert.ok(key >= 0, 'the controller-agnostic sentence has a place of its own');
  assert.ok(key < container.innerHTML.indexOf('home-about-lead'),
    'and it comes first, before what the four cards do');
  assert.match(container.innerHTML, /any MIDI controller/);
  assert.match(container.innerHTML, /data-site="setups"/,
    'and it ends where the reader can act on it');
});

test('new, loaded, and template projects use Routing as their workspace destination', () => {
  assert.equal(PROJECT_WORKSPACE_MODULE, 'routing');
});
