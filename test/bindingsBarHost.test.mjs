import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHub } from '../src/renderer/js/core/hub.js';
import { MINILAB_CONTROL_SOURCES } from '../src/renderer/js/midi/minilabControls.js';
import { installBindingsBarHost } from '../src/renderer/js/core/bindingsBarHost.js';
import { controlBindingActionOf, performControlBindingAction } from '../src/renderer/js/core/controlBindingActions.js';
import { setupControlRouting } from '../src/renderer/js/core/controlRouting.js';

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
  const positions = [];
  const api = {
    sent, renders, positions,
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
    bindingsBarValues: async (chainId, instanceId, values, replace) => { positions.push({ chainId, instanceId, values, replace }); return true; },
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

test('with nothing selected, the toolbar says where the drawing is, under the plugin or beside it', async () => {
  // Under the plugin the faceplate is on the left of the toolbar; beside it, in
  // a column, it is above. Both words are in the markup and base.css shows the
  // true one: a class renamed on either side would show both or neither, and
  // nothing would say so.
  const { api, hub, node, plugin } = await makeRig();
  installBindingsBarHost(hub, api);
  api.want({ chainId: node.id, instanceId: plugin.id });
  await tick();
  const html = api.renders.at(-1).html;
  assert.match(html, /<span class="bar-where-strip">on the left<\/span>/);
  assert.match(html, /<span class="bar-where-column">above<\/span>/);

  const css = fs.readFileSync(new URL('../src/renderer/styles/base.css', import.meta.url), 'utf8');
  const start = css.indexOf('@media (orientation: portrait)');
  assert.ok(start > 0, 'the column layout');
  const column = css.slice(start, start + css.slice(start).search(/\r?\n\}\r?\n/));
  assert.match(css.slice(0, start), /\.bindings-bar \.bar-where-column \{ display:none; \}/, 'under the plugin: "on the left"');
  assert.match(column, /\.bindings-bar \.bar-where-strip \{ display:none; \}/, 'beside it: "above"');
  assert.match(column, /\.bindings-bar \.bar-where-column \{ display:inline; \}/);
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

test('a knob with no cable is armed from the bar like any other (2026-09-14)', async () => {
  const { api, hub, node, plugin } = await makeRig();
  installBindingsBarHost(hub, api);
  api.want({ chainId: node.id, instanceId: plugin.id });
  await tick();
  // K2 has no cable into this node: the rig cables K1 only.
  assert.equal(hub.control.isConnected(node.id, source('k2').id), false);
  assert.doesNotMatch(api.renders.at(-1).html, /state-unavailable/, 'no knob greyed out for want of a cable');

  api.act({ chainId: node.id, instanceId: plugin.id, kind: 'select', controlId: source('k2').id });
  await tick();
  const toolbar = api.renders.at(-1).html.slice(api.renders.at(-1).html.indexOf('control-learn-toolbar'));
  assert.match(toolbar, /data-control-action="learn" data-source-control-id="minilab-3:k2"\s*>/,
    'Arm Learning is enabled on it');
  assert.doesNotMatch(toolbar, /Patch Bay/, 'and nothing sends the person to cable it first');

  api.act({ chainId: node.id, instanceId: plugin.id, kind: 'learn', controlId: source('k2').id });
  assert.equal(hub.control.pendingLearn?.sourceControlId, source('k2').id);
});

test('a learned knob whose cable was pulled out is drawn apart from one that works', async () => {
  const { api, hub, node, plugin } = await makeRig();
  const bind = (key, parameterId) => hub.nodes.setControlBinding(node.id, {
    version: 1, sourceControlId: source(key).id, pluginInstanceId: plugin.id,
    pluginId: plugin.pluginId, parameterId, pluginName: 'Vital', parameterName: 'Cutoff'
  });
  bind('k1', '41'); // the rig cables K1
  bind('k2', '42'); // and nothing cables K2
  installBindingsBarHost(hub, api);
  api.want({ chainId: node.id, instanceId: plugin.id });
  await tick();
  const html = api.renders.at(-1).html;
  assert.match(html, /class="[^"]*state-mapped[^"]*"[^>]*data-minilab-control-id="minilab-3:k1"/);
  assert.match(html, /class="[^"]*state-unplugged[^"]*"[^>]*data-minilab-control-id="minilab-3:k2"/,
    'kept, and not drawn as if turning it did something');
});

// 2026-09-15: a knob bound to a plugin in error was drawn green.
test('a knob bound to a plugin that failed to load is not drawn as working', async () => {
  const { api, hub, node, plugin } = await makeRig();
  const failed = hub.nodes.getChain(node.id).append({ pluginId: 'C:/VST3/Broken.vst3', name: 'Broken', role: 'audio-effect' });
  api.emitEvent({
    type: 'instanceStatus', chainId: node.id, instanceId: failed.id, pluginId: failed.pluginId,
    generation: 8, status: 'error', error: 'plugin not found'
  });
  hub.nodes.setControlBinding(node.id, {
    version: 1, sourceControlId: source('k1').id, pluginInstanceId: failed.id,
    pluginId: failed.pluginId, parameterId: '5', pluginName: 'Broken', parameterName: 'Mix'
  });
  installBindingsBarHost(hub, api);
  // The bar under the plugin that did load: the only place the other one's knobs show.
  api.want({ chainId: node.id, instanceId: plugin.id });
  await tick();
  const html = api.renders.at(-1).html;
  assert.match(html, /class="[^"]*state-inactive[^"]*"[^>]*data-minilab-control-id="minilab-3:k1"/);
  assert.doesNotMatch(html, /state-mapped/, 'nothing on this bar routes, so nothing is drawn as if it did');
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

// ---- one reading of a click, one host for the panel --------------------------

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

/*
 * The bar replaced the panel in the VST node's editor rather than sitting beside
 * it (D-021, 2026-09-15). Read from the sources, because a second host would not
 * break anything a test can run: it would draw, and arm, and quietly be a second
 * selection and a second redraw to keep in step with this one.
 */
test('the Learn panel is drawn and clicked in the bar and nowhere else', () => {
  const root = new URL('../src/renderer/js/', import.meta.url);
  const sources = fs.readdirSync(root, { recursive: true })
    .map((name) => String(name).replaceAll('\\', '/'))
    .filter((name) => name.endsWith('.js'))
    .map((name) => ({ name, text: fs.readFileSync(new URL(name, root), 'utf8') }));
  const where = (pattern) => sources.filter((file) => pattern.test(file.text)).map((file) => file.name);

  assert.deepEqual(where(/import\s*\{[^}]*\brenderControlBindings\b/), ['core/bindingsBarHost.js']);
  assert.deepEqual(where(/import\s*\{[^}]*\bperformControlBindingAction\b/), ['core/bindingsBarHost.js']);
  assert.deepEqual(where(/hub\.control\.armLearn\(/), ['core/controlBindingActions.js'],
    'a second copy of the Learn click is what D-018 would pay twice');
});

// ---- knobs that move: the mouse on the bar, the plugin, the keyboard ---------

/*
 * Asked 2026-09-14: a knob dragged with the mouse in the bar moves the parameter
 * it is bound to, and the parameter moved in the plugin moves the drawn knob. The
 * positions travel apart from the markup (`bindings-bar:values`), and are what
 * makes a drawn control movable at all.
 */

const bindK1 = (hub, node, plugin, parameterId = '41') => hub.nodes.setControlBinding(node.id, {
  version: 1, sourceControlId: source('k1').id, pluginInstanceId: plugin.id,
  pluginId: plugin.pluginId, parameterId, pluginName: 'Vital', parameterName: 'Cutoff'
});

/** The engine's answer to the last parameter read, as `engineClient` expects it. */
function answerRead(api, parameters) {
  const request = api.sent.filter((msg) => msg.type === 'getVstParameters').at(-1);
  api.emitEvent({
    type: 'vstParameters', requestId: request.requestId, chainId: request.chainId,
    instanceId: request.instanceId, status: 'ok', pluginId: 'C:/VST3/Vital.vst3', parameters
  });
  return request;
}

const lastPosition = (api, controlId) => {
  for (let i = api.positions.length - 1; i >= 0; i -= 1) {
    if (controlId in api.positions[i].values) return api.positions[i].values[controlId];
  }
  return undefined;
};

test('a bar that opens reads where its bound parameters stand, and only those', async () => {
  const { api, hub, node, plugin } = await makeRig();
  bindK1(hub, node, plugin);
  installBindingsBarHost(hub, api);
  api.want({ chainId: node.id, instanceId: plugin.id });
  await tick();
  const request = answerRead(api, [{ parameterId: '41', normalizedValue: 0.7 }]);
  assert.deepEqual(request.parameterIds, ['41'], 'the bound parameter, not the whole synth');
  await tick();
  assert.equal(lastPosition(api, source('k1').id), 0.7);
});

test('a knob dragged in the bar moves its parameter, by the binding', async () => {
  const { api, hub, node, plugin } = await makeRig();
  bindK1(hub, node, plugin);
  installBindingsBarHost(hub, api);
  api.want({ chainId: node.id, instanceId: plugin.id });
  await tick();
  api.sent.length = 0;
  api.act({ chainId: node.id, instanceId: plugin.id, kind: 'turn', controlId: source('k1').id, normalizedValue: 0.25 });
  const write = api.sent.find((msg) => msg.type === 'setVstParameter');
  assert.deepEqual([write?.instanceId, write?.parameterId, write?.normalizedValue], [plugin.id, '41', 0.25]);
  assert.equal(lastPosition(api, source('k1').id), 0.25, 'and every bar of the node hears where it went');
});

test('a drag moves nothing without a working binding', async () => {
  const { api, hub, node, plugin } = await makeRig();
  // K2 is bound but has no cable: kept, unplugged, and doing nothing.
  hub.nodes.setControlBinding(node.id, {
    version: 1, sourceControlId: source('k2').id, pluginInstanceId: plugin.id,
    pluginId: plugin.pluginId, parameterId: '42', pluginName: 'Vital', parameterName: 'Reso'
  });
  installBindingsBarHost(hub, api);
  api.want({ chainId: node.id, instanceId: plugin.id });
  await tick();
  api.sent.length = 0;
  for (const key of ['k2', 'k3']) {
    api.act({ chainId: node.id, instanceId: plugin.id, kind: 'turn', controlId: source(key).id, normalizedValue: 0.9 });
  }
  assert.equal(api.sent.filter((msg) => msg.type === 'setVstParameter').length, 0);
  assert.equal(lastPosition(api, source('k2').id), undefined, 'and an unplugged knob is never given a position to drag');
});

test('the parameter moved in the plugin moves the drawn knob', async () => {
  const { api, hub, node, plugin } = await makeRig();
  bindK1(hub, node, plugin);
  installBindingsBarHost(hub, api);
  api.want({ chainId: node.id, instanceId: plugin.id });
  await tick();
  api.emitEvent({
    type: 'vstParameterTouched', chainId: node.id, instanceId: plugin.id, pluginId: plugin.pluginId, generation: 7,
    parameterId: '41', name: 'Cutoff', normalizedValue: 0.62, gestureAware: true, capturedByLearn: false
  });
  assert.equal(lastPosition(api, source('k1').id), 0.62);
  api.emitEvent({
    type: 'vstParameterTouched', chainId: node.id, instanceId: plugin.id, pluginId: plugin.pluginId, generation: 7,
    parameterId: '99', name: 'Other', normalizedValue: 0.1, gestureAware: true, capturedByLearn: false
  });
  assert.equal(lastPosition(api, source('k1').id), 0.62, 'a parameter nothing is bound to moves no knob');
});

test('the knob turned on the keyboard moves the drawn knob', async () => {
  const { api, hub, node, plugin } = await makeRig();
  bindK1(hub, node, plugin);
  installBindingsBarHost(hub, api);
  api.want({ chainId: node.id, instanceId: plugin.id });
  await tick();
  setupControlRouting(hub);
  const k1 = source('k1');
  hub.events.emit('midi:message', { type: 'cc', sourceName: 'Minilab3 MIDI', channel: 1,
    controller: k1.cc, value: 127, raw: [0xb0, k1.cc, 127] });
  assert.equal(lastPosition(api, k1.id), 1);
});

test('a read that left before a drag never drags the knob back', async () => {
  const { api, hub, node, plugin } = await makeRig();
  bindK1(hub, node, plugin);
  installBindingsBarHost(hub, api);
  api.want({ chainId: node.id, instanceId: plugin.id });
  await tick();
  // The read is on its way; the person drags meanwhile; the stale answer lands.
  api.act({ chainId: node.id, instanceId: plugin.id, kind: 'turn', controlId: source('k1').id, normalizedValue: 0.2 });
  answerRead(api, [{ parameterId: '41', normalizedValue: 0.7 }]);
  await tick();
  assert.equal(lastPosition(api, source('k1').id), 0.2);
});
