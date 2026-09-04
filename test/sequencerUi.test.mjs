import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createHub } from '../src/renderer/js/core/hub.js';
import { createMiniLabModule } from '../src/renderer/js/modules/minilab/minilabModule.js';
import { createSequencerModule } from '../src/renderer/js/modules/sequencer/sequencerModule.js';
import { buildHeader } from '../src/renderer/js/ui/header.js';
import { findClass, fire, installDom, makeEl } from './domShim.mjs';

installDom();
const { createRoutingModule } = await import('../src/renderer/js/modules/routing/routingModule.js');

const flush = () => new Promise((resolve) => setImmediate(resolve));

function mockApi(initialSettings = {}) {
  const data = structuredClone(initialSettings);
  const sent = [];
  return {
    data,
    sent,
    loadSettings: async () => structuredClone(data),
    saveSettings: async (next) => { Object.assign(data, structuredClone(next)); return true; },
    diagnosticsLog: () => true,
    engineCommand: async (message) => { sent.push(message); return { ok: true }; },
    engineState: async () => ({ state: 'running', error: null }),
    onEngineEvent: () => () => {},
    onEngineState: () => () => {},
    audioPickOpen: async () => null,
    audioPickSave: async () => null,
    audioCommitTake: async (filePath) => ({ ok: true, filePath }),
    clipEditorOpen: async (clipId) => { sent.push({ type: 'clipEditorOpen', clipId }); return { ok: true }; }
  };
}

async function runtime(initialSettings = {}) {
  const api = mockApi(initialSettings);
  const hub = createHub(api);
  await hub.settings.load();
  hub.sequencer.load();
  await flush();
  return { api, hub };
}

function captureContainer() {
  const container = makeEl('div');
  const actions = new Map();
  const controls = new Map();
  const clips = [];
  let metronomeLight = null;
  let markup = '';
  container.clientWidth = 1200;
  Object.defineProperty(container, 'innerHTML', {
    get: () => markup,
    set: (value) => {
      markup = String(value);
      actions.clear();
      controls.clear();
      clips.length = 0;
      metronomeLight = null;
      for (const action of ['open-routing', 'go-start', 'go-end', 'play', 'start-record', 'stop', 'toggle-metronome']) {
        if (!markup.includes(`data-action="${action}"`)) continue;
        const button = makeEl('button');
        button.dataset.action = action;
        if (action === 'toggle-metronome') {
          const tag = /<button class="([^"]*)"[^>]*data-action="toggle-metronome"[^>]*aria-label="[^"]*">/.exec(markup)?.[0]
            || /<button class="([^"]*)"[^>]*role="switch"[^>]*>/.exec(markup)?.[0] || '';
          const classes = /class="([^"]*)"/.exec(tag)?.[1] || '';
          button.setAttribute('class', classes);
          button.setAttribute('aria-checked', /aria-checked="true"/.test(tag) ? 'true' : 'false');
        }
        actions.set(action, button);
      }
      const tempoValue = /data-control="tempo"[^>]*value="([^"]+)"/.exec(markup)?.[1];
      if (tempoValue !== undefined) {
        const input = makeEl('input');
        input.dataset.control = 'tempo';
        input.value = tempoValue;
        input.ownerDocument = document;
        controls.set('tempo', input);
      }
      if (markup.includes('data-metronome-light')) {
        metronomeLight = makeEl('span');
        metronomeLight.dataset.metronomeLight = '';
      }
      for (const match of markup.matchAll(/<button class="seq-clip[^>]*data-clip-id="([^"]+)"[^>]*data-track-id="([^"]+)"/g)) {
        const clip = makeEl('button');
        clip.setAttribute('class', 'seq-clip');
        clip.dataset.clipId = match[1];
        clip.dataset.trackId = match[2];
        clips.push(clip);
      }
    },
    configurable: true
  });
  container.querySelector = (selector) => {
    const actionMatch = /^\[data-action="([^"]+)"\]$/.exec(selector);
    if (actionMatch) return actions.get(actionMatch[1]) || null;
    const controlMatch = /^\[data-control="([^"]+)"\]$/.exec(selector);
    if (controlMatch) return controls.get(controlMatch[1]) || null;
    if (selector === '[data-metronome-light]') return metronomeLight;
    return null;
  };
  container.querySelectorAll = (selector) => selector === '.seq-clip' ? clips : [];
  return {
    container, markup: () => markup, action: (name) => actions.get(name),
    control: (name) => controls.get(name), light: () => metronomeLight, clips: () => clips
  };
}

test('Sequencer renders actionable Record/Stop guidance and explicit per-track routing', async () => {
  const { hub } = await runtime();
  hub.nodes.create('sequencer');
  hub.nodes.create('vst');
  hub.nodes.create('vst');
  const track = hub.sequencer.model.addTrack('midi');
  hub.sequencer.model.updateTrack(track.id, { armed: true });
  hub.engine.state = 'running';
  hub.modules.register(createSequencerModule(hub));
  const view = captureContainer();
  hub.modules.activate('sequencer', view.container);

  assert.match(view.markup(), /data-action="start-record"/);
  assert.match(view.markup(), /data-action="play"/);
  assert.match(view.markup(), /data-action="stop" disabled/);
  assert.match(view.markup(), /data-control="tempo"[^>]*min="20"[^>]*max="300"/);
  assert.match(view.markup(), />Métronome<\/span>/);
  assert.match(view.markup(), /role="switch"[^>]*data-action="toggle-metronome"/);
  assert.match(view.markup(), /data-metronome-light/);
  assert.match(view.markup(), /seq-record-status blocked[^>]*>No MIDI input is detected or selected/);
  assert.match(view.markup(), /<span>Input<\/span><select[^>]*>\s*<option value="">No MIDI input detected<\/option>/);
  assert.match(view.markup(), /<span>Destination<\/span><select[^>]*>[\s\S]*VST 1 — VST chain[\s\S]*VST 2 — VST chain/);
  assert.match(view.markup(), /Each track has its own <strong>Input<\/strong> and <strong>Destination<\/strong>/);
  assert.match(view.markup(), /data-control="export-format"[\s\S]*WAV[\s\S]*MP3[\s\S]*OGG Vorbis/);
  assert.match(view.markup(), /data-control="wav-bits"[\s\S]*24-bit/);
  assert.doesNotMatch(view.markup(), /data-control="mp3-bitrate"|data-control="ogg-quality"/,
    'only options relevant to the selected WAV format are rendered');
  assert.match(view.markup(), /data-action="cancel-export" disabled/);
});

test('Sequencer metronome switch and light use only native sample-clocked ticks', async () => {
  const { api, hub } = await runtime({ metronomeEnabled: false });
  hub.nodes.create('sequencer');
  const module = createSequencerModule(hub);
  hub.modules.register(module);
  const view = captureContainer();
  hub.modules.activate('sequencer', view.container);

  const toggle = view.action('toggle-metronome');
  const light = view.light();
  assert.ok(toggle && light);
  assert.equal(toggle.getAttribute('aria-checked'), 'false');
  assert.equal(['pulse-precount', 'pulse-accent', 'pulse-beat']
    .some((name) => light.classList.contains(name)), false);

  fire(toggle, 'click');
  assert.equal(toggle.getAttribute('aria-checked'), 'true');
  assert.equal(toggle.classList.contains('active'), true);
  assert.equal(api.sent.filter((message) => message.type === 'setMetronome').at(-1).enabled, true);
  assert.equal(['pulse-precount', 'pulse-accent', 'pulse-beat']
    .some((name) => light.classList.contains(name)), false,
  'toggling cannot fabricate a visual click');

  hub.sequencer.preCounting = true;
  hub.sequencer.playing = true;
  hub.sequencer.recording = true;
  hub.events.emit('sequencer:recording', true);
  hub.events.emit('sequencer:transport', { playing: true });
  hub.events.emit('sequencer:count-in', { active: true, beat: 0, beats: 4 });
  assert.equal(view.light(), light, 'transport start preserves the live metronome light node');

  hub.events.emit('engine:metronomeTick', { sequence: 1, preCount: true, beatInBar: 0, accent: true });
  assert.equal(light.classList.contains('pulse-precount'), true, 'real pre-count tick is blue');
  hub.sequencer.preCounting = false;
  hub.events.emit('sequencer:count-in', { active: false, beat: 0, beats: 4 });
  assert.equal(view.light(), light, 'count-in completion cannot truncate the fourth blue impulse');
  hub.events.emit('engine:metronomeTick', { sequence: 2, preCount: false, beatInBar: 0, accent: true });
  assert.equal(light.classList.contains('pulse-accent'), true, 'real first beat tick is bright green');
  hub.events.emit('engine:metronomeTick', { sequence: 3, preCount: false, beatInBar: 1, accent: false });
  assert.equal(light.classList.contains('pulse-beat'), true, 'real other beat tick is dark green');
  assert.equal(light.classList.contains('pulse-accent'), false);
  module.unmount();
});

function routingContainer() {
  const container = makeEl('div');
  const svg = makeEl('svg');
  svg.setAttribute('id', 'routing-svg');
  Object.defineProperty(container, 'innerHTML', {
    get: () => '',
    set: () => { container.children.length = 0; container.appendChild(svg); },
    configurable: true
  });
  return { container, svg };
}

function networkNodeElement(svg, nodeId) {
  const nodes = findClass(svg, 'nodes');
  const stack = [...(nodes?.children || [])];
  while (stack.length) {
    const candidate = stack.pop();
    if (candidate.dataset?.nodeId === nodeId) return { candidate, nodes };
    stack.push(...candidate.children);
  }
  return { candidate: null, nodes };
}

test('Sequencer page is a Patch Bay empty-state until an explicit node exists', async () => {
  const { hub } = await runtime();
  const preserved = hub.sequencer.model.addTrack('audio');
  hub.sequencer.model.updateTrack(preserved.id, { inputId: 'audio-input' });
  let routingMounts = 0;
  hub.modules.register({ id: 'routing', mount: () => { routingMounts += 1; }, unmount() {} });
  hub.modules.register(createSequencerModule(hub));
  const view = captureContainer();

  hub.modules.activate('sequencer', view.container);
  assert.match(view.markup(), /data-sequencer-empty/);
  assert.match(view.markup(), /choose <strong>Sequencer<\/strong>.*<strong>\+ New Node<\/strong>/s);
  assert.doesNotMatch(view.markup(), /data-action="add-(?:midi|audio)"/,
    'tracks cannot be created or configured without the runtime node');
  assert.equal(hub.nodes.list().some((node) => node.type === 'sequencer'), false,
    'opening the fixed page never creates the node');

  fire(view.action('open-routing'), 'click');
  assert.equal(routingMounts, 1, 'the guidance reuses the real Routing module');
  assert.equal(hub.sequencer.model.state.tracks.length, 1, 'the hidden arrangement remains preserved');
});

test('Audio Input is a real AUDIO OUT source and cable inconsistencies stay visible', async () => {
  const { hub } = await runtime();
  const audioInput = hub.nodes.create('audio-input');
  const sequencer = hub.nodes.create('sequencer');
  const vst = hub.nodes.create('vst');
  assert.equal(audioInput.id, 'audio-input');
  assert.ok(sequencer);
  const track = hub.sequencer.model.addTrack('audio');
  hub.sequencer.model.updateTrack(track.id, { inputId: 'audio-input' });
  hub.modules.register(createSequencerModule(hub));
  const view = captureContainer();
  hub.modules.activate('sequencer', view.container);

  assert.match(view.markup(), /value="audio-input" selected>Audio Input<\/option>/,
    'the physical source is the network node exposed by Audio Input AUDIO OUT');
  assert.doesNotMatch(view.markup(), /device-input/);
  assert.match(view.markup(), /seq-route-warning">! Input selected, Patch Bay cable missing/);
  assert.equal(hub.network.connectionsTo('sequencer', 'audio-in').length, 0);

  hub.sequencer.setTrack(track.id, { inputId: 'audio-input' });
  const cables = hub.network.connectionsTo('sequencer', 'audio-in');
  assert.deepEqual(cables.map((cable) => [cable.from.nodeId, cable.from.portId]),
    [['audio-input', 'audio-out']], 'the selector creates one authoritative network cable');
  assert.match(view.markup(), /seq-route-ok">✓ Input cable connected/);

  hub.network.disconnect('audio-input', 'audio-out', 'sequencer', 'audio-in');
  assert.match(view.markup(), /seq-route-warning">! Input selected, Patch Bay cable missing/,
    'manual cable removal is reported immediately instead of leaving a false routed state');

  hub.sequencer.setTrack(track.id, { inputId: '' });
  hub.network.connect('audio-input', 'audio-out', 'sequencer', 'audio-in');
  assert.match(view.markup(), /seq-route-warning">! Input cable present, source not selected/,
    'a manual Patch Bay cable remains primary and asks only for track assignment');
  hub.sequencer.setTrack(track.id, { inputId: 'audio-input' });
  assert.equal(hub.network.connectionsTo('sequencer', 'audio-in').length, 1,
    'assigning an already-cabled source never creates a parallel route');
  assert.match(view.markup(), /seq-route-ok">✓ Input cable connected/);

  hub.sequencer.setTrack(track.id, { outputId: vst.id });
  const inputSelects = [...view.markup().matchAll(/<select data-track-control="input"[^>]*>([\s\S]*?)<\/select>/g)];
  assert.ok(inputSelects.length > 0);
  assert.equal(inputSelects.some((match) => match[1].includes(`value="${vst.id}"`)), false,
    'a downstream audio destination is filtered from every source selector');
  const feedbackTrack = hub.sequencer.model.addTrack('audio');
  hub.sequencer.setTrack(feedbackTrack.id, { inputId: vst.id });
  assert.equal(hub.network.connectionsTo('sequencer', 'audio-in')
    .some((cable) => cable.from.nodeId === vst.id), false,
  'controller rejects the same feedback route even if requested outside the selector');
});

test('MIDI destinations include VST and Arpeggiator but never MiniLab hardware', async () => {
  const { hub } = await runtime();
  hub.modules.register(createMiniLabModule(hub));
  hub.nodes.create('sequencer');
  hub.nodes.create('vst');
  hub.nodes.create('arpeggiator');
  hub.sequencer.model.addTrack('midi');
  hub.modules.register(createSequencerModule(hub));
  const view = captureContainer();
  hub.modules.activate('sequencer', view.container);

  const destination = /<select data-track-control="output"[^>]*>([\s\S]*?)<\/select>/.exec(view.markup())?.[1] || '';
  assert.match(destination, /VST 1 — VST chain/);
  assert.match(destination, /Arpeggiator 1 — Arpeggiator/);
  assert.doesNotMatch(destination, /MiniLab|hardware MIDI output|minilab-3/);
});

test('MIDI clips remain visible in the timeline without rendering a Piano Roll panel', async () => {
  const { api, hub } = await runtime();
  hub.nodes.create('sequencer');
  const track = hub.sequencer.model.addTrack('midi');
  hub.sequencer.model.addMidiClip(track.id, 0, 4, [
    { pitch: 60, startPpq: 0.25, durationPpq: 1, velocity: 96, channel: 2 }
  ]);
  hub.modules.register(createSequencerModule(hub));
  const view = captureContainer();
  hub.modules.activate('sequencer', view.container);

  assert.match(view.markup(), /seq-midi-preview/);
  assert.doesNotMatch(view.markup(), /Piano Roll|piano-(?:scroll|keyboard|grid|note)|data-note-control|data-clip-editor/);
  assert.equal(view.clips().length, 1);
  const firstClipElement = view.clips()[0];
  const syncsBeforeSelection = api.sent.filter((message) => message.type === 'syncSequencer').length;
  fire(firstClipElement, 'click');
  await flush();
  assert.equal(api.sent.filter((message) => message.type === 'syncSequencer').length, syncsBeforeSelection,
    'selection is UI state and never rebuilds or panics the active native plan');
  assert.equal(view.clips()[0], firstClipElement, 'selection does not replace the clicked DOM node before a possible second click');
  assert.equal(firstClipElement.classList.contains('selected'), true);
  fire(view.clips()[0], 'dblclick');
  await flush();
  assert.deepEqual(api.sent.filter((message) => message.type === 'clipEditorOpen'), [{
    type: 'clipEditorOpen', clipId: track.clips[0].id
  }], 'double-click opens the dedicated window by stable clip ID');
});

test('sub-threshold and cancelled arrangement drags cannot leave uncommitted canonical mutations', async () => {
  const { api, hub } = await runtime();
  hub.nodes.create('sequencer');
  const track = hub.sequencer.model.addTrack('midi');
  const clip = hub.sequencer.model.addMidiClip(track.id, 0, 4);
  clip.startPpq = 0.3;
  clip.lengthPpq = 3.3;
  hub.modules.register(createSequencerModule(hub));
  const view = captureContainer();
  hub.modules.activate('sequencer', view.container);
  const syncsBefore = api.sent.filter((message) => message.type === 'syncSequencer').length;

  fire(view.clips()[0], 'pointerdown', { clientX: 0 });
  fire(document, 'pointermove', { clientX: 1 });
  fire(document, 'pointerup', { clientX: 1 });
  assert.deepEqual([clip.startPpq, clip.lengthPpq], [0.3, 3.3],
    'one pixel does not snap an off-grid loaded clip behind the DOM/settings/native state');

  fire(view.clips()[0], 'pointerdown', { clientX: 0 });
  fire(document, 'pointermove', { clientX: 20 });
  assert.notEqual(clip.startPpq, 0.3, 'a real drag previews a canonical move');
  assert.equal(view.clips()[0].style.left, `${clip.startPpq * hub.sequencer.model.state.zoom}px`,
    'the visible clip follows the snapped canonical preview before pointer-up');
  fire(document, 'pointercancel', { clientX: 20 });
  assert.deepEqual([clip.startPpq, clip.lengthPpq], [0.3, 3.3], 'pointer cancellation restores the exact off-grid source state');
  await flush();
  assert.equal(api.sent.filter((message) => message.type === 'syncSequencer').length, syncsBefore,
    'neither gesture publishes a native arrangement rebuild');

  fire(view.clips()[0], 'pointerdown', { clientX: 0 });
  fire(document, 'pointermove', { clientX: 20 });
  fire(document, 'pointerup', { clientX: 20 });
  await flush();
  const expectedStart = Math.round((0.3 + 20 / hub.sequencer.model.state.zoom) / 0.25) * 0.25;
  assert.equal(clip.startPpq, expectedStart);
  assert.equal(api.sent.filter((message) => message.type === 'syncSequencer').length, syncsBefore + 1,
    'a completed real drag publishes exactly one canonical arrangement update');
});

test('Sequencer Start/End buttons use the shared seek transport and authoritative arrangement end', async () => {
  const { api, hub } = await runtime();
  hub.nodes.create('sequencer');
  const track = hub.sequencer.model.addTrack('midi');
  hub.sequencer.model.addMidiClip(track.id, 6, 3);
  hub.modules.register(createSequencerModule(hub));
  const view = captureContainer();
  hub.modules.activate('sequencer', view.container);

  assert.match(view.markup(), /data-action="go-start" title="Go to Start" aria-label="Go to Start"/);
  assert.match(view.markup(), /data-action="go-end" title="Go to End" aria-label="Go to End"/);
  fire(view.action('go-start'), 'click');
  fire(view.action('go-end'), 'click');
  await flush();
  const seeks = api.sent.filter((message) => message.type === 'setTransport' && Object.hasOwn(message, 'seekPpq'));
  assert.deepEqual(seeks.map((message) => message.seekPpq), [0, 9]);
});

test('Sequencer and header controls share one global Play/Stop transport state', async () => {
  const { api, hub } = await runtime({ transportBpm: 127 });
  hub.nodes.create('sequencer');
  hub.modules.register(createSequencerModule(hub));
  const view = captureContainer();
  const ids = new Map([
    ['project-identity', makeEl('span')], ['project-save', makeEl('button')],
    ['project-save-as', makeEl('button')], ['transport-play', makeEl('button')],
    ['transport-stop', makeEl('button')], ['transport-bpm', makeEl('input')]
  ]);
  const previousGetElementById = document.getElementById;
  document.getElementById = (id) => ids.get(id) || null;
  try {
    buildHeader(hub, makeEl('span'));
    hub.modules.activate('sequencer', view.container);

    assert.equal(ids.get('transport-bpm').value, '127');
    assert.equal(view.control('tempo').value, '127');
    ids.get('transport-bpm').value = '142';
    fire(ids.get('transport-bpm'), 'change');
    assert.equal(view.control('tempo').value, '142', 'global tempo updates Sequencer immediately');
    view.control('tempo').value = '98';
    fire(view.control('tempo'), 'change');
    assert.equal(ids.get('transport-bpm').value, '98', 'Sequencer tempo updates global immediately');
    hub.events.emit('engine:transport', { bpm: 111, playing: false, recording: false, ppqPosition: 0 });
    assert.equal(ids.get('transport-bpm').value, '111');
    assert.equal(view.control('tempo').value, '111', 'native authoritative tempo updates both views');

    fire(view.action('play'), 'click');
    assert.equal(ids.get('transport-play').classList.contains('playing'), true);
    assert.equal(view.action('play').classList.contains('active'), true);
    assert.equal(api.sent.filter((message) => message.type === 'setTransport').at(-1).playing, true);

    fire(view.action('stop'), 'click');
    assert.equal(ids.get('transport-play').classList.contains('playing'), false);
    assert.equal(api.sent.filter((message) => message.type === 'setTransport').at(-1).playing, false);

    fire(ids.get('transport-play'), 'click');
    assert.equal(view.action('play').classList.contains('active'), true);
    hub.events.emit('engine:transport', { playing: true, ppqPosition: 6.5 });
    assert.equal(hub.sequencer.playheadPpq, 6.5);
    assert.equal(hub.sequencer.model.state.loop.enabled, false);
    assert.equal(hub.settings.get('transportBpm'), 111);
  } finally {
    document.getElementById = previousGetElementById;
  }
});

test('MIDI source selector exposes only the WebMIDI input feeding MiniLab routing', async () => {
  const { hub } = await runtime();
  hub.nodes.create('sequencer');
  hub.midi.inputs.set('selected-midi', { id: 'selected-midi', name: 'MiniLab 3 MIDI', type: 'input' });
  hub.midi.inputs.set('other-midi', { id: 'other-midi', name: 'Other Controller', type: 'input' });
  hub.midi.selectedInputId = 'selected-midi';
  const track = hub.sequencer.model.addTrack('midi');
  hub.sequencer.model.updateTrack(track.id, { inputId: 'selected-midi', armed: true });
  hub.network.addNode({ id: 'rogue-midi', type: 'arpeggiator', inputs: [], outputs: [{ id: 'midi-out', type: 'midi' }] });
  hub.network.connect('rogue-midi', 'midi-out', 'sequencer', 'midi-in');
  hub.modules.register(createSequencerModule(hub));
  const view = captureContainer();
  hub.modules.activate('sequencer', view.container);

  const input = /<select data-track-control="input"[^>]*>([\s\S]*?)<\/select>/.exec(view.markup())?.[1] || '';
  assert.match(input, /value="selected-midi" selected>MiniLab 3 MIDI<\/option>/);
  assert.doesNotMatch(input, /other-midi|Other Controller/,
    'enumerated ports that do not feed minilab-3 are not offered as parallel recording sources');
  assert.match(view.markup(), /seq-route-warning">! Input selected, Patch Bay cable missing/,
    'a non-MiniLab MIDI cable cannot present itself as physical recording ingress');
  assert.equal(hub.sequencer.startRecording(), false);
});

test('legacy physical-input selection migrates without inventing a cable', async () => {
  const { api, hub } = await runtime({
    sequencerState: {
      tracks: [{ id: 'track-audio', type: 'audio', name: 'Audio 1', inputId: 'device-input', clips: [] }]
    },
    networkConnections: []
  });
  const track = hub.sequencer.model.state.tracks[0];
  assert.equal(track.inputId, 'audio-input');
  assert.equal(api.data.sequencerState.tracks[0].inputId, 'audio-input');
  assert.deepEqual(hub.network.connections(), [], 'migration changes selection metadata only');
});

test('the explicit Patch Bay Sequencer node opens the fixed Sequencer page', async () => {
  const { hub } = await runtime({ networkViewport: { x: 0, y: 0, zoom: 1 } });
  hub.modules.register(createSequencerModule(hub));
  const sequencer = hub.nodes.create('sequencer');
  const view = routingContainer();
  const routing = createRoutingModule(hub);
  routing.mount(view.container);
  const { candidate, nodes } = networkNodeElement(view.svg, sequencer.id);
  assert.ok(candidate, 'the explicit Sequencer is visible in Patch Bay');

  const activations = [];
  hub.modules.activate = (id, container) => { activations.push([id, container]); return true; };
  fire(nodes, 'dblclick', { target: candidate });
  assert.deepEqual(activations, [['sequencer', view.container]],
    'double-clicking the network node opens the existing fixed page');
  routing.unmount();
});
