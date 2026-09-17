import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from '../src/renderer/js/core/hub.js';
import { setupEditHistory } from '../src/renderer/js/core/editHistory.js';
import { getNodeEditor } from '../src/renderer/js/core/nodeEditors.js';
import { VALUE_TYPE } from '../src/renderer/js/core/commandRegistry.js';
import {
  CHANNEL_COUNT, CONDITION, MUTABLE, SCENE_POSITION, SCENE_TIMING, STEP_MODE, VALUE_MODE,
  cellAt, createSequence, readSequence, retarget, sequenceErrors, setCell, targetFinder
} from '../src/renderer/js/core/oneRingSequence.js';
import * as edits from '../src/renderer/js/core/oneRingEdits.js';
import { renderPage, renderRegions } from '../src/renderer/js/modules/oneRing/oneRingFaceplate.js';
import { applyStatus, registerOneRingPanel } from '../src/renderer/js/modules/oneRing/oneRingPanel.js';

/**
 * Contract: the One Ring page edits a sequence the way the VST's editor did,
 * plays it through the node's runtime, and lights what the runtime reports
 * without redrawing. The edits are pure; the page is the real module bound to
 * a container that records what it is given.
 */

const settle = () => new Promise((resolve) => setImmediate(resolve));
const number = (minimum, maximum) => ({ id: 'LEVEL', label: 'Level', type: VALUE_TYPE.number, minimum, maximum });
const integer = (minimum, maximum) => ({ id: 'STEP', label: 'Step', type: VALUE_TYPE.integer, minimum, maximum });
const choice = { id: 'MODE', label: 'Mode', type: VALUE_TYPE.choice, choices: [{ id: 0, label: 'Up' }, { id: 1, label: 'Down' }, { id: 2, label: 'Random' }] };
const held = { id: 'PLAY', label: 'Play', type: VALUE_TYPE.none, releaseCommand: 'STOP' };

// ---------- the edits ----------

test('a channel setting is taken only as the VST offered it', () => {
  const content = createSequence();
  const set = (setting, value, options) => edits.setChannelSetting(content, 0, 2, setting, value, options).scenes[0].channels[2];
  assert.equal(set('length', 32).length, 32);
  assert.equal(edits.setChannelSetting(content, 0, 2, 'length', 12), content, 'a length the VST had not is refused');
  assert.deepEqual([set('rate', 8).numerator, set('rate', 8).denominator], [1, 8]);
  assert.equal(edits.setChannelSetting(content, 0, 2, 'rate', 64), content);
  assert.equal(set('repeats', 0).repeats, 0);
  assert.equal(set('repeats', 8).repeats, 8);
  assert.equal(edits.setChannelSetting(content, 0, 2, 'repeats', 5), content);
  assert.equal(edits.setChannelSetting(content, 0, 2, 'mode', STEP_MODE.legato), content, 'Legato needs a release');
  assert.equal(set('mode', STEP_MODE.legato, { descriptor: held }).mode, STEP_MODE.legato);
  assert.equal(set('offset', 99).offset, 64);
  assert.equal(set('offset', -3.4).offset, -3);
  assert.equal(set('swing', 12).swing, 0.12);
  assert.equal(set('swing', 400).swing, 0.95);
  assert.equal(set('humanize', 50).humanize, 0.45, 'exactly the engine\'s maximum, not a hair over');
  assert.equal(set('enabled', false).enabled, false);
  assert.equal(edits.setChannelSetting(content, 0, 2, 'swing', 0), content, 'nothing changed, nothing written');
  assert.equal(edits.setChannelSetting(content, 0, 16, 'length', 8), content, 'no seventeenth channel');
  const toggled = edits.toggleMutable(content, 0, 2, MUTABLE.value).scenes[0].channels[2];
  assert.equal(toggled.mutableFields, MUTABLE.enabled | MUTABLE.probability);
});

test('a new target clears the command and the values; a new command gives its default', () => {
  let content = createSequence();
  let channel = retarget(content.scenes[0].channels[0], 'mixer-001', 'LEVEL', number(0, 2));
  channel = setCell(channel, 3, { ...cellAt(channel, 3), enabled: true, value: { ...cellAt(channel, 3).value, fixed: { type: VALUE_TYPE.number, value: 1.5 } } });
  content = { ...content, scenes: content.scenes.map((scene, s) => (s ? scene : { ...scene, channels: scene.channels.map((item, c) => (c ? item : channel)) })) };
  const aimed = edits.setChannelTarget(content, 0, 0, 'arp-001').scenes[0].channels[0];
  assert.deepEqual([aimed.target.target, aimed.target.command], ['arp-001', '']);
  assert.equal(cellAt(aimed, 3).enabled, true, 'which cells play is kept');
  assert.equal(cellAt(aimed, 3).value.fixed.type, VALUE_TYPE.none);
  const commanded = edits.setChannelCommand(edits.setChannelTarget(content, 0, 0, 'arp-001'), 0, 0, 'MODE', choice).scenes[0].channels[0];
  assert.deepEqual(cellAt(commanded, 3).value.fixed, { type: VALUE_TYPE.choice, value: 0 });
  assert.equal(edits.setChannelTarget(content, 0, 0, '').scenes[0].channels[0].target.target, '');
});

test('a cell is switched, weighted, valued and locked', () => {
  const content = createSequence();
  const cell = (next, index = 5) => cellAt(next.scenes[0].channels[0], index);
  const on = edits.editCell(content, 0, 0, 5, edits.toggleActive);
  assert.equal(cell(on).enabled, true);
  assert.equal(edits.editCell(content, 0, 0, 64, edits.toggleActive), content, 'no sixty-fifth cell');
  assert.equal(cell(edits.editCell(on, 0, 0, 5, (item) => edits.setProbability(item, 140))).probability, 100);
  assert.equal(cell(edits.editCell(on, 0, 0, 5, (item) => edits.setProbability(item, 33.6))).probability, 34);
  assert.equal(edits.editCell(on, 0, 0, 5, (item) => edits.setProbability(item, 100)), on, 'unchanged, not written');
  assert.equal(cell(edits.editCell(on, 0, 0, 5, edits.toggleLocked)).locked, true);
  assert.equal(cell(edits.editCell(on, 0, 0, 5, (item) => edits.toggleLockedField(item, MUTABLE.probability))).lockedFields, MUTABLE.probability);

  const base = { ...cellAt(content.scenes[0].channels[0], 0), value: { mode: VALUE_MODE.fixed, fixed: { type: VALUE_TYPE.number, value: 0.5 }, min: { type: VALUE_TYPE.none }, max: { type: VALUE_TYPE.none }, choices: [] } };
  assert.equal(edits.setValueMode(base, VALUE_MODE.range, choice), base, 'a range needs a number');
  const ranged = edits.setValueMode(base, VALUE_MODE.range, number(0, 2));
  assert.deepEqual([ranged.value.min, ranged.value.max], [{ type: VALUE_TYPE.number, value: 0 }, { type: VALUE_TYPE.number, value: 2 }]);
  assert.deepEqual(ranged.value.choices, [{ type: VALUE_TYPE.number, value: 0.5 }], 'the list starts as the fixed value');
  const raised = edits.setRangeEnd(ranged, 'min', { type: VALUE_TYPE.number, value: 2 });
  assert.deepEqual([raised.value.min.value, raised.value.max.value], [2, 2], 'a range is never empty');
  const lowered = edits.setRangeEnd(ranged, 'max', { type: VALUE_TYPE.number, value: 0.25 });
  assert.deepEqual([lowered.value.min.value, lowered.value.max.value], [0, 0.25]);

  const listed = edits.setValueMode(base, VALUE_MODE.choice, choice);
  const both = edits.toggleChoice(edits.toggleChoice(listed, 1), 2);
  assert.deepEqual(both.value.choices.map((item) => item.value), [0.5, 1, 2]);
  const single = { ...both, value: { ...both.value, choices: [{ type: VALUE_TYPE.choice, value: 1 }] } };
  assert.equal(edits.toggleChoice(single, 1), single, 'the list is never left empty');
});

test('what is typed becomes a value of the command, or nothing', () => {
  assert.deepEqual(edits.parseValue(integer(1, 16), ' 12 '), { type: VALUE_TYPE.integer, value: 12 });
  assert.equal(edits.parseValue(integer(1, 16), '17'), null);
  assert.equal(edits.parseValue(integer(1, 16), '1.5'), null);
  assert.deepEqual(edits.parseValue(number(0, 2), '0,75'), { type: VALUE_TYPE.number, value: 0.75 }, 'a French decimal comma');
  assert.equal(edits.parseValue(number(0, 2), '2.5'), null);
  assert.equal(edits.parseValue(number(0, 2), 'abc'), null);
  assert.deepEqual(edits.parseValue({ type: VALUE_TYPE.boolean }, 'On'), { type: VALUE_TYPE.boolean, value: true });
  assert.deepEqual(edits.parseValue(choice, '2'), { type: VALUE_TYPE.choice, value: 2 });
  assert.equal(edits.parseValue(choice, '3'), null);
  assert.equal(edits.parseValue(null, '1'), null);
  assert.deepEqual(edits.parseValueList(number(0, 2), '0,5; 1,5').map((item) => item.value), [0.5, 1.5]);
  assert.deepEqual(edits.parseValueList(number(0, 2), '0.5, 1.5').map((item) => item.value), [0.5, 1.5]);
  assert.equal(edits.parseValueList(number(0, 2), '0.5, 9'), null, 'one value out of range refuses the list');
  assert.equal(edits.formatValue({ type: VALUE_TYPE.number, value: 0.123456 }), '0.1235');
  assert.equal(edits.formatValue({ type: VALUE_TYPE.choice, value: 1 }, choice), 'Down');
});

test('conditions are added once, named, removed; follow actions are kept in order', () => {
  assert.deepEqual(edits.conditionFor('every-3'), { kind: CONDITION.everyNth, interval: 3, channel: 0 });
  assert.deepEqual(edits.conditionFor('if-inactive', 4), { kind: CONDITION.ifInactive, interval: 2, channel: 4 });
  assert.equal(edits.conditionFor('if-active', 16), null);
  assert.equal(edits.conditionFor('never'), null);
  const cell = cellAt(createSequence().scenes[0].channels[0], 0);
  const once = edits.addCondition(cell, edits.conditionFor('every-2'));
  assert.equal(edits.addCondition(once, edits.conditionFor('every-2')), once);
  const twice = edits.addCondition(once, edits.conditionFor('if-active', 3));
  assert.deepEqual(twice.conditions.map(edits.conditionLabel), ['Every 2nd loop', 'If CH 04 active']);
  assert.equal(edits.conditionLabel({ kind: CONDITION.everyNth, interval: 11 }), 'Every 11th loop');
  assert.deepEqual(edits.removeCondition(twice, 0).conditions.map(edits.conditionLabel), ['If CH 04 active']);

  let content = createSequence();
  content = edits.addFollowAction(content, 0, 1, edits.followAction('one-ring:channel:2', 'START'));
  content = edits.addFollowAction(content, 0, 1, edits.followAction('mixer-001', 'LEVEL', { type: VALUE_TYPE.number, value: 0.8 }));
  assert.equal(edits.addFollowAction(content, 0, 1, edits.followAction('', 'START')), content);
  const follow = content.scenes[0].channels[1].follow;
  assert.deepEqual(follow.map((action) => [action.target, action.command, action.value.fixed.value]),
    [['one-ring:channel:2', 'START', undefined], ['mixer-001', 'LEVEL', 0.8]]);
  assert.deepEqual(edits.removeFollowAction(content, 0, 1, 0).scenes[0].channels[1].follow.map((action) => action.target), ['mixer-001']);
});

test('what the edits make is a sequence the engine takes', () => {
  let content = createSequence();
  content = edits.setSceneTiming(content, SCENE_TIMING.nextBar);
  content = edits.setScenePosition(content, SCENE_POSITION.keep);
  content = edits.selectScene(content, 2);
  assert.equal(edits.selectScene(content, 9), content);
  const scene = 2;
  content = edits.setChannelTarget(content, scene, 0, 'one-ring:channel:3');
  content = edits.setChannelCommand(content, scene, 0, 'RESTART', { id: 'RESTART', type: VALUE_TYPE.none });
  content = edits.setChannelSetting(content, scene, 0, 'repeats', 2);
  content = edits.setChannelSetting(content, scene, 0, 'humanize', 45);
  content = edits.editCell(content, scene, 0, 7, (cell) => edits.addCondition(edits.toggleActive(cell), edits.conditionFor('last')));
  content = edits.addFollowAction(content, scene, 0, edits.followAction('one-ring:scenes', 'RECALL', { type: VALUE_TYPE.choice, value: 1 }));
  assert.deepEqual(readSequence(content), content, 'it reads back as it was written');
  assert.deepEqual(sequenceErrors(content, targetFinder(content)), []);
  assert.equal(edits.describeCell(cellAt(content.scenes[scene].channels[0], 7), content.scenes[scene].channels[0], null),
    'Plays on the last loop');
});

// ---------- the markup ----------

function viewFor(content, overrides = {}) {
  const external = [{
    id: 'mixer-001',
    label: 'Mixer <b>1</b>',
    commands: new Map([['LEVEL', number(0, 2)], ['PLAY', held]])
  }];
  const byId = new Map(external.map((target) => [target.id, target]));
  const channel = content.scenes[0].channels[0];
  return {
    name: 'One Ring 1', icon: 'ring', content, scene: 0, sceneData: content.scenes[0],
    channelIndex: 0, channel, cellIndex: 0, cell: cellAt(channel, 0),
    targets: { internal: [], external },
    findTarget: (id) => byId.get(id) ?? null,
    find: (target, command) => byId.get(target)?.commands.get(command) ?? null,
    ready: false, storeArmed: false, seedText: null, seedError: false,
    followDraft: { target: '', command: '', value: '' }, conditionChannel: 1,
    ...overrides
  };
}

test('the page draws sixteen channels, sixty-four pads and every control, with no inline style', () => {
  const content = createSequence();
  const page = renderPage(viewFor(content));
  assert.equal((page.match(/data-ring-act="channel"/g) || []).length, CHANNEL_COUNT);
  assert.equal((page.match(/data-ring-pad="/g) || []).length, 64);
  assert.equal((page.match(/data-ring-scene="/g) || []).length, 4);
  for (const act of ['run', 'stop', 'store', 'timing', 'position', 'seed', 'new-seed', 'mutate-channel', 'mutate-all',
    'target', 'command', 'restart-channel', 'stop-channel', 'mutable', 'enabled', 'length', 'rate', 'repeats', 'mode',
    'knob-value', 'active', 'value-mode', 'cond-add', 'cond-channel', 'lock-cell', 'lock-field',
    'follow-target', 'follow-command', 'follow-add']) {
    assert.match(page, new RegExp(`data-ring-act="${act}"`), act);
  }
  for (const knob of ['offset', 'swing', 'humanize', 'probability']) assert.match(page, new RegExp(`data-ring-knob="${knob}"`));
  assert.match(page, /id="node-delete"/, 'the shared Delete Node handler finds its button');
  assert.doesNotMatch(page, /\sstyle\s*=/);
  assert.match(page, /data-ring-act="run"[^>]*data-ring-live-run|disabled [^>]*data-ring-act="run"/);
  assert.match(page, /<button[^>]*disabled [^>]*data-ring-act="run"/, 'nothing to run without a runtime');
  assert.match(page, /NOT IN THE ENGINE/);
  assert.doesNotMatch(renderPage(viewFor(content, { ready: true })), /<button[^>]*disabled [^>]*data-ring-act="run"/);
});

test('names from outside are escaped, a lost target is shown struck, and Legato waits for a release', () => {
  let content = createSequence();
  content = edits.setChannelTarget(content, 0, 0, 'mixer-001');
  content = edits.setChannelCommand(content, 0, 0, 'LEVEL', number(0, 2));
  content = edits.setChannelTarget(content, 0, 1, 'mixer-404');
  const regions = renderRegions(viewFor(content));
  assert.match(regions.channels, /Mixer &lt;b&gt;1&lt;\/b&gt; · Level/);
  assert.doesNotMatch(regions.channels, /<b>1<\/b>/);
  assert.match(regions.channels, /op-scribble is-missing[^>]*><span class="op-scribble-text">mixer-404 · no command/);
  assert.match(regions.channel, /Step mode · no release/);
  assert.match(regions.channel, /aria-label="Legato" disabled/);
  let legato = edits.setChannelCommand(content, 0, 0, 'PLAY', held);
  legato = edits.setChannelSetting(legato, 0, 0, 'mode', STEP_MODE.legato, { descriptor: held });
  const view = viewFor(legato);
  assert.match(renderRegions(view).channel, /aria-label="Legato" checked /);
  assert.match(renderRegions(viewFor(content, { storeArmed: true })).deck, /is-armed/);
  assert.match(renderRegions(viewFor(content, { seedError: true, seedText: 'x' })).deck, /is-invalid[^>]*value="x"/);
});

// ---------- the page, bound ----------

function mockApi() {
  const data = {};
  const sent = [];
  const listeners = { event: [], state: [] };
  return {
    data,
    sent,
    emitEvent(msg) { listeners.event.forEach((cb) => cb(msg)); },
    loadSettings: async () => ({ ...data }),
    saveSettings: async (settings) => { Object.assign(data, settings); return true; },
    engineCommand: async (msg) => { sent.push(msg); return { ok: true }; },
    engineState: async () => ({ state: 'running', error: null }),
    onEngineEvent: (cb) => { listeners.event.push(cb); return () => {}; },
    onEngineState: (cb) => { listeners.state.push(cb); return () => {}; }
  };
}

function fakeElement(dataset = {}, tagName = 'BUTTON', extra = {}) {
  const classes = new Set();
  const attributes = {};
  const element = {
    dataset,
    tagName,
    disabled: false,
    value: '',
    textContent: '',
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      toggle: (name, force) => { if (force ?? !classes.has(name)) classes.add(name); else classes.delete(name); },
      contains: (name) => classes.has(name)
    },
    setAttribute: (name, value) => { attributes[name] = String(value); },
    getAttribute: (name) => attributes[name],
    querySelector: () => null,
    focus() {},
    closest(selector) {
      return selector.split(',').some((part) => matches(element, part.trim())) ? element : null;
    },
    ...extra
  };
  return element;
}

// `[data-x]`, `[data-x="y"]`, `tag[data-x]`: what the page asks `closest` for.
function matches(element, selector) {
  const tag = selector.match(/^([a-z]+)/)?.[1];
  if (tag && element.tagName.toLowerCase() !== tag) return false;
  const attributes = [...selector.matchAll(/\[data-([a-z-]+)(?:="([^"]*)")?\]/g)];
  if (!attributes.length) return false;
  return attributes.every(([, name, value]) => {
    const key = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    return Object.hasOwn(element.dataset, key) && (value === undefined || element.dataset[key] === value);
  });
}

async function page({ ready = true } = {}) {
  const api = mockApi();
  const hub = createHub(api);
  await hub.engine.init();
  hub.project._loading = false;
  const ring = hub.nodes.create('one-ring');
  const mixer = hub.nodes.create('mixer');
  hub.network.connect(ring.id, 'ctrl-out', mixer.id, 'ctrl-in');
  await settle();
  if (ready) api.emitEvent({ type: 'oneRingSynced', nodeId: ring.id, generation: 3, created: true, ok: true, message: '' });
  const editor = getNodeEditor('one-ring');
  const context = { instance: hub.nodes.get(ring.id), type: { id: 'one-ring', icon: 'ring' }, hub };
  const listeners = new Map();
  const regions = new Map();
  const live = new Map();
  const region = (name) => {
    if (!regions.has(name)) {
      const element = fakeElement({ ringRegion: name }, 'SECTION', { contains: () => true, paints: [] });
      Object.defineProperty(element, 'innerHTML', { set(markup) { element.paints.push(markup); } });
      regions.set(name, element);
    }
    return regions.get(name);
  };
  const liveElement = (selector) => {
    if (!live.has(selector)) live.set(selector, fakeElement({}, 'SPAN'));
    return live.get(selector);
  };
  const container = {
    contains: () => true,
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type, fn) => { if (listeners.get(type) === fn) listeners.delete(type); },
    querySelector(selector) {
      const named = selector.match(/^\[data-ring-region="([a-z]+)"\]$/);
      if (named) return region(named[1]);
      if (/^\[data-ring-(live|dot|led|pad)[=\]-]/.test(selector)) return liveElement(selector);
      return null;
    },
    querySelectorAll: () => []
  };
  editor.render(context);
  const teardown = editor.bind(container, context);
  const sent = (type) => api.sent.filter((msg) => msg.type === type);
  const fire = (type, target) => listeners.get(type)?.({ target, button: 0, pointerId: 1, clientY: 0, preventDefault() {} });
  const press = (act, arg) => fire('click', fakeElement(arg === undefined ? { ringAct: act } : { ringAct: act, ringArg: String(arg) }));
  const change = (act, value, tagName = 'SELECT') => fire('change', fakeElement({ ringAct: act }, tagName, { value, type: 'text' }));
  const typed = (act, value, arg) => {
    const field = fakeElement(arg === undefined ? { ringAct: act } : { ringAct: act, ringArg: arg }, 'INPUT', { value, type: 'text' });
    fire('change', field);
    return field;
  };
  const content = () => hub.nodes.get(ring.id).content;
  // What a page is looking at is kept per node id, and every test's hub
  // numbers its first node the same way.
  press('channel', 0);
  change('cond-channel', '1');
  change('follow-target', '');
  return { api, hub, ring, mixer, context, container, listeners, regions, live, teardown, sent, fire, press, change, typed, content, liveElement };
}

test('RUN, STOP, a scene and a channel\'s keys play the runtime and leave the sequence alone', async () => {
  const unregister = registerOneRingPanel();
  try {
    const { press, sent, content, teardown } = await page();
    const before = JSON.stringify(content());
    press('run');
    press('stop');
    press('scene', 2);
    press('restart-channel');
    press('stop-channel');
    await settle();
    assert.deepEqual(sent('oneRingCommand').map(({ command, scene, channel, name, generation }) => [command, scene ?? channel ?? null, name ?? null, generation]), [
      ['run', null, null, 3], ['stop', null, null, 3], ['scene', 2, null, 3], ['channel', 1, 'RESTART', 3], ['channel', 1, 'STOP', 3]
    ]);
    assert.equal(JSON.stringify(content()), before);
    teardown();
  } finally {
    unregister();
  }
});

test('with no runtime a scene key chooses the scene the file opens in, as performance', async () => {
  const unregister = registerOneRingPanel();
  try {
    const { hub, press, sent, content, teardown } = await page({ ready: false });
    setupEditHistory(hub, { apply: async () => {}, quietMs: 5 });
    hub.history.start();
    press('scene', 3);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(content().selectedScene, 3);
    assert.equal(sent('oneRingCommand').length, 0);
    assert.equal(hub.history.canUndo, false, 'looking at a scene is not an edit');
    teardown();
  } finally {
    unregister();
  }
});

test('an edit is one undo step and reaches the engine; STORE copies the scene shown into the one pressed', async () => {
  const unregister = registerOneRingPanel();
  try {
    const { hub, ring, mixer, press, change, sent, content, regions, teardown } = await page();
    setupEditHistory(hub, { apply: async () => {}, quietMs: 5 });
    hub.history.start();
    const syncs = sent('syncOneRing').length;
    change('target', mixer.id);
    change('command', 'MASTER');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const channel = content().scenes[0].channels[0];
    assert.deepEqual([channel.target.target, channel.target.command], [mixer.id, 'MASTER']);
    assert.deepEqual(cellAt(channel, 0).value.fixed, { type: VALUE_TYPE.number, value: 0 }, 'the command\'s default');
    assert.equal(hub.history.canUndo, true);
    const pushed = sent('syncOneRing').slice(syncs);
    assert.ok(pushed.length >= 2 && pushed.every((msg) => msg.nodeId === ring.id && msg.restore === false));
    assert.ok(regions.get('channels').paints.at(-1).includes('Mixer 1 · Master'), 'the channel list is drawn again');

    press('store');
    press('scene', 2);
    assert.deepEqual(content().scenes[2].channels, content().scenes[0].channels);
    assert.equal(content().scenes[2].id, 'C');
    assert.equal(sent('oneRingCommand').length, 0, 'a scene key that stores does not recall');
    teardown();
  } finally {
    unregister();
  }
});

test('channels and cells are chosen, and a pad turns on with a double click', async () => {
  const unregister = registerOneRingPanel();
  try {
    const { press, fire, content, regions, teardown } = await page();
    press('channel', 4);
    assert.match(regions.get('channel').paints.at(-1), /CH 05/);
    press('pad', 9);
    assert.match(regions.get('cell').paints.at(-1), /Cell 10/);
    fire('dblclick', fakeElement({ ringAct: 'pad', ringArg: '11' }));
    assert.equal(cellAt(content().scenes[0].channels[4], 11).enabled, true);
    assert.equal(cellAt(content().scenes[0].channels[4], 9).enabled, false);
    press('active');
    assert.equal(cellAt(content().scenes[0].channels[4], 11).enabled, false, 'ACTIVE works on the cell chosen');
    press('lock-field', MUTABLE.value);
    assert.equal(cellAt(content().scenes[0].channels[4], 11).lockedFields, MUTABLE.value);
    press('mutable', MUTABLE.enabled);
    assert.equal(content().scenes[0].channels[4].mutableFields, MUTABLE.probability | MUTABLE.value);
    teardown();
  } finally {
    unregister();
  }
});

test('a knob turns with the arrow keys and with the mouse, and goes home on a double click', async () => {
  const unregister = registerOneRingPanel();
  try {
    const { listeners, fire, content, teardown } = await page();
    const knob = (name, value) => {
      const attributes = { 'aria-valuenow': String(value) };
      return fakeElement({ ringKnob: name }, 'SPAN', {
        getAttribute: (key) => attributes[key],
        setAttribute: (key, next) => { attributes[key] = String(next); },
        setPointerCapture() {}
      });
    };
    listeners.get('keydown')({ target: knob('swing', 0), key: 'ArrowUp', preventDefault() {} });
    assert.equal(content().scenes[0].channels[0].swing, 0.01);
    listeners.get('keydown')({ target: knob('offset', 0), key: 'Home', preventDefault() {} });
    assert.equal(content().scenes[0].channels[0].offset, -64);

    const dragged = knob('humanize', 0);
    listeners.get('pointerdown')({ target: dragged, button: 0, pointerId: 7, clientY: 300, preventDefault() {} });
    listeners.get('pointermove')({ target: dragged, pointerId: 7, clientY: 200, shiftKey: false });
    assert.equal(dragged.getAttribute('aria-valuenow'), '23', 'half the travel is half the range');
    listeners.get('pointerup')({ target: dragged, pointerId: 7 });
    assert.equal(content().scenes[0].channels[0].humanize, 0.23, 'the last position is written');

    fire('dblclick', knob('offset', -64));
    assert.equal(content().scenes[0].channels[0].offset, 0);
    teardown();
  } finally {
    unregister();
  }
});

test('typed values: the seed, a knob, a range, a list; a wrong one is refused on the field', async () => {
  const unregister = registerOneRingPanel();
  try {
    const { mixer, change, press, typed, content, teardown } = await page();
    typed('seed', '98765');
    assert.deepEqual([content().seed, content().mutation], ['98765', '0']);
    const before = content();
    typed('seed', '-1');
    assert.equal(content(), before, 'a seed that is not one changes nothing');

    typed('knob-value', '+7 st', 'offset');
    assert.equal(content().scenes[0].channels[0].offset, 7);
    const wrongKnob = typed('knob-value', 'lots', 'swing');
    assert.equal(wrongKnob.classList.contains('is-invalid'), true);

    change('target', mixer.id);
    change('command', 'MASTER');
    press('value-mode', VALUE_MODE.range);
    typed('value-max', '0,5');
    typed('value-min', '0.25');
    let value = cellAt(content().scenes[0].channels[0], 0).value;
    assert.deepEqual([value.mode, value.min.value, value.max.value], [VALUE_MODE.range, 0.25, 0.5]);
    const wrongValue = typed('value-min', '3');
    assert.equal(wrongValue.classList.contains('is-invalid'), true, 'the master goes to 2');
    press('value-mode', VALUE_MODE.choice);
    typed('value-list', '0.1; 0.2; 1');
    value = cellAt(content().scenes[0].channels[0], 0).value;
    assert.deepEqual(value.choices.map((item) => item.value), [0.1, 0.2, 1]);

    press('new-seed');
    assert.notEqual(content().seed, '98765');
    press('mutate-channel');
    assert.equal(content().mutation, '1');
    teardown();
  } finally {
    unregister();
  }
});

test('conditions and follow actions are added from the page', async () => {
  const unregister = registerOneRingPanel();
  try {
    const { mixer, change, press, fire, content, teardown } = await page();
    change('cond-channel', '5');
    const add = fakeElement({ ringAct: 'cond-add' }, 'SELECT', { value: 'if-inactive' });
    fire('change', add);
    assert.equal(add.value, '', 'the list goes back to its prompt');
    change('cond-add', 'first');
    assert.deepEqual(cellAt(content().scenes[0].channels[0], 0).conditions.map(edits.conditionLabel), ['If CH 06 inactive', 'First loop']);
    press('cond-remove', 0);
    assert.deepEqual(cellAt(content().scenes[0].channels[0], 0).conditions.map(edits.conditionLabel), ['First loop']);

    change('follow-target', mixer.id);
    change('follow-command', 'MASTER');
    change('follow-value', '1.5', 'INPUT');
    press('follow-add');
    change('follow-target', 'one-ring:channel:2');
    change('follow-command', 'START');
    press('follow-add');
    assert.deepEqual(content().scenes[0].channels[0].follow.map((action) => [action.target, action.command, action.value.fixed.value]),
      [[mixer.id, 'MASTER', 1.5], ['one-ring:channel:2', 'START', undefined]]);
    press('follow-remove', 0);
    assert.equal(content().scenes[0].channels[0].follow.length, 1);
    teardown();
  } finally {
    unregister();
  }
});

test('the status lights the page in place, and a scene change redraws it', async () => {
  const unregister = registerOneRingPanel();
  try {
    const { api, ring, regions, liveElement, teardown } = await page();
    const paints = () => [...regions.values()].reduce((sum, element) => sum + element.paints.length, 0);
    const before = paints();
    const status = {
      type: 'oneRingStatus', nodeId: ring.id, generation: 3, playing: true, beat: 9.5, bpm: 118.6, scene: 0, pendingScene: 1,
      playheads: [2, ...Array(15).fill(-1)], active: [true, ...Array(15).fill(false)], rejected: 4, guarded: 1
    };
    api.emitEvent(status);
    assert.equal(paints(), before, 'nothing is drawn again');
    assert.equal(liveElement('[data-ring-live="state"]').textContent, '▶ RUNNING');
    assert.equal(liveElement('[data-ring-live="bar"]').textContent, '3.2');
    assert.equal(liveElement('[data-ring-live="bpm"]').textContent, '118.6');
    assert.equal(liveElement('[data-ring-live="pending"]').textContent, 'NEXT BAR → B');
    assert.equal(liveElement('[data-ring-live="refused"]').textContent, '4');
    assert.equal(liveElement('[data-ring-dot="0"]').classList.contains('is-on'), true);
    assert.equal(liveElement('[data-ring-led="0"]').classList.contains('is-on'), true);
    assert.equal(liveElement('[data-ring-pad="2"]').classList.contains('is-playhead'), true);
    api.emitEvent({ ...status, playheads: [3, ...Array(15).fill(-1)] });
    assert.equal(liveElement('[data-ring-pad="2"]').classList.contains('is-playhead'), false);
    assert.equal(liveElement('[data-ring-pad="3"]').classList.contains('is-playhead'), true);

    api.emitEvent({ ...status, scene: 1, pendingScene: -1 });
    assert.ok(paints() > before, 'another scene is another drawing');
    assert.match(regions.get('channels').paints.at(-1), /Scene B/);
    teardown();
  } finally {
    unregister();
  }
});

test('a refusal is shown on the display, and unmounting leaves nothing listening', async () => {
  const unregister = registerOneRingPanel();
  try {
    const { hub, ring, listeners, liveElement, regions, teardown } = await page();
    hub.events.emit('oneRing:refusal', { nodeId: ring.id, message: 'MASTER: not cabled to this plugin' });
    assert.equal(liveElement('[data-ring-live="refusal"]').textContent, 'MASTER: not cabled to this plugin');
    teardown();
    assert.equal(listeners.size, 0);
    const paints = [...regions.values()].reduce((sum, element) => sum + element.paints.length, 0);
    hub.events.emit('oneRing:contentChanged', { nodeId: ring.id });
    hub.nodes.setContent(ring.id, edits.setSceneTiming(hub.nodes.get(ring.id).content, SCENE_TIMING.nextBar));
    assert.equal([...regions.values()].reduce((sum, element) => sum + element.paints.length, 0), paints);
  } finally {
    unregister();
  }
});

test('the status lights the display even for a page no one has touched', () => {
  const texts = new Map();
  const container = {
    querySelector: (selector) => {
      if (!texts.has(selector)) texts.set(selector, fakeElement({}, 'SPAN'));
      return texts.get(selector);
    },
    querySelectorAll: () => []
  };
  const context = {
    instance: { id: 'one-ring-9', content: createSequence() },
    hub: { oneRing: { statusOf: () => null, generationOf: () => null } }
  };
  applyStatus(container, context);
  assert.equal(texts.get('[data-ring-live="state"]').textContent, 'NOT IN THE ENGINE');
  assert.equal(texts.get('[data-ring-live="bar"]').textContent, '—');
});
