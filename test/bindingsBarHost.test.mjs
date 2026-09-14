import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHub } from '../src/renderer/js/core/hub.js';
import { MINILAB_CONTROL_SOURCES } from '../src/renderer/js/midi/minilabControls.js';
import { installBindingsBarHost } from '../src/renderer/js/core/bindingsBarHost.js';
import { controlBindingActionOf, performControlBindingAction } from '../src/renderer/js/core/controlBindingActions.js';

/*
 * The bindings bar is drawn from the main renderer, where the bindings live, and
 * a click in it comes back to be carried out there. DECISIONS D-021. Main's half
 * -- which bar exists and where it goes -- is test/bindingsBarWindows.test.cjs.
 */

const source = (key) => MINILAB_CONTROL_SOURCES.find((item) => item.key === key);
const tick = () => new Promise((resolve) => setImmediate(resolve));

function mockApi() {
  const sent = [];
  const listeners = { event: [], state: [], wanted: [], action: [] };
  const renders = [];
  const api = {
    sent, renders,
    delivered: true,
    focusCount: 0,
    openBars: [],
    emitEvent(msg) { listeners.event.forEach((cb) => cb(msg)); },
    want(bar) { listeners.wanted.forEach((cb) => cb(bar)); },
    act(action) { listeners.action.forEach((cb) => cb(action)); },
    loadSettings: async () => ({}),
    saveSettings: async () => true,
    diagnosticsLog: () => true,
    engineCommand: async (msg) => { sent.push(msg); return { ok: true }; },
    engineState: async () => ({ state: 'running', error: null }),
    onEngineEvent: (cb) => { listeners.event.push(cb); return () => {}; },
    onEngineState: (cb) => { listeners.state.push(cb); return () => {}; },
    focusMainWindow: async () => { api.focusCount += 1; return true; },
    bindingsBarRender: async (chainId, instanceId, html) => { renders.push({ chainId, instanceId, html }); return api.delivered; },
    bindingsBarsOpen: async () => api.openBars,
    onBindingsBarWanted: (cb) => { listeners.wanted.push(cb); return () => { listeners.wanted.length = 0; }; },
    onBindingsBarAction: (cb) => { listeners.action.push(cb); return () => { listeners.action.length = 0; }; }
  };
  return api;
}

async function makeRig() {
  const api = mockApi();
  const hub = createHub(api);
  await hub.settings.load();
  hub.network.addNode({
    id: 'minilab-3', name: 'MiniLab 3', inputs: [],
    outputs: [{ id: 'midi-out', type: 'midi', label: 'MIDI Out' },
      ...MINILAB_CONTROL_SOURCES.map((item) => ({ id: item.portId, type: 'control', label: item.label }))]
  });
  await hub.engine.init();
  const node = hub.nodes.create('vst');
  const plugin = hub.nodes.getChain(node.id).append({ pluginId: 'C:/VST3/Vital.vst3', name: 'Vital', role: 'instrument' });
  api.emitEvent({ type: 'instanceStatus', chainId: node.id, instanceId: plugin.id, pluginId: plugin.pluginId, generation: 7, status: 'ready' });
  api.emitEvent({ type: 'editorStatus', chainId: node.id, instanceId: plugin.id, pluginId: plugin.pluginId, generation: 7, open: true });
  hub.network.connect('minilab-3', source('k1').portId, node.id, 'ctrl-in');
  return { api, hub, node, plugin };
}

test('a bar main asks for is drawn with the Learn panel of its node', async () => {
  const { api, hub, node, plugin } = await makeRig();
  installBindingsBarHost(hub, api);
  api.want({ chainId: node.id, instanceId: plugin.id });
  await tick();
  const drawn = api.renders.at(-1);
  assert.equal(drawn.chainId, node.id);
  assert.equal(drawn.instanceId, plugin.id);
  assert.match(drawn.html, /data-minilab-surface="learn"/, 'the faceplate');
  assert.match(drawn.html, /data-control-action="learn"/, 'and the Learn toolbar');
});

test('a click in the bar is carried out here, and the bar is redrawn', async () => {
  const { api, hub, node, plugin } = await makeRig();
  installBindingsBarHost(hub, api);
  api.want({ chainId: node.id, instanceId: plugin.id });
  await tick();

  api.act({ chainId: node.id, instanceId: plugin.id, kind: 'select', controlId: source('k1').id });
  await tick();
  assert.match(api.renders.at(-1).html, /data-selected-source-control-id="minilab-3:k1"/);

  api.act({ chainId: node.id, instanceId: plugin.id, kind: 'learn', controlId: source('k1').id });
  assert.equal(hub.control.pendingLearn?.sourceControlId, source('k1').id, 'Learn armed by the manager, not by the bar');
  await tick();
  assert.match(api.renders.at(-1).html, /Cancel Learning/);

  api.act({ chainId: node.id, instanceId: plugin.id, kind: 'cancel', controlId: source('k1').id });
  assert.equal(hub.control.pendingLearn.state, 'cancelling');
});

test('the bar follows the bindings it shows', async () => {
  const { api, hub, node, plugin } = await makeRig();
  installBindingsBarHost(hub, api);
  api.want({ chainId: node.id, instanceId: plugin.id });
  await tick();
  const before = api.renders.length;
  hub.nodes.setControlBinding(node.id, {
    version: 1, sourceControlId: source('k1').id, pluginInstanceId: plugin.id,
    pluginId: plugin.pluginId, parameterId: '42', pluginName: 'Vital', parameterName: 'Cutoff'
  });
  hub.events.emit('control:bindingsChanged', { nodeId: node.id });
  await tick();
  assert.equal(api.renders.length, before + 1);
  assert.match(api.renders.at(-1).html, /state-mapped/);

  hub.events.emit('control:bindingsChanged', { nodeId: 'vst-999' });
  await tick();
  assert.equal(api.renders.length, before + 1, 'another node changing redraws nothing here');
});

test('a bar main says is gone stops being drawn', async () => {
  const { api, hub, node, plugin } = await makeRig();
  installBindingsBarHost(hub, api);
  api.want({ chainId: node.id, instanceId: plugin.id });
  await tick();
  api.delivered = false;
  hub.events.emit('control:bindingsChanged', { nodeId: node.id });
  await tick();
  const count = api.renders.length;
  hub.events.emit('control:bindingsChanged', { nodeId: node.id });
  await tick();
  assert.equal(api.renders.length, count);
});

test('a renderer that starts after an editor opened draws the bars that already exist', async () => {
  const { api, hub, node, plugin } = await makeRig();
  api.openBars = [{ chainId: node.id, instanceId: plugin.id }];
  installBindingsBarHost(hub, api);
  await tick();
  await tick();
  assert.equal(api.renders.length, 1);
});

test('"Not your keyboard?" opens the controller page and brings the main window forward', async () => {
  const { api, hub, node, plugin } = await makeRig();
  const content = { id: 'content' };
  const activated = [];
  hub.modules.list = () => [{ id: 'controller-page', routingNode: { id: 'minilab-3', type: 'midi-output', outputs: [{ id: 'midi-out' }] } }];
  hub.modules.activate = (page, container) => { activated.push([page, container]); return true; };
  installBindingsBarHost(hub, api, { contentElement: () => content });
  api.want({ chainId: node.id, instanceId: plugin.id });
  api.act({ chainId: node.id, instanceId: plugin.id, kind: 'open-controller' });
  await tick();
  assert.deepEqual(activated, [['controller-page', content]], 'the page the module system names, in the main window');
  assert.equal(api.focusCount, 1, 'and that window comes forward, because the person asked for it');
});

test('a hub without main\'s bars installs nothing', () => {
  const hub = createHub({ ...mockApi(), bindingsBarRender: undefined });
  assert.equal(installBindingsBarHost(hub, hub.api), null);
});

// ---- one reading of a click, for both the node editor and the bar ------------

test('a click is read from the panel markup and nothing else', () => {
  const element = (attributes) => ({
    dataset: attributes,
    closest(selector) {
      if (selector === '#control-open-controller') return attributes.id === 'control-open-controller' ? this : null;
      if (selector === '[data-minilab-control-id]') return attributes.minilabControlId ? this : null;
      return null;
    }
  });
  assert.deepEqual(controlBindingActionOf(element({ id: 'control-open-controller' })), { kind: 'open-controller' });
  assert.deepEqual(controlBindingActionOf(element({ minilabControlId: 'minilab-3:k2' })), { kind: 'select', controlId: 'minilab-3:k2' });
  assert.deepEqual(controlBindingActionOf(element({ controlAction: 'clear', sourceControlId: 'minilab-3:k2' })),
    { kind: 'clear', controlId: 'minilab-3:k2' });
  assert.equal(controlBindingActionOf(element({ controlAction: 'learn', sourceControlId: '' })), null,
    'the toolbar before anything is selected');
  assert.equal(controlBindingActionOf(element({ action: 'open' })), null, 'a plugin card is not this panel');
  assert.equal(controlBindingActionOf(null), null);

  const panel = { selectedControlId: null };
  assert.equal(performControlBindingAction({}, 'vst-001', { kind: 'select', controlId: 'minilab-3:k2' }, panel), true);
  assert.equal(panel.selectedControlId, 'minilab-3:k2');
  assert.equal(performControlBindingAction({}, 'vst-001', { kind: 'open-controller' }, panel), false,
    'where the controller page opens depends on the window, so the caller does it');
});

test('the VST node editor reads its clicks through the same module', () => {
  const source = fs.readFileSync(new URL('../src/renderer/js/core/nodeInstances.js', import.meta.url), 'utf8');
  assert.match(source, /performControlBindingAction\(hub, instance\.id, controlBindingActionOf\(e\.target\), bindingsPanel\)/);
  assert.doesNotMatch(source, /hub\.control\.armLearn\(/, 'a second copy of the Learn click is what D-018 would pay twice');
});
