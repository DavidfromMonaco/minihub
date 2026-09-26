import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHub } from './helpers.mjs';
import { makeEl, fire } from './domShim.mjs';
import { ModuleSystem } from '../src/renderer/js/core/moduleSystem.js';
import { installInterfaceLayout, paneHasKeys, clampSplit } from '../src/renderer/js/ui/interfaceLayout.js';
import { MENU_COMMANDS } from '../src/renderer/js/core/menuCommands.js';

/** A page that records where it is mounted, and whether it still is. */
function page(id, log) {
  return {
    id,
    mounted: null,
    mount(container) { this.mounted = container; log.push(`mount ${id}`); },
    unmount() { this.mounted = null; log.push(`unmount ${id}`); }
  };
}

/** An element whose `contains` answers for its own subtree, as the DOM's does. */
function region(tag = 'div') {
  const el = makeEl(tag);
  el.contains = (node) => {
    for (let cur = node; cur; cur = cur.parentNode) if (cur === el) return true;
    return false;
  };
  return el;
}

function shell(settings = {}) {
  const hub = makeHub(settings);
  hub.modules = new ModuleSystem(hub);
  const log = [];
  const pages = Object.fromEntries(['home', 'routing', 'sequencer'].map((id) => [id, page(id, log)]));
  Object.values(pages).forEach((p) => hub.modules.register(p));
  const workspace = region();
  const top = region('section');
  const splitter = region();
  const main = region('main');
  for (const child of [top, splitter, main]) workspace.appendChild(child);
  const keys = ['original', 'hybrid-1'].map((name) => {
    const key = makeEl('button');
    key.dataset.layout = name;
    return key;
  });
  const root = { addEventListener() {}, removeEventListener() {} };
  return { hub, log, pages, workspace, top, splitter, main, keys, root };
}

test('Original is the layout MiniHub always had: one page, no dock, every key to it', () => {
  const s = shell();
  s.hub.modules.activate('sequencer', s.main);
  const layout = installInterfaceLayout(s.hub, s);
  assert.equal(layout.current, 'original');
  assert.equal(s.top.hidden, true);
  assert.equal(s.splitter.hidden, true);
  assert.equal(s.hub.modules.dockedId, null);
  assert.equal(s.pages.sequencer.mounted, s.main);
  assert.equal(paneHasKeys(s.main), true, 'a page alone owns the keyboard');
  assert.equal(s.keys[0].getAttribute('aria-pressed'), 'true');
});

test('Hybrid 1 docks the Sequencer above and gives the page area to the Patch Bay', () => {
  const s = shell();
  s.hub.modules.activate('sequencer', s.main);
  const layout = installInterfaceLayout(s.hub, s);
  s.log.length = 0;
  fire(s.keys[1], 'click');

  assert.equal(layout.current, 'hybrid-1');
  assert.deepEqual(s.log, ['unmount sequencer', 'mount routing', 'mount sequencer'],
    'the Sequencer leaves the page area before it is docked: one instance, one place');
  assert.equal(s.pages.sequencer.mounted, s.top);
  assert.equal(s.pages.routing.mounted, s.main);
  assert.equal(s.top.hidden, false);
  assert.equal(s.splitter.hidden, false);
  assert.equal(s.hub.settings.data.interfaceLayout, 'hybrid-1', 'remembered, as a setting of the application');
  assert.equal(s.top.style.flexBasis, '50%');
  assert.equal(s.keys[1].getAttribute('aria-pressed'), 'true');
  assert.equal(s.keys[0].getAttribute('aria-pressed'), 'false');
});

test('in Hybrid 1 the keys go to the half pressed last', () => {
  const s = shell({ interfaceLayout: 'hybrid-1' });
  s.hub.modules.activate('home', s.main);
  installInterfaceLayout(s.hub, s);
  const inTop = makeEl('div'); s.top.appendChild(inTop);
  const inMain = makeEl('div'); s.main.appendChild(inMain);

  assert.equal(paneHasKeys(inTop), true, 'the Sequencer has them first');
  assert.equal(paneHasKeys(inMain), false);
  fire(s.workspace, 'pointerdown', { target: inMain });
  assert.equal(paneHasKeys(inMain), true);
  assert.equal(paneHasKeys(inTop), false, 'Ctrl+D now duplicates a node, not a clip');
  fire(s.workspace, 'pointerdown', { target: inTop });
  assert.equal(paneHasKeys(inTop), true);
});

test('opening the Sequencer while it is docked looks at it instead of mounting it twice', () => {
  const s = shell({ interfaceLayout: 'hybrid-1' });
  s.hub.modules.activate('home', s.main);
  installInterfaceLayout(s.hub, s);
  let shown = null;
  s.hub.events.on('module:dock-shown', (id) => { shown = id; });
  s.log.length = 0;
  assert.equal(s.hub.modules.activate('sequencer', s.main), false);
  assert.deepEqual(s.log, []);
  assert.equal(shown, 'sequencer');
  assert.equal(s.hub.modules.show('sequencer'), true, 'an agent asking for it is told it is on screen');

  // A page opened FROM the docked Sequencer (its "Open Patch Bay") lands below.
  s.hub.modules.activate('routing', s.top);
  assert.equal(s.pages.routing.mounted, s.main);
  assert.equal(s.pages.sequencer.mounted, s.top);
});

test('back to Original, the Sequencer leaves the dock and the page below stays', () => {
  const s = shell({ interfaceLayout: 'hybrid-1' });
  s.hub.modules.activate('home', s.main);
  const layout = installInterfaceLayout(s.hub, s);
  layout.set('original');
  assert.equal(s.pages.sequencer.mounted, null);
  assert.equal(s.hub.modules.dockedId, null);
  assert.equal(s.pages.home.mounted, s.main);
  assert.equal(s.top.hidden, true);
  assert.equal(s.main.dataset.pane, undefined);
  assert.equal(paneHasKeys(s.main), true);
  s.hub.modules.activate('sequencer', s.main);
  assert.equal(s.pages.sequencer.mounted, s.main, 'and opens in the page area again');
});

test('the bar between the halves keeps each half usable, and a double-click halves them', () => {
  assert.equal(clampSplit(0.05), 0.2);
  assert.equal(clampSplit(0.95), 0.8);
  assert.equal(clampSplit('x'), 0.5);
  const s = shell({ interfaceLayout: 'hybrid-1', hybridSplit: 0.7 });
  s.hub.modules.activate('home', s.main);
  installInterfaceLayout(s.hub, s);
  assert.equal(s.top.style.flexBasis, '70%', 'the remembered share');
  fire(s.splitter, 'keydown', { key: 'ArrowDown' });
  assert.equal(s.hub.settings.data.hybridSplit, 0.75);
  fire(s.splitter, 'dblclick');
  assert.equal(s.top.style.flexBasis, '50%');
  assert.equal(s.hub.settings.data.hybridSplit, 0.5);
});

test('the View menu offers the two layouts', () => {
  assert.ok(MENU_COMMANDS.includes('view:layout-original'));
  assert.ok(MENU_COMMANDS.includes('view:layout-hybrid-1'));
});
