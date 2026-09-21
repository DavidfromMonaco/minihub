import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from '../src/renderer/js/core/hub.js';
import { getNodeEditor } from '../src/renderer/js/core/nodeEditors.js';
import { getNodeType, listOmniBoxCategories } from '../src/renderer/js/core/nodeTypes.js';
import {
  defaultAudioPlayerContent, fileNameOf, formatPlayerTime, normalizeAudioPlayerContent
} from '../src/renderer/js/core/audioPlayerState.js';
import { audioNodeValues, audioTopologyKey, describeAudioNetwork, setupEngineSync } from '../src/renderer/js/core/engineSync.js';
import { describeNodes } from '../src/renderer/js/core/agentDescribe.js';
import { registerAudioPlayerPanel, waveformPath } from '../src/renderer/js/modules/audioPlayer/audioPlayerPanel.js';

/**
 * Contract: an Audio Player node names a file; the engine plays it (native
 * audio_player.h). The node's content -- file, loop, level -- reaches the
 * engine as the whole list of players and as a value of the audio network; the
 * engine's answers -- the file's state, where the player is -- come back to the
 * node's page, the transport's Stop and the agent. The rig is the real hub with
 * the engine played by `api`.
 */

registerAudioPlayerPanel();

const settle = () => new Promise((resolve) => setImmediate(resolve));

function mockApi() {
  const data = {};
  const sent = [];
  const listeners = { event: [], state: [] };
  return {
    data,
    sent,
    picked: null,
    emitEvent(msg) { listeners.event.forEach((cb) => cb(msg)); },
    emitState(state) { listeners.state.forEach((cb) => cb(state)); },
    loadSettings: async () => ({ ...data }),
    saveSettings: async (settings) => { Object.assign(data, settings); return true; },
    engineCommand: async (msg) => { sent.push(msg); return { ok: true }; },
    engineState: async () => ({ state: 'running', error: null }),
    onEngineEvent: (cb) => { listeners.event.push(cb); return () => {}; },
    onEngineState: (cb) => { listeners.state.push(cb); return () => {}; },
    async audioPickOpen() { return this.picked; }
  };
}

async function rig() {
  const api = mockApi();
  const hub = createHub(api);
  await hub.engine.init();
  hub.project._loading = false;
  const player = hub.nodes.create('audio-player');
  await settle();
  const sent = (type) => api.sent.filter((msg) => msg.type === type);
  const lastList = () => sent('syncAudioPlayers').at(-1)?.players;
  const answer = (fields) => api.emitEvent({ type: 'audioPlayerFile', nodeId: player.id, filePath: '', state: 'empty', message: '', ...fields });
  const report = (fields) => api.emitEvent({ type: 'audioPlayerStatus', nodeId: player.id, state: 'stopped', positionSeconds: 0, ended: 0, ...fields });
  return { api, hub, player, sent, lastList, answer, report };
}

const READY = {
  state: 'ready', filePath: 'C:\\Loops\\drums.wav', durationSeconds: 4, sampleRate: 44100, channels: 2,
  format: 'WAV file', peaks: [0.1, 0.8, 0.4, 0.2]
};

// ---------- the node ----------

test('an Audio Player is an Audio OmniBox with one AUDIO OUT, and starts without a file', async () => {
  const { player } = await rig();
  const audio = listOmniBoxCategories().find((category) => category.label === 'Audio');
  assert.ok(audio.types.some((type) => type.id === 'audio-player'));
  const type = getNodeType('audio-player');
  assert.deepEqual(type.ports.inputs, []);
  assert.deepEqual(type.ports.outputs.map((port) => [port.id, port.type]), [['audio-out', 'audio']]);
  assert.equal(player.name, 'Audio Player 1');
  assert.deepEqual(player.content, defaultAudioPlayerContent());
});

test('content from a file or an agent is made safe before it reaches the engine', () => {
  assert.deepEqual(normalizeAudioPlayerContent(null), { filePath: '', loop: false, level: 1 });
  assert.deepEqual(normalizeAudioPlayerContent({ filePath: 'C:\\a.wav', loop: 'yes', level: 7 }),
    { filePath: 'C:\\a.wav', loop: false, level: 2 });
  assert.equal(normalizeAudioPlayerContent({ level: -1 }).level, 0);
  assert.equal(normalizeAudioPlayerContent({ level: 'loud' }).level, 1);
  assert.equal(normalizeAudioPlayerContent({ filePath: 'C:\\a\0.wav' }).filePath, '', 'a NUL is no path');
  assert.equal(normalizeAudioPlayerContent({ filePath: 42 }).filePath, '');
  assert.equal(fileNameOf('C:\\Loops\\drums.wav'), 'drums.wav');
  assert.equal(fileNameOf('/home/x/y.mp3'), 'y.mp3');
  assert.equal(formatPlayerTime(0), '0:00.0');
  assert.equal(formatPlayerTime(65.25), '1:05.2');
  assert.equal(formatPlayerTime(NaN), '0:00.0');
});

// ---------- the engine ----------

test('the engine is given every player, asked to describe the ones it has not told about', async () => {
  const { player, lastList, answer } = await rig();
  assert.deepEqual(lastList(), [{ nodeId: player.id, filePath: '', loop: false, describe: true }]);
  answer({ state: 'empty' });
  assert.equal(player.content.filePath, '');
});

test('a file chosen, a loop set, reach the engine; a node deleted leaves its list', async () => {
  const { hub, player, sent, lastList, answer } = await rig();
  answer({ state: 'empty' });
  hub.nodes.setContent(player.id, { ...player.content, filePath: 'C:\\Loops\\drums.wav' });
  await settle();
  assert.deepEqual(lastList(), [{ nodeId: player.id, filePath: 'C:\\Loops\\drums.wav', loop: false, describe: true }]);
  answer({ state: 'loading', filePath: 'C:\\Loops\\drums.wav' });
  const count = sent('syncAudioPlayers').length;
  hub.nodes.setContent(player.id, { ...hub.nodes.get(player.id).content, loop: true });
  await settle();
  assert.deepEqual(lastList(), [{ nodeId: player.id, filePath: 'C:\\Loops\\drums.wav', loop: true }],
    'a file the engine already answered for is not asked about again');
  assert.equal(sent('syncAudioPlayers').length, count + 1);
  hub.audioPlayers.sync();
  await settle();
  assert.equal(sent('syncAudioPlayers').length, count + 1, 'an unchanged list is not sent again');
  const second = hub.nodes.create('audio-player');
  await settle();
  assert.deepEqual(lastList().map((entry) => entry.nodeId), [player.id, second.id]);
  hub.nodes.delete(player.id);
  await settle();
  assert.deepEqual(lastList().map((entry) => entry.nodeId), [second.id], 'a deleted node holds no file');
});

test('the same file chosen again is read again from the disk', async () => {
  const { hub, player, sent, lastList, answer } = await rig();
  hub.nodes.setContent(player.id, { ...player.content, filePath: 'C:\\Loops\\drums.wav' });
  await settle();
  answer(READY);
  hub.audioPlayers.reload(player.id);
  await settle();
  assert.equal(lastList()[0].reload, true);
  const count = sent('syncAudioPlayers').length;
  hub.audioPlayers.sync();
  await settle();
  assert.equal(sent('syncAudioPlayers').length, count, 'the request is sent once, not remembered');
});

test('a new engine is given the list again, and every file is read anew', async () => {
  const { api, hub, player, sent, answer } = await rig();
  hub.nodes.setContent(player.id, { ...player.content, filePath: 'C:\\Loops\\drums.wav' });
  await settle();
  answer(READY);
  assert.equal(hub.audioPlayers.fileOf(player.id).state, 'ready');
  const count = sent('syncAudioPlayers').length;
  api.emitState({ state: 'stopped' });
  await settle();
  assert.equal(hub.audioPlayers.fileOf(player.id), null, 'a stopped engine holds no file');
  api.emitState({ state: 'running' });
  await settle();
  const again = sent('syncAudioPlayers').slice(count).at(-1);
  assert.deepEqual(again?.players, [{ nodeId: player.id, filePath: 'C:\\Loops\\drums.wav', loop: false, describe: true }]);
});

test('its level is a value of the audio network, not a new network', async () => {
  const { api, hub, player, sent } = await rig();
  setupEngineSync(hub);
  const mixer = hub.nodes.create('mixer');
  hub.network.connect(player.id, 'audio-out', mixer.id, 'audio-in-1');
  await settle();
  const described = describeAudioNetwork(hub).find((node) => node.id === player.id);
  assert.deepEqual(described, { id: player.id, nodeType: 'audio-player', inputs: [], masterLevel: 1 });
  const networks = sent('syncAudioNetwork').length;
  const topology = audioTopologyKey(describeAudioNetwork(hub));
  hub.nodes.setContent(player.id, { ...player.content, level: 0.5 });
  await settle();
  assert.equal(audioTopologyKey(describeAudioNetwork(hub)), topology);
  assert.equal(sent('syncAudioNetwork').length, networks, 'no recompile for a level');
  const values = sent('setAudioNodeValues').at(-1)?.nodes.find((node) => node.id === player.id);
  assert.equal(values?.masterLevel, 0.5);
  assert.deepEqual(audioNodeValues([described]), [{ id: player.id, inputs: [], masterLevel: 1 }]);
  assert.equal(api.sent.every((msg) => !JSON.stringify(msg).includes('"samples"')), true, 'no sample crosses the IPC');
});

test('Play, Pause, Stop and a place go to its player, and nothing else is written', async () => {
  const { hub, player, sent } = await rig();
  const before = JSON.stringify(player.content);
  await hub.audioPlayers.play(player.id);
  await hub.audioPlayers.pause(player.id);
  await hub.audioPlayers.stop(player.id);
  await hub.audioPlayers.seek(player.id, 1.5);
  assert.deepEqual(sent('audioPlayerTransport').map(({ nodeId, action, seconds }) => [nodeId, action, seconds]), [
    [player.id, 'play', undefined], [player.id, 'pause', undefined], [player.id, 'stop', undefined], [player.id, 'seek', 1.5]
  ]);
  assert.equal((await hub.audioPlayers.seek(player.id, -1)).reason, 'invalid-position');
  assert.equal((await hub.audioPlayers.play('vst-001')).reason, 'node-not-found');
  assert.equal(JSON.stringify(hub.nodes.get(player.id).content), before);
});

test('where it plays is kept, and the transport knows one plays', async () => {
  const { hub, player, report } = await rig();
  assert.equal(hub.audioPlayers.anyPlaying(), false);
  report({ state: 'playing', positionSeconds: 1.25 });
  assert.equal(hub.audioPlayers.statusOf(player.id).positionSeconds, 1.25);
  assert.equal(hub.audioPlayers.anyPlaying(), true);
  report({ state: 'paused', positionSeconds: 2 });
  assert.equal(hub.audioPlayers.anyPlaying(), false);
  report({ state: 'bogus', positionSeconds: -3 });
  assert.deepEqual([hub.audioPlayers.statusOf(player.id).state, hub.audioPlayers.statusOf(player.id).positionSeconds], ['stopped', 0]);
});

test('an agent plays a player as its page does, whatever project id it holds', async () => {
  const { hub, player, sent } = await rig();
  const { handleAgentRequest } = await import('../src/renderer/js/core/agentRequests.js');
  assert.deepEqual(await handleAgentRequest(hub, { kind: 'audio-player', nodeId: player.id, operation: 'play' }), { ok: true });
  assert.deepEqual(await handleAgentRequest(hub, { kind: 'audio-player', nodeId: player.id, operation: 'seek', seconds: 2 }), { ok: true });
  assert.deepEqual(sent('audioPlayerTransport').map(({ action, seconds }) => [action, seconds]), [['play', undefined], ['seek', 2]]);
  assert.equal((await handleAgentRequest(hub, { kind: 'audio-player', nodeId: player.id, operation: 'rewind' })).reason, 'invalid-action');
  assert.equal((await handleAgentRequest(hub, { kind: 'audio-player', nodeId: 'mixer-001', operation: 'play' })).reason, 'node-not-found');
  assert.deepEqual(await handleAgentRequest(hub, { kind: 'set-node-content', expectedProjectId: hub.project.projectId, nodeId: player.id,
    content: { filePath: 'C:\\Loops\\drums.wav', loop: true, level: 0.5 } }), { ok: true });
  assert.deepEqual(hub.nodes.get(player.id).content, { filePath: 'C:\\Loops\\drums.wav', loop: true, level: 0.5 });
});

test('the agent reads what the engine said of the file and where the player is', async () => {
  const { hub, player, answer, report } = await rig();
  hub.nodes.setContent(player.id, { ...player.content, filePath: READY.filePath });
  await settle();
  let described = describeNodes(hub).find((node) => node.id === player.id);
  assert.equal(described.status.file, 'loading');
  answer(READY);
  report({ state: 'playing', positionSeconds: 0.5 });
  described = describeNodes(hub).find((node) => node.id === player.id);
  assert.deepEqual(described.status, {
    file: 'ready', message: '', durationSeconds: 4, sampleRate: 44100, channels: 2, state: 'playing', positionSeconds: 0.5
  });
  assert.equal(described.content.filePath, READY.filePath);
});

// ---------- the page ----------

function fakeElement(dataset, tagName = 'BUTTON', extra = {}) {
  const attributes = {};
  const classes = new Set();
  const element = {
    tagName, dataset, disabled: false, value: '', checked: false, textContent: '',
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      toggle: (name, force) => { if (force ?? !classes.has(name)) classes.add(name); else classes.delete(name); },
      contains: (name) => classes.has(name)
    },
    setAttribute: (name, value) => { attributes[name] = String(value); },
    getAttribute: (name) => attributes[name],
    closest(selector) {
      const [, name, value] = selector.match(/^\[data-([a-z-]+)(?:="([^"]*)")?\]$/) || [];
      if (!name) return null;
      const key = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      return Object.hasOwn(dataset, key) && (value === undefined || dataset[key] === value) ? element : null;
    },
    ...extra
  };
  return element;
}

async function page() {
  const found = await rig();
  const { hub, player } = found;
  const editor = getNodeEditor('audio-player');
  const context = { instance: hub.nodes.get(player.id), type: getNodeType('audio-player'), hub };
  const listeners = new Map();
  const paints = [];
  const live = new Map();
  const liveElement = (selector) => {
    if (!live.has(selector)) live.set(selector, fakeElement({}, 'SPAN'));
    return live.get(selector);
  };
  const container = {
    contains: () => true,
    addEventListener: (type, fn) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    removeEventListener: (type, fn) => listeners.set(type, (listeners.get(type) ?? []).filter((item) => item !== fn)),
    querySelector: (selector) => liveElement(selector),
    set innerHTML(markup) { paints.push(markup); }
  };
  paints.push(editor.render(context));
  const teardown = editor.bind(container, context);
  const dispatch = (type, event) => { for (const listener of listeners.get(type) ?? []) listener(event); };
  const click = (act) => dispatch('click', { target: fakeElement({ apAct: act }) });
  return { ...found, editor, context, container, listeners, paints, live, teardown, dispatch, click };
}

test('the page says what there is to do before a file, and draws the file once it is read', async () => {
  const { hub, player, editor, context, answer } = await page();
  const empty = editor.render(context);
  assert.match(empty, /No file yet/);
  assert.match(empty, /Choose File…/);
  assert.match(empty, /data-ap-act="play" aria-pressed="false" disabled/);
  hub.nodes.setContent(player.id, { ...player.content, filePath: READY.filePath });
  await settle();
  assert.match(editor.render(context), /Loading drums\.wav…/);
  answer(READY);
  const ready = editor.render(context);
  assert.match(ready, /class="ap-wave-shape" d="M/);
  assert.match(ready, /0:04\.0 · 44\.1 kHz · stereo/);
  assert.match(ready, /Replace File…/);
  assert.doesNotMatch(ready, /data-ap-act="play"[^>]*disabled/);
  assert.doesNotMatch(ready, /\sstyle\s*=/, 'no inline style: the CSP drops it');
  answer({ state: 'error', filePath: READY.filePath, message: 'The file is missing: C:\\Loops\\drums.wav' });
  assert.match(editor.render(context), /class="ap-wave ap-wave--error"[\s\S]*The file is missing/);
  answer({ ...READY, filePath: 'C:\\Old\\other.wav' });
  assert.match(editor.render(context), /Loading drums\.wav…/, 'an answer about another file is an old one');
});

test('a file name is text, never markup', async () => {
  const { hub, player, editor, context, answer } = await page();
  const hostile = 'C:\\x\\<img src=x onerror=alert(1)>".wav';
  hub.nodes.setContent(player.id, { ...player.content, filePath: hostile });
  await settle();
  answer({ ...READY, filePath: hostile, message: '<b>no</b>' });
  const markup = editor.render(context);
  assert.doesNotMatch(markup, /<img/);
  assert.match(markup, /&lt;img src=x onerror=alert\(1\)&gt;&quot;\.wav/);
});

test('the overview is one shape, peaks above the middle and mirrored below', () => {
  assert.equal(waveformPath([]), '');
  const path = waveformPath([1, 0]);
  assert.match(path, /^M128\.00 2\.00L384\.00 49\.50L384\.00 50\.50L128\.00 98\.00Z$/);
});

test('its controls play the player and write the content, and a teardown removes them', async () => {
  const { api, hub, player, sent, answer, report, dispatch, click, teardown, listeners, live } = await page();
  api.picked = READY.filePath;
  click('choose');
  await settle();
  await settle();
  assert.equal(hub.nodes.get(player.id).content.filePath, READY.filePath);
  answer(READY);
  click('play');
  await settle();
  assert.equal(sent('audioPlayerTransport').at(-1).action, 'play');
  report({ state: 'playing', positionSeconds: 1 });
  assert.equal(live.get('[data-ap-act="play"]').textContent, 'Pause');
  assert.equal(live.get('[data-ap-time]').textContent.endsWith(' / 0:04.0'), true);
  click('play');
  await settle();
  assert.equal(sent('audioPlayerTransport').at(-1).action, 'pause', 'Play is Pause while it plays');
  click('stop');
  await settle();
  assert.equal(sent('audioPlayerTransport').at(-1).action, 'stop');
  // A click on the overview places the player where it lands.
  const wave = fakeElement({ apWave: '' }, 'DIV', { getBoundingClientRect: () => ({ left: 100, width: 400 }) });
  dispatch('click', { target: wave, clientX: 200 });
  await settle();
  assert.deepEqual([sent('audioPlayerTransport').at(-1).action, sent('audioPlayerTransport').at(-1).seconds], ['seek', 1]);
  // The loop and the level are content.
  dispatch('change', { target: fakeElement({ apAct: 'loop' }, 'INPUT', { checked: true }) });
  assert.equal(hub.nodes.get(player.id).content.loop, true);
  const writes = sent('setAudioNodeValues').length;
  dispatch('input', { target: fakeElement({ apAct: 'level' }, 'INPUT', { value: '0.4' }) });
  assert.equal(hub.nodes.get(player.id).content.level, 1, 'a level being dragged is heard, not yet written');
  assert.equal(sent('setAudioNodeValues').length, writes + 1);
  assert.equal(sent('setAudioNodeValues').at(-1).nodes[0].masterLevel, 0.4);
  dispatch('change', { target: fakeElement({ apAct: 'level' }, 'INPUT', { value: '0.4' }) });
  assert.equal(hub.nodes.get(player.id).content.level, 0.4, 'and written when let go');
  // The same file chosen again is read again, not written again.
  click('choose');
  await settle();
  await settle();
  assert.equal(sent('syncAudioPlayers').at(-1).players[0].reload, true);
  teardown();
  assert.equal([...listeners.values()].every((list) => list.length === 0), true, 'every listener removed');
  const count = sent('audioPlayerTransport').length;
  report({ state: 'stopped' });
  click('play');
  await settle();
  assert.equal(sent('audioPlayerTransport').length, count, 'a page taken down does nothing');
});
