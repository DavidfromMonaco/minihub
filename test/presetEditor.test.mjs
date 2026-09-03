/**
 * The Preset node editor.
 *
 * What matters here is that the cable is the authority: what the page offers
 * follows the graph, not a copy kept in the node. The rest is the discipline
 * every editor owes -- escape what comes from disk (invariant 9) and leave no
 * listener behind (invariant 8).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from '../src/renderer/js/core/hub.js';
import { getNodeEditor } from '../src/renderer/js/core/nodeEditors.js';
import { resolveTarget, selectPresets, selectOnline } from '../src/renderer/js/modules/presets/presetEditor.js';
import { getNodeType } from '../src/renderer/js/core/nodeTypes.js';

const MASSIVE = '5653544E6924486D6173736976652078';

function mockApi(overrides = {}) {
  const listeners = { event: [], state: [] };
  return {
    sent: [],
    emitEvent(msg) { listeners.event.forEach((cb) => cb(msg)); },
    loadSettings: async () => ({}),
    saveSettings: async () => true,
    diagnosticsLog: () => true,
    engineCommand: async () => ({ ok: true }),
    engineState: async () => ({ state: 'running', error: null }),
    onEngineEvent: (cb) => { listeners.event.push(cb); return () => {}; },
    onEngineState: (cb) => { listeners.state.push(cb); return () => {}; },
    presetsLibrary: async () => ({ ok: true, presets: [] }),
    presetsRead: async () => ({ ok: false, reason: 'not-stubbed' }),
    presetsCatalogue: async () => ({ ok: true, entries: [], refreshedAt: null }),
    presetsDownload: async () => ({ ok: false, reason: 'not-stubbed' }),
    ...overrides
  };
}

/**
 * Only the container surface this editor touches. The shared DOM shim resolves
 * `#id` selectors alone, so an integration test built on it would look green
 * while painting nothing -- worse than no test at all.
 */
function makeContainer() {
  const listeners = [];
  const regions = new Map();
  for (const key of ['[data-preset-target]', '[data-preset-list]', '[data-preset-status]',
    '[data-preset-online-list]', '[data-preset-online-status]']) {
    regions.set(key, { innerHTML: '', textContent: '' });
  }
  return {
    innerHTML: '',
    querySelector: (selector) => regions.get(selector) || null,
    addEventListener(type, fn, options) { listeners.push({ type, fn, options }); },
    removeEventListener(type, fn) {
      const index = listeners.findIndex((l) => l.type === type && l.fn === fn);
      if (index !== -1) listeners.splice(index, 1);
    },
    listenerCount: () => listeners.length,
    fire(type, event) { listeners.filter((l) => l.type === type).forEach((l) => l.fn(event)); },
    region: (selector) => regions.get(selector)
  };
}

async function rig(api = mockApi()) {
  const hub = createHub(api);
  await hub.engine.init();
  const preset = hub.nodes.create('preset');
  const vst = hub.nodes.create('vst');
  return { hub, api, preset, vst };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// ---- The node type ----------------------------------------------------------

test('a Preset node emits PRESET and accepts nothing', () => {
  const type = getNodeType('preset');
  assert.deepEqual(type.ports.inputs, []);
  assert.equal(type.ports.outputs.length, 1);
  assert.equal(type.ports.outputs[0].type, 'preset');
});

test('the editor is registered through the seam, not inside nodeInstances', () => {
  const editor = getNodeEditor('preset');
  assert.ok(editor, 'registered by importing the module');
  assert.equal(typeof editor.render, 'function');
  assert.equal(typeof editor.bind, 'function');
});

// ---- The cable is the authority ---------------------------------------------

test('with no cable there is no target', async () => {
  const { hub, preset } = await rig();
  assert.equal(resolveTarget(hub, preset).state, 'unconnected');
});

test('a cable to a VST node with no plugin says so', async () => {
  const { hub, preset, vst } = await rig();
  hub.graph.connect(preset.id, 'preset-out', vst.id, 'preset-in');
  const target = resolveTarget(hub, preset);
  assert.equal(target.state, 'empty-chain');
  assert.equal(target.node.id, vst.id);
});

test('the target plugin and its class id come from the cable and the catalog', async () => {
  const api = mockApi();
  const { hub, preset, vst } = await rig(api);
  api.emitEvent({
    type: 'plugins',
    plugins: [{ pluginId: 'P', name: 'Massive X', manufacturer: 'NI', role: 'instrument', classId: MASSIVE }]
  });
  hub.nodes.getChain(vst.id).append({ pluginId: 'P', name: 'Massive X', role: 'instrument' });
  hub.graph.connect(preset.id, 'preset-out', vst.id, 'preset-in');

  const target = resolveTarget(hub, preset);
  assert.equal(target.state, 'ready');
  assert.equal(target.plugin.name, 'Massive X');
  assert.equal(target.classId, MASSIVE);
  assert.equal(target.matchedBy, 'class');
});

test('unplugging the cable changes the answer, with no other state to update', async () => {
  const { hub, preset, vst } = await rig();
  hub.nodes.getChain(vst.id).append({ pluginId: 'P', name: 'Dexed', role: 'instrument' });
  hub.graph.connect(preset.id, 'preset-out', vst.id, 'preset-in');
  assert.equal(resolveTarget(hub, preset).state, 'ready');

  hub.graph.disconnect(preset.id, 'preset-out', vst.id, 'preset-in');
  assert.equal(resolveTarget(hub, preset).state, 'unconnected');
});

test('a plugin with no class id falls back to matching by name, and says so', async () => {
  const api = mockApi();
  const { hub, preset, vst } = await rig(api);
  // A catalog entry from before class ids were recorded.
  api.emitEvent({ type: 'plugins', plugins: [{ pluginId: 'P', name: 'Dexed', role: 'instrument' }] });
  hub.nodes.getChain(vst.id).append({ pluginId: 'P', name: 'Dexed', role: 'instrument' });
  hub.graph.connect(preset.id, 'preset-out', vst.id, 'preset-in');

  const target = resolveTarget(hub, preset);
  assert.equal(target.classId, null);
  assert.equal(target.matchedBy, 'name');
});

test('the stored plugin choice selects within the chain, and survives a bad one', async () => {
  const { hub, preset, vst } = await rig();
  const chain = hub.nodes.getChain(vst.id);
  chain.append({ pluginId: 'A', name: 'First', role: 'instrument' });
  const second = chain.append({ pluginId: 'B', name: 'Second', role: 'audio-effect' });
  hub.graph.connect(preset.id, 'preset-out', vst.id, 'preset-in');

  assert.equal(resolveTarget(hub, preset).plugin.name, 'First', 'first by default');
  preset.content.pluginInstanceId = second.id;
  assert.equal(resolveTarget(hub, preset).plugin.name, 'Second');
  preset.content.pluginInstanceId = 'plugin-999';
  assert.equal(resolveTarget(hub, preset).plugin.name, 'First', 'a stale choice falls back');
});

// ---- Filtering --------------------------------------------------------------

test('an exact class match trusts the library, a name match filters it', () => {
  const library = [
    { name: 'a', plugin: 'Massive X' },
    { name: 'b', plugin: 'Dexed' },
    { name: 'c', plugin: 'massive-x' }
  ];
  // The main process already filtered by class id.
  assert.equal(selectPresets(library, { matchedBy: 'class' }).length, 3);

  const byName = selectPresets(library, { matchedBy: 'name', plugin: { name: 'Massive X' } });
  assert.deepEqual(byName.map((p) => p.name), ['a', 'c'], 'punctuation and case are ignored');
  assert.equal(selectPresets(library, { matchedBy: 'name', plugin: { name: '' } }).length, 0);
  assert.equal(selectPresets(null, { matchedBy: 'class' }).length, 0);
});

// ---- Mounting ---------------------------------------------------------------

test('the page follows the cable and lists what the library returns', async () => {
  const api = mockApi({
    presetsLibrary: async () => ({
      ok: true,
      presets: [{ path: 'C:/p/Deep Bass.vstpreset', name: 'Deep Bass', vendor: 'NI', source: 'user', plugin: 'Massive X' }]
    })
  });
  const { hub, preset, vst } = await rig(api);
  api.emitEvent({
    type: 'plugins',
    plugins: [{ pluginId: 'P', name: 'Massive X', role: 'instrument', classId: MASSIVE }]
  });
  hub.nodes.getChain(vst.id).append({ pluginId: 'P', name: 'Massive X', role: 'instrument' });
  hub.graph.connect(preset.id, 'preset-out', vst.id, 'preset-in');

  const container = makeContainer();
  const editor = getNodeEditor('preset');
  container.innerHTML = editor.render({ instance: preset, type: getNodeType('preset'), hub });
  const teardown = editor.bind(container, { instance: preset, type: getNodeType('preset'), hub });
  await settle();

  assert.match(container.region('[data-preset-target]').innerHTML, /Massive X/);
  assert.match(container.region('[data-preset-list]').innerHTML, /Deep Bass/);
  assert.equal(container.region('[data-preset-status]').textContent, '1 preset');
  teardown();
});

test('a preset name from disk is escaped before it reaches innerHTML', async () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const api = mockApi({
    presetsLibrary: async () => ({
      ok: true,
      presets: [{ path: 'C:/p/x.vstpreset', name: hostile, vendor: hostile, source: 'user', plugin: 'Massive X' }]
    })
  });
  const { hub, preset, vst } = await rig(api);
  api.emitEvent({ type: 'plugins', plugins: [{ pluginId: 'P', name: 'Massive X', role: 'instrument', classId: MASSIVE }] });
  hub.nodes.getChain(vst.id).append({ pluginId: 'P', name: 'Massive X', role: 'instrument' });
  hub.graph.connect(preset.id, 'preset-out', vst.id, 'preset-in');

  const container = makeContainer();
  const editor = getNodeEditor('preset');
  const teardown = editor.bind(container, { instance: preset, type: getNodeType('preset'), hub });
  await settle();

  const html = container.region('[data-preset-list]').innerHTML;
  assert.ok(!html.includes('<img'), 'a preset file name must never become markup');
  assert.match(html, /&lt;img/);
  teardown();
});

test('unmount removes every listener and silences answers still in flight', async () => {
  let release = null;
  const api = mockApi({
    presetsLibrary: () => new Promise((resolve) => { release = resolve; })
  });
  const { hub, preset, vst } = await rig(api);
  hub.nodes.getChain(vst.id).append({ pluginId: 'P', name: 'Dexed', role: 'instrument' });
  hub.graph.connect(preset.id, 'preset-out', vst.id, 'preset-in');

  const container = makeContainer();
  const editor = getNodeEditor('preset');
  const teardown = editor.bind(container, { instance: preset, type: getNodeType('preset'), hub });
  assert.ok(container.listenerCount() > 0);

  teardown();
  assert.equal(container.listenerCount(), 0, '#content is shared: nothing may survive');

  // The library answers after the user has navigated away.
  const before = container.region('[data-preset-list]').innerHTML;
  release({ ok: true, presets: [{ path: 'p', name: 'Late', vendor: 'x', source: 'user', plugin: 'Dexed' }] });
  await settle();
  assert.equal(container.region('[data-preset-list]').innerHTML, before, 'a late answer paints nothing');
});

test('applying reads the preset then hands its chunks to the engine', async () => {
  const api = mockApi({
    presetsLibrary: async () => ({
      ok: true,
      presets: [{ path: 'C:/p/Deep.vstpreset', name: 'Deep', vendor: 'NI', source: 'user', plugin: 'Massive X' }]
    }),
    presetsRead: async (path) => ({ ok: true, classId: MASSIVE, component: 'Y29tcA==', controller: null, path })
  });
  const { hub, preset, vst } = await rig(api);
  api.emitEvent({ type: 'plugins', plugins: [{ pluginId: 'P', name: 'Massive X', role: 'instrument', classId: MASSIVE }] });
  const plugin = hub.nodes.getChain(vst.id).append({ pluginId: 'P', name: 'Massive X', role: 'instrument' });
  hub.graph.connect(preset.id, 'preset-out', vst.id, 'preset-in');

  const calls = [];
  hub.engine.loadPresetChunks = async (...args) => { calls.push(args); return { ok: true }; };

  const container = makeContainer();
  const editor = getNodeEditor('preset');
  const teardown = editor.bind(container, { instance: preset, type: getNodeType('preset'), hub });
  await settle();

  // A click on the Apply button of that row.
  const row = { dataset: { presetPath: 'C:/p/Deep.vstpreset' } };
  container.fire('click', {
    target: { closest: (sel) => (sel === '[data-preset-action]' ? { dataset: { presetAction: 'apply' }, closest: () => row } : row) }
  });
  await settle();

  assert.equal(calls.length, 1, 'exactly one engine command');
  assert.deepEqual(calls[0], [vst.id, plugin.id, 'P', MASSIVE, 'Y29tcA==', null]);
  teardown();
});

// ---- The online catalogue ---------------------------------------------------

test('a catalogue entry matches by class id when both sides know one', () => {
  const entries = [
    { name: 'exact', classId: MASSIVE, plugin: 'Something Else' },
    { name: 'other', classId: 'A'.repeat(32), plugin: 'Massive X' },
    { name: 'byname', classId: null, plugin: 'Massive X' }
  ];
  const target = { classId: MASSIVE, plugin: { name: 'Massive X' } };
  // A known class id on both sides beats a matching name, and a name-only entry
  // is still offered because a listing cannot know a class id without opening
  // every file.
  assert.deepEqual(selectOnline(entries, target).map((e) => e.name), ['exact', 'byname']);

  const nameOnly = { classId: null, plugin: { name: 'Massive X' } };
  assert.deepEqual(selectOnline(entries, nameOnly).map((e) => e.name), ['other', 'byname']);
  assert.equal(selectOnline(null, nameOnly).length, 0);
});

test('with no source configured the page says so instead of looking empty', async () => {
  const api = mockApi({
    presetsCatalogue: async (options) => (options && options.refresh
      ? { ok: true, entries: [], refreshedAt: null, refreshed: true, sources: 0 }
      : { ok: true, entries: [], refreshedAt: null })
  });
  const { hub, preset, vst } = await rig(api);
  hub.nodes.getChain(vst.id).append({ pluginId: 'P', name: 'Dexed', role: 'instrument' });
  hub.graph.connect(preset.id, 'preset-out', vst.id, 'preset-in');

  const container = makeContainer();
  container.region('[data-preset-online-list]');
  const editor = getNodeEditor('preset');
  const teardown = editor.bind(container, { instance: preset, type: getNodeType('preset'), hub });
  await settle();

  container.fire('click', {
    target: { closest: () => ({ dataset: { presetAction: 'refresh-online' }, closest: () => null }) }
  });
  await settle();
  assert.match(container.region('[data-preset-online-list]').innerHTML, /No catalogue source configured/);
  teardown();
});

test('opening the page reads the remembered catalogue, never the network', async () => {
  const asked = [];
  const api = mockApi({
    presetsCatalogue: async (options) => {
      asked.push(options);
      return { ok: true, entries: [], refreshedAt: null };
    }
  });
  const { hub, preset, vst } = await rig(api);
  hub.nodes.getChain(vst.id).append({ pluginId: 'P', name: 'Dexed', role: 'instrument' });
  hub.graph.connect(preset.id, 'preset-out', vst.id, 'preset-in');

  const container = makeContainer();
  const editor = getNodeEditor('preset');
  const teardown = editor.bind(container, { instance: preset, type: getNodeType('preset'), hub });
  await settle();

  assert.ok(asked.length > 0);
  assert.ok(asked.every((options) => options.refresh === false),
    'mounting a node must not reach out on its own');
  teardown();
});
