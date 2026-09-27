import './installNodeEditors.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from '../src/renderer/js/core/hub.js';
import { bindDragKnobs } from '../src/renderer/js/ui/omniPearl.js';
import { installDom } from './domShim.mjs';

/**
 * Contract: the Mixer's, the Morpher's and the VST node's pages wear the
 * faceplate, as One Ring's does (the author, 2026-09-27), and every control
 * they had still does what it did.
 *
 * The page is the real module bound to a container that records what it is
 * given; an event is handed the element it happened on, with the ancestors
 * the page looks for.
 */

function mockApi() {
  const listeners = [];
  return {
    emitEvent: (msg) => listeners.forEach((cb) => cb(msg)),
    loadSettings: async () => ({}),
    saveSettings: async () => true,
    diagnosticsLog: () => true,
    engineCommand: async () => ({ ok: true }),
    engineState: async () => ({ state: 'running', error: null }),
    onEngineEvent: (cb) => { listeners.push(cb); return () => {}; },
    onEngineState: () => () => {}
  };
}

function recorder(parts = {}) {
  const listeners = {};
  return {
    innerHTML: '',
    querySelector: (selector) => parts[selector] ?? null,
    querySelectorAll: () => [],
    contains: () => true,
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
    removeEventListener(type, fn) { listeners[type] = (listeners[type] ?? []).filter((item) => item !== fn); },
    fire(type, event) { for (const fn of [...(listeners[type] ?? [])]) fn({ preventDefault() {}, ...event }); },
    count: () => Object.values(listeners).reduce((n, list) => n + list.length, 0)
  };
}

/** An element, with the ancestors (`selector -> element`) its page looks for. */
function element({ dataset = {}, attributes = {}, ancestors = {} } = {}) {
  const node = {
    dataset,
    attributes,
    title: '',
    classes: new Set(),
    getAttribute: (name) => attributes[name],
    setAttribute: (name, value) => { attributes[name] = String(value); },
    classList: {
      add: (name) => node.classes.add(name),
      remove: (name) => node.classes.delete(name),
      toggle: (name, on) => (on ? node.classes.add(name) : node.classes.delete(name))
    },
    querySelector: () => null,
    closest: (selector) => ancestors[selector] ?? null
  };
  return node;
}

function rig(typeId) {
  installDom();
  const api = mockApi();
  const hub = createHub(api);
  hub.engine.init();
  const node = hub.nodes.create(typeId);
  const changed = [];
  hub.events.on('nativeAudio:stateChanged', ({ nodeId }) => changed.push(nodeId));
  return { api, hub, node, changed };
}

const count = (html, pattern) => (html.match(pattern) || []).length;

// ---------- the Mixer and the Morpher ----------

test('a Mixer page is a console: a strip per input, named by what it hears, then the master', () => {
  const { hub, node } = rig('mixer');
  const synth = hub.nodes.create('vst');
  hub.network.connect(synth.id, 'audio-out', node.id, 'audio-in-1');
  const container = recorder();
  hub.modules.get(node.id).mount(container);

  const html = container.innerHTML;
  assert.match(html, /class="omni-pearl op-module op-console"/);
  assert.equal(count(html, /data-audio-input="/g), 2, 'the cabled input, and the free one under it');
  assert.match(html, /<span class="op-scribble-text">VST 1<\/span>/, 'the source by its name on screen, not its id');
  assert.match(html, /<span class="op-scribble-text">no cable<\/span>/);
  assert.equal(count(html, /data-native-control="pan"/g), 2);
  assert.match(html, /data-master-value/);
  assert.doesNotMatch(html, /data-morph-panel/);
  assert.doesNotMatch(html, /style=/, 'no inline style: the CSP drops it silently (invariant 10)');
});

test('a Morpher page has no pan and no master, and shows its steps', () => {
  const { hub, node } = rig('morpher');
  const container = recorder();
  hub.modules.get(node.id).mount(container);
  const html = container.innerHTML;
  assert.doesNotMatch(html, /data-native-control="pan"/);
  assert.doesNotMatch(html, /data-master-value/);
  assert.match(html, /data-morph-panel/);
  assert.equal(count(html, /data-morph-step="/g), 4, 'as many as the step count');
});

test('MUTE is a key: pressed, it mutes and is heard at once', () => {
  const { hub, node, changed } = rig('mixer');
  const container = recorder();
  hub.modules.get(node.id).mount(container);
  const row = element({ dataset: { audioInput: 'audio-in-1' } });
  const key = element({ dataset: { nativeControl: 'mute' } });
  key.closest = (selector) => (selector === '[data-audio-input]' ? row : selector === '[data-native-control="mute"]' ? key : null);

  container.fire('click', { target: key });
  assert.equal(hub.nodes.get(node.id).content.inputs[0].muted, true);
  assert.equal(key.classes.has('is-lit'), true, 'lit while muted');
  assert.equal(key.attributes['aria-pressed'], 'true');
  assert.deepEqual(changed, [node.id], 'no coalescing for a key');

  container.fire('click', { target: key });
  assert.equal(hub.nodes.get(node.id).content.inputs[0].muted, false);
});

test('a pan knob turns from the keys and centres on a double-click', () => {
  const { hub, node, changed } = rig('mixer');
  const container = recorder();
  hub.modules.get(node.id).mount(container);
  const row = element({ dataset: { audioInput: 'audio-in-1' } });
  const knob = element({
    dataset: { nativeControl: 'pan' },
    attributes: { 'aria-valuemin': '-100', 'aria-valuemax': '100', 'aria-valuenow': '0' }
  });
  knob.closest = (selector) => ({ '.op-dragknob': knob, '[data-audio-input]': row, '[data-native-control="pan"]': knob })[selector] ?? null;

  container.fire('keydown', { target: knob, key: 'PageUp' });
  assert.equal(hub.nodes.get(node.id).content.inputs[0].pan, 0.1);
  assert.equal(knob.attributes['aria-valuenow'], '10', 'the knob is drawn where the value is');
  assert.equal(knob.attributes['aria-valuetext'], 'R10');
  assert.deepEqual(changed, [node.id], 'a key is the end of its gesture');

  container.fire('dblclick', { target: knob });
  assert.equal(hub.nodes.get(node.id).content.inputs[0].pan, 0);
});

test('the Morpher\'s step count is taken from its selector, and the steps follow', () => {
  const { hub, node } = rig('morpher');
  const panel = { innerHTML: '' };
  const container = recorder({ '[data-morph-panel]': panel });
  hub.modules.get(node.id).mount(container);
  const position = element({ dataset: { morphCount: '16' } });
  position.closest = (selector) => (selector === '[data-morph-count]' ? position : null);

  container.fire('click', { target: position });
  assert.equal(hub.nodes.get(node.id).content.stepCount, 16);
  assert.equal(count(panel.innerHTML, /data-morph-step="/g), 16, 'the old page went on showing four');
});

test('closing a console page leaves nothing listening, here or on the document', () => {
  const { hub, node } = rig('mixer');
  const container = recorder();
  const module = hub.modules.get(node.id);
  module.mount(container);
  assert.ok(container.count() > 0);
  module.unmount();
  assert.equal(container.count(), 0);
  assert.equal(globalThis.document._listeners.pointerup?.size ?? 0, 0);
});

// ---------- the VST node ----------

test('a VST page is a rack: a unit per plugin, lit by what the engine said', () => {
  const { api, hub, node } = rig('vst');
  api.emitEvent({ type: 'plugins', plugins: [{ pluginId: 'P', name: 'Dexed', manufacturer: 'DS', role: 'instrument' }] });
  const chain = hub.nodes.getChain(node.id);
  const ready = chain.append({ pluginId: 'P', name: 'Dexed', role: 'instrument' });
  const broken = chain.append({ pluginId: 'P', name: 'Dexed <b>', role: 'instrument' });
  const bypassed = chain.append({ pluginId: 'P', name: 'Dexed', role: 'instrument' });
  hub.nodes.setPluginBypass(node.id, bypassed.id, true);
  api.emitEvent({ type: 'instanceStatus', chainId: node.id, instanceId: ready.id, status: 'ready' });
  api.emitEvent({ type: 'instanceStatus', chainId: node.id, instanceId: broken.id, status: 'error', error: 'no licence' });

  const container = recorder();
  hub.modules.get(node.id).mount(container);
  const html = container.innerHTML;
  assert.match(html, /class="omni-pearl op-module op-rack"/);
  assert.equal(count(html, /class="op-rack-unit plugin-card/g), 3);
  assert.match(html, /status-ready/);
  assert.match(html, /<span class="op-led is-error"/);
  assert.match(html, /no licence/, 'a plugin that failed before the page opened says why');
  assert.match(html, /Dexed &lt;b&gt;/, 'a plugin name is escaped (invariant 9)');
  assert.match(html, /class="op-keycap op-keycap--sm op-keycap--word is-lit"[^>]*aria-pressed="true"[^>]*data-action="bypass"/);
  assert.match(html, /class="[^"]*plugin-pick[^"]*"/, 'the picker keeps the class its own list looks for');
  assert.doesNotMatch(html, /style=/);
});

test('a click on a key\'s label reaches the key', () => {
  const { api, hub, node } = rig('vst');
  api.emitEvent({ type: 'plugins', plugins: [{ pluginId: 'P', name: 'Dexed', role: 'instrument' }] });
  const plugin = hub.nodes.getChain(node.id).append({ pluginId: 'P', name: 'Dexed', role: 'instrument' });
  const container = recorder();
  hub.modules.get(node.id).mount(container);
  const card = element({ dataset: { pluginId: plugin.id } });
  const key = element({ dataset: { action: 'bypass' } });
  const label = element({ ancestors: { '.plugin-card': card, '[data-action]': key } });

  container.fire('click', { target: label });
  assert.equal(hub.nodes.get(node.id).content.plugins[0].bypassed, true);
});

// ---------- the drag knob ----------

test('a drag knob follows the pointer up and down, and says when the gesture ends', () => {
  installDom();
  const root = recorder();
  const heard = [];
  const off = bindDragKnobs(root, { onValue: (knob, value, final) => heard.push([value, final]) });
  const knob = element({ attributes: { 'aria-valuemin': '-100', 'aria-valuemax': '100', 'aria-valuenow': '0' } });
  knob.closest = (selector) => (selector === '.op-dragknob' ? knob : null);

  root.fire('pointerdown', { target: knob, button: 0, pointerId: 1, clientY: 300 });
  root.fire('pointermove', { target: knob, pointerId: 1, clientY: 200 });
  root.fire('pointermove', { target: knob, pointerId: 1, clientY: 100 });
  root.fire('pointermove', { target: knob, pointerId: 1, clientY: 0 });
  root.fire('pointerup', { target: knob, pointerId: 1 });
  // 100 px is half the travel, so half the range: from 0 to the end, where
  // the two moves after it change nothing and say nothing.
  assert.deepEqual(heard, [[100, false], [100, true]]);

  heard.length = 0;
  root.fire('pointerdown', { target: knob, button: 0, pointerId: 2, clientY: 50 });
  root.fire('pointerup', { target: knob, pointerId: 2 });
  assert.deepEqual(heard, [], 'a press that moved nothing writes nothing');

  root.fire('keydown', { target: knob, key: 'End' });
  assert.deepEqual(heard, [[100, true]]);
  off();
  assert.equal(root.count(), 0);
});
