import fs from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createHub } from '../src/renderer/js/core/hub.js';
import { createMiniLabModule } from '../src/renderer/js/modules/minilab/minilabModule.js';
import { createSequencerModule } from '../src/renderer/js/modules/sequencer/sequencerModule.js';
import { defaultSequencerState } from '../src/renderer/js/core/sequencerModel.js';
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
  // An empty track list, declared. A project with no authored sequencer state
  // opens on one MIDI track (see sequencer.test.mjs); every case here builds
  // the tracks it needs.
  const api = mockApi({ sequencerState: defaultSequencerState(), ...initialSettings });
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
  const track = hub.sequencer.model.setTrackArmed(hub.sequencer.model.addTrack('midi').id, true);
  assert.equal(hub.sequencer.model.state.focusedTrackId, track.id, 'arming focuses the track it arms');
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
  assert.match(view.markup(), /data-track-inspector/);
  assert.doesNotMatch(view.markup(), /<div class="seq-track-head"[^>]*>[\s\S]*?<select/,
    'a 64px track head carries no select: Input and Destination live in the inspector');
  assert.match(view.markup(), /seq-route-dots/,
    'the route stays reportable on the track itself, as two dots');
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
  const inputSelects = [...view.markup().matchAll(/<select data-inspector-control="input"[^>]*>([\s\S]*?)<\/select>/g)];
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

  const destination = /<select data-inspector-control="output"[^>]*>([\s\S]*?)<\/select>/.exec(view.markup())?.[1] || '';
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
    ['project-identity', makeEl('span')], ['transport-play', makeEl('button')],
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

  const input = /<select data-inspector-control="input"[^>]*>([\s\S]*?)<\/select>/.exec(view.markup())?.[1] || '';
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

test('the timeline carries the view with the playhead instead of pinning the opening bars', async () => {
  const { followScrollPpq } = await import('../src/renderer/js/modules/sequencer/sequencerModule.js');
  const viewport = 40;

  assert.equal(followScrollPpq(20, 0, viewport), null, 'a cursor mid-screen moves nothing');
  assert.equal(followScrollPpq(5, 0, viewport), null, 'nor does one still inside the left margin');

  // Recording past the right edge: the view follows and leaves the bars ahead
  // of the cursor visible, which is the half that is about to be played.
  const ahead = followScrollPpq(60, 0, viewport);
  assert.ok(ahead > 0, 'a cursor past the right edge pulls the view');
  assert.ok(60 >= ahead && 60 <= ahead + viewport, 'and lands the playhead on screen');
  assert.ok(ahead + viewport - 60 > 60 - ahead, 'with more room ahead of it than behind');

  // A seek backwards out of view is the same rule, not a second behaviour.
  assert.ok(followScrollPpq(4, 100, viewport) < 4, 'a backward jump also brings the cursor back');
  assert.equal(followScrollPpq(0, 100, viewport), 0, 'and the start of the timeline never scrolls negative');

  assert.equal(followScrollPpq(10, 0, 0), null, 'an unmeasured viewport is left alone');
  assert.equal(followScrollPpq(Number.NaN, 0, viewport), null);
});

test('Fit and Focus are two named framings, and the ruler stays readable at the bottom of the range', async () => {
  const { frameSpan, rulerStride, sliderToZoom, zoomToSlider } =
    await import('../src/renderer/js/modules/sequencer/sequencerModule.js');

  // Fit a four-minute arrangement -- 480 quarters at 120 BPM -- into 1240 px
  // of timeline. The old floor of 24 px per quarter could show twelve bars.
  const fit = frameSpan({ startPpq: 0, endPpq: 480 }, 1240);
  assert.ok(fit.zoom < 24, 'the floor had to come down for Fit to mean anything');
  assert.ok(480 * fit.zoom <= 1240, 'and the whole arrangement fits the width it was given');
  assert.equal(fit.scrollPpq, 0, 'bar one stays at bar one');

  const focus = frameSpan({ startPpq: 64, endPpq: 80 }, 1240);
  assert.ok(focus.zoom > fit.zoom, 'Focus on sixteen quarters is closer than Fit on 480');
  assert.ok(focus.scrollPpq < 64 && focus.scrollPpq > 60,
    'the framed span keeps a sliver of air before it, so it does not touch the edge');

  assert.equal(frameSpan({ startPpq: 0, endPpq: 0 }, 1240), null, 'an empty span frames nothing');
  assert.equal(frameSpan({ startPpq: 0, endPpq: 16 }, 0), null, 'nor does an unmeasured viewport');
  assert.equal(frameSpan({ startPpq: 0, endPpq: 1 }, 100000).zoom, 240, 'and the ceiling holds');

  // A mark per bar is a grey smear at the bottom of the range.
  assert.equal(rulerStride(120, 72), 1, 'one mark per bar while a bar is wide');
  assert.ok(rulerStride(2000, 4) >= 4, 'a coarser stride once a bar is sixteen pixels');
  for (const zoom of [1, 4, 7, 12, 30, 72, 240]) {
    const stride = rulerStride(2000, zoom);
    assert.equal(Number.isInteger(Math.log2(stride)), true, `stride ${stride} is a power of two, never 3 bars`);
    assert.ok(stride * 4 * zoom >= 50, `marks stay at least 50px apart at zoom ${zoom}`);
  }
  assert.ok(Math.ceil(20000 / rulerStride(20000, 240)) <= 512, 'a very long arrangement stays bounded');

  // A grid line per quarter is a solid tint at the bottom of the range: the
  // stylesheet leaves nothing transparent between two 1px rules.
  const { gridPx } = await import('../src/renderer/js/modules/sequencer/sequencerModule.js');
  assert.equal(gridPx(72), 72, 'a wide quarter is drawn as a quarter');
  for (const zoom of [1, 2, 4, 8, 12, 72, 240]) {
    const spacing = gridPx(zoom);
    assert.ok(spacing >= 12, `grid lines stay ${spacing}px apart at zoom ${zoom}`);
    assert.equal(Number.isInteger(Math.log2(spacing / zoom)), true,
      'and the spacing stays a musical multiple of the quarter');
  }

  // The slider is logarithmic: linear over a sixty-fold range wastes most of it.
  // A hundred integer steps over a 240-fold range is ~5.6% per step, so the
  // round trip lands near where it started rather than exactly on it.
  assert.ok(Math.abs(sliderToZoom(zoomToSlider(72)) - 72) / 72 < 0.06);
  assert.equal(sliderToZoom(0), 1);
  assert.equal(sliderToZoom(100), 240);
  assert.ok(sliderToZoom(50) > 10 && sliderToZoom(50) < 20, 'mid-travel is the geometric middle');
  assert.ok(sliderToZoom(60) - sliderToZoom(50) > sliderToZoom(10) - sliderToZoom(0),
    'a constant ratio per pixel, not a constant number of pixels');
});

test('the arrangement answers the keyboard: select all, nudge, cut and paste', async () => {
  const { hub } = await runtime();
  hub.nodes.create('sequencer');
  const first = hub.sequencer.model.addTrack('midi');
  const second = hub.sequencer.model.addTrack('midi');
  const clip = hub.sequencer.model.addMidiClip(first.id, 4, 4);
  hub.sequencer.model.addMidiClip(first.id, 12, 4);
  hub.modules.register(createSequencerModule(hub));
  const view = captureContainer();
  hub.modules.activate('sequencer', view.container);

  assert.equal(hub.sequencer.selectAllClips(), 2, 'Ctrl+A reaches every clip in the arrangement');

  hub.sequencer.selectClip(clip.id);
  const step = 0.25;
  assert.equal(hub.sequencer.moveClips([clip.id], step, null, { anchorClipId: clip.id }), true);
  assert.equal(hub.sequencer.model._clip(clip.id).clip.startPpq, 4 + step,
    'one arrow is one snap step, which is the accuracy the mouse cannot give');

  assert.equal(hub.sequencer.moveClips([clip.id], 0, second.id, { anchorClipId: clip.id }), true);
  assert.equal(hub.sequencer.model._clip(clip.id).track.id, second.id, 'and one arrow down is one track');

  assert.equal(hub.sequencer.cutSelectedClips(), 1, 'cut removes what it copied');
  assert.equal(hub.sequencer.model._clip(clip.id), null);
  assert.equal(hub.sequencer.pasteClips(0).length, 1, 'and the clipboard still holds it');
});

test('a rubber band over the lanes selects in musical coordinates, and a click still clears', async () => {
  const { clipsInSpan } = await import('../src/renderer/js/modules/sequencer/sequencerModule.js');
  const tracks = [
    { clips: [{ id: 'a', startPpq: 0, lengthPpq: 4 }, { id: 'b', startPpq: 8, lengthPpq: 4 }] },
    { clips: [{ id: 'c', startPpq: 2, lengthPpq: 4 }] },
    { clips: [{ id: 'd', startPpq: 0, lengthPpq: 16 }] }
  ];

  assert.deepEqual(clipsInSpan(tracks, { startPpq: 1, endPpq: 3, fromTrack: 0, toTrack: 1 }), ['a', 'c'],
    'a band takes what it overlaps, on the tracks it spans');
  assert.deepEqual(clipsInSpan(tracks, { startPpq: 5, endPpq: 7, fromTrack: 0, toTrack: 0 }), [],
    'a band in the gap between two clips takes neither');
  assert.deepEqual(clipsInSpan(tracks, { startPpq: 3, endPpq: 5, fromTrack: 0, toTrack: 0 }), ['a'],
    'and touching one quarter of a clip is enough to take it');
  assert.deepEqual(clipsInSpan(tracks, { startPpq: 20, endPpq: 1, fromTrack: 2, toTrack: 0 }).sort(),
    ['a', 'b', 'c', 'd'], 'the band is drawn in any direction');
  assert.deepEqual(clipsInSpan(tracks, { startPpq: 4, endPpq: 4, fromTrack: 0, toTrack: 2 }), ['c', 'd'],
    'a band of zero width still covers what it passes through: the three-pixel '
    + 'threshold is what keeps a plain click meaning "clear the selection", not this geometry');
  assert.deepEqual(clipsInSpan(tracks, { startPpq: 0, endPpq: 99, fromTrack: 5, toTrack: 9 }), [],
    'and a band below the last track finds nothing rather than throwing');
  assert.deepEqual(clipsInSpan(undefined, {}), []);
});

test('a clip draws its notes in pixels, so resizing it cannot stretch them', async () => {
  const source = fs.readFileSync(
    new URL('../src/renderer/js/modules/sequencer/sequencerModule.js', import.meta.url), 'utf8'
  );
  const content = /function clipContent\([\s\S]*?\n}/.exec(source)?.[0] || '';
  assert.ok(content, 'the clip body is one function, shared by the markup and the drag preview');

  // The defect was percentages: `renderDragPreview` rewrites the element's
  // width during a resize, every percentage re-resolves against the new width,
  // and the notes stretched like rubber while nothing had actually moved.
  assert.doesNotMatch(content, /seq-left-pct|seq-width-pct/,
    'a note mark is placed in pixels from the clip start, never in percent of its width');
  assert.match(content, /data-seq-left="\$\{\(visibleStart - sourceOffset\) \* zoom\}"/);
  assert.match(content, /data-seq-bottom-pct=/, 'pitch stays a percentage: a resize does not change the height');
  assert.match(source, /if \(drag\.kind !== 'resize-clip'\) continue;[\s\S]*?clipContent\(/,
    'and a resize rebuilds them, because it moves which part of the source is shown');
});

test('the scroll rail draws and reads one mapping, and hides when everything fits', async () => {
  const { railThumb } = await import('../src/renderer/js/modules/sequencer/sequencerModule.js');

  assert.equal(railThumb({ scrollLeft: 0, scrollWidth: 800, clientWidth: 800, railWidth: 800 }), null,
    'nothing to scroll, no rail: a full-width thumb that cannot move is furniture');
  assert.equal(railThumb({ scrollWidth: 4000, clientWidth: 1000, railWidth: 0 }), null,
    'and an unmeasured rail draws nothing rather than dividing by it');

  const dimensions = { scrollWidth: 4000, clientWidth: 1000, railWidth: 1000 };
  const start = railThumb({ ...dimensions, scrollLeft: 0 });
  assert.equal(start.left, 3, 'at the left edge the thumb sits on the inset');
  assert.ok(Math.abs(start.size - 994 * 0.25) < 1, 'the thumb is as wide a fraction as the window is');

  const end = railThumb({ ...dimensions, scrollLeft: 3000 });
  assert.ok(Math.abs(end.left + end.size - (1000 - 3)) < 1, 'and reaches the far edge at full scroll');
  assert.equal(railThumb({ ...dimensions, scrollLeft: 99999 }).left, end.left, 'past the end clamps');

  // Draw, then read back: the two directions must be inverses, or the thumb
  // jumps out from under the pointer that grabbed it.
  for (const scrollLeft of [0, 250, 1500, 3000]) {
    const thumb = railThumb({ ...dimensions, scrollLeft });
    const centre = thumb.left + thumb.size / 2;
    assert.ok(Math.abs(thumb.scrollFor(centre) - scrollLeft) < 1,
      `grabbing the thumb at ${scrollLeft} asks for ${scrollLeft}`);
  }
  const thumb = railThumb({ ...dimensions, scrollLeft: 0 });
  assert.equal(thumb.scrollFor(-500), 0, 'dragging past either end clamps rather than overscrolling');
  assert.equal(thumb.scrollFor(99999), 3000);
});

test('the arrangement replaces the native horizontal scrollbar rather than keeping it', () => {
  const css = fs.readFileSync(new URL('../src/renderer/styles/base.css', import.meta.url), 'utf8');
  assert.match(css, /\.seq-scroll::-webkit-scrollbar:horizontal \{ height:0; \}/,
    'the light slab under the arrangement is gone');
  assert.match(css, /\.seq-rail \{/, 'and a four-pixel rail says the same thing in its place');
  assert.match(css, /body ::-webkit-scrollbar \{/,
    'the shell dresses its remaining scrollbars instead of leaving them white');
  const faceplate = fs.readFileSync(new URL('../src/renderer/styles/omni-pearl.css', import.meta.url), 'utf8');
  assert.match(faceplate, /\.omni-pearl ::-webkit-scrollbar \{/,
    'the faceplate declares its own in its own sheet, and `body ` scoping is what lets it win (D-012)');
  assert.doesNotMatch(css, /^::-webkit-scrollbar/m,
    'nothing here is declared unscoped, which would beat nothing but reach everything');
});
