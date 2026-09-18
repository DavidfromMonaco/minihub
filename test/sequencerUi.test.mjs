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
  // The scrolling element, REBUILT on every render exactly as the browser
  // rebuilds it: `container.innerHTML = ...` throws the old one away, and a
  // new one starts at scroll zero. A stub that survived would hide the very
  // thing this models -- that putting the scroll back is the module's job.
  let scroller = null;
  // The horizontal rail under the arrangement, and its thumb.
  let rail = null;
  let railThumbEl = null;
  // The clock ruler is the one row redrawn on its own, when the tempo moves.
  let timeRuler = null;
  container.clientWidth = 1200;
  Object.defineProperty(container, 'innerHTML', {
    get: () => markup,
    set: (value) => {
      markup = String(value);
      actions.clear();
      controls.clear();
      clips.length = 0;
      metronomeLight = null;
      timeRuler = makeEl('div');
      timeRuler.dataset.seqTimeScale = '';
      // The shim's own `innerHTML` is a sink that reads back empty. This row
      // is redrawn on its own when the tempo moves, so the test has to read
      // what that redraw wrote -- and to hand back the marks it wrote, or the
      // repaint's own `querySelectorAll` finds nothing to re-bind and the
      // event bus swallows the failure (it catches every handler).
      let rowMarkup = '';
      let rowMarks = [];
      Object.defineProperty(timeRuler, 'innerHTML', {
        get: () => rowMarkup,
        set: (value) => {
          rowMarkup = String(value);
          timeRuler.children.length = 0;
          rowMarks = [...rowMarkup.matchAll(/data-seek="([^"]+)"/g)].map(([, seek]) => {
            const mark = makeEl('button');
            mark.dataset.seek = seek;
            return mark;
          });
        },
        configurable: true
      });
      timeRuler.querySelectorAll = (selector) => (selector === '[data-seek]' ? rowMarks : []);
      timeRuler.marks = () => rowMarks;
      scroller = makeEl('div');
      scroller.dataset.timelineScroll = '';
      scroller.scrollTop = 0;
      scroller.scrollLeft = 0;
      scroller.clientHeight = 600;
      scroller.clientWidth = 940;
      // An arrangement wider than its window, or there is nothing to scroll and
      // the rail hides itself -- which is the state every test here ran in.
      scroller.scrollWidth = 6000;
      // Rebuilt with everything else, for the same reason the scroller is: a
      // drag holds these elements, and `render()` throws them away.
      rail = makeEl('div');
      rail.dataset.seqRail = '';
      rail.clientWidth = 940;
      railThumbEl = makeEl('div');
      railThumbEl.dataset.seqRailThumb = '';
      for (const action of ['open-routing', 'go-start', 'go-end', 'play', 'start-record', 'stop',
        'toggle-metronome', 'add-midi', 'add-audio']) {
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
    if (selector === '[data-timeline-scroll]') return scroller;
    if (selector === '[data-seq-rail]') return rail;
    if (selector === '[data-seq-rail-thumb]') return railThumbEl;
    if (selector === '[data-seq-time-scale]') return timeRuler;
    return null;
  };
  container.querySelectorAll = (selector) => selector === '.seq-clip' ? clips : [];
  return {
    container, markup: () => markup, action: (name) => actions.get(name),
    control: (name) => controls.get(name), light: () => metronomeLight, clips: () => clips,
    scroller: () => scroller, timeRuler: () => timeRuler, rail: () => rail
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
  assert.match(view.markup(), /<span>Destination<\/span><select[^>]*>[\s\S]*VST 1 — no plugin[\s\S]*VST 2 — no plugin/);
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
  assert.match(destination, /VST 1 — no plugin/);
  assert.match(destination, /Arpeggiator 1 — Arpeggiator/);
  assert.doesNotMatch(destination, /MiniLab|hardware MIDI output|minilab-3/);
});

test('a VST destination is named by the plugins it plays, and stands out once chosen', async () => {
  const { hub } = await runtime();
  hub.nodes.create('sequencer');
  const splice = hub.nodes.create('vst');
  const layered = hub.nodes.create('vst');
  hub.nodes.create('vst');
  hub.nodes.getChain(splice.id).append({ pluginId: 'C:/VST3/Splice INSTRUMENT.vst3', name: 'Splice INSTRUMENT', role: 'instrument' });
  const chain = hub.nodes.getChain(layered.id);
  chain.append({ pluginId: 'C:/VST3/Vital.vst3', name: 'Vital', role: 'instrument' });
  chain.append({ pluginId: 'C:/VST3/ValhallaSupermassive.vst3', name: 'ValhallaSupermassive', role: 'audio-effect' });
  const track = hub.sequencer.model.addTrack('midi');
  hub.modules.register(createSequencerModule(hub));
  const view = captureContainer();
  hub.modules.activate('sequencer', view.container);

  const destination = () => /<select data-inspector-control="output"([^>]*)>([\s\S]*?)<\/select>/.exec(view.markup());
  assert.match(destination()[2], />VST 1 — Splice INSTRUMENT</, 'every node used to read "VST chain"');
  assert.match(destination()[2], />VST 2 — Vital \+ ValhallaSupermassive</, 'a chain names its plugins in order');
  assert.match(destination()[2], />VST 3 — no plugin</);
  assert.match(view.markup(), /class="seq-inspector-field seq-inspector-destination"><span>Destination<\/span>/);
  assert.doesNotMatch(destination()[1], /routed/, 'a placeholder is not dressed as a destination');

  hub.sequencer.setTrack(track.id, { outputId: splice.id });
  assert.match(destination()[1], /class="routed"/, 'the chosen destination is the one dressed to stand out');
});

test('a button on each track selects it, and selecting a track arms nothing', async () => {
  const { hub } = await runtime();
  hub.nodes.create('sequencer');
  const first = hub.sequencer.model.addTrack('midi');
  const second = hub.sequencer.model.addTrack('midi');
  hub.sequencer.setTrackArmed(first.id, true);
  hub.modules.register(createSequencerModule(hub));
  const view = captureContainer();
  // The shared capture binds no track; these stand for the rendered rows, each
  // with the one control this case clicks.
  const buttons = new Map();
  view.container.querySelectorAll = (selector) => selector !== '.seq-track' ? [] : [
    ...view.markup().matchAll(/<div class="seq-track[^"]*" data-track-id="([^"]+)"/g)
  ].map(([, trackId]) => {
    const row = makeEl('div');
    row.dataset.trackId = trackId;
    const button = makeEl('button');
    row.querySelector = (inner) => inner === '[data-track-action="select"]' ? button : null;
    buttons.set(trackId, button);
    return row;
  });
  hub.modules.activate('sequencer', view.container);

  assert.deepEqual(
    [...view.markup().matchAll(/<button class="seq-track-select" data-track-action="select"[^>]*aria-pressed="(true|false)"/g)].map((match) => match[1]),
    ['true', 'false'],
    'one button per track, pressed on the selected one');

  const click = fire(buttons.get(second.id), 'click');
  assert.equal(click.propagationStopped, true, 'the row under the button does not select a second time');
  assert.equal(hub.sequencer.model.state.focusedTrackId, second.id);
  assert.deepEqual(hub.sequencer.model.state.tracks.map((track) => track.armed), [true, false],
    'the armed track stays armed, and the selected one is not armed');
  assert.match(view.markup(), /aria-label="Select MIDI 2" aria-pressed="true"/, 'the page redraws the selection');
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
    assert.equal(api.sent.filter((message) => message.type === 'setTransport').at(-1).stopOneRings, true,
      'a Stop pressed stops the One Ring nodes too');

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

/**
 * The transport bar is in the shell because that is where it is needed: inside
 * a One Ring node, a plugin's page or the Patch Bay, the arrangement is not on
 * screen and there is no other way to move the playhead or to know where it is.
 */
test('the shell transport seeks by bars, says where it is, and pauses without stopping a One Ring', async () => {
  const { api, hub } = await runtime();
  hub.nodes.create('sequencer');
  const track = hub.sequencer.model.addTrack('midi');
  hub.sequencer.model.addMidiClip(track.id, 8, 4, []);
  const ids = new Map([
    ['project-identity', makeEl('span')], ['transport-play', makeEl('button')],
    ['transport-stop', makeEl('button')], ['transport-bpm', makeEl('input')],
    ['transport-start', makeEl('button')], ['transport-back', makeEl('button')],
    ['transport-forward', makeEl('button')], ['transport-end', makeEl('button')],
    ['transport-position', makeEl('output')]
  ]);
  const previousGetElementById = document.getElementById;
  document.getElementById = (id) => ids.get(id) || null;
  const seeks = () => api.sent
    .filter((message) => message.type === 'setTransport' && Object.hasOwn(message, 'seekPpq'))
    .map((message) => message.seekPpq);
  try {
    buildHeader(hub, makeEl('span'));

    // Where am I: the readout is the only answer once the timeline is off
    // screen, and it opens on whatever the transport already holds.
    assert.equal(ids.get('transport-position').textContent, '1.1');
    hub.events.emit('engine:transport', { playing: true, ppqPosition: 10 });
    assert.equal(ids.get('transport-position').textContent, '3.3');
    assert.equal(ids.get('transport-position').classList.contains('playing'), true);

    // Back from the middle of bar three lands on bar three, then bar two.
    fire(ids.get('transport-back'), 'click');
    fire(ids.get('transport-back'), 'click');
    fire(ids.get('transport-forward'), 'click');
    assert.deepEqual(seeks(), [8, 4, 8], 'a bar at a time, from where the playhead is');
    assert.equal(ids.get('transport-position').textContent, '3.1',
      'and the readout follows a seek, without waiting for the engine');

    fire(ids.get('transport-end'), 'click');
    assert.equal(seeks().at(-1), 12, 'the end is the end of the last clip');
    fire(ids.get('transport-start'), 'click');
    assert.equal(seeks().at(-1), 0);
    assert.equal(ids.get('transport-position').textContent, '1.1');

    // Play doubles as Pause, and the two are not the same command.
    assert.equal(ids.get('transport-play').textContent, 'Pause',
      'the button says what pressing it does, and the transport is playing');
    fire(ids.get('transport-play'), 'click');
    const paused = api.sent.filter((message) => message.type === 'setTransport').at(-1);
    assert.equal(paused.playing, false);
    assert.equal(Object.hasOwn(paused, 'stopOneRings'), false,
      'a pause holds the arrangement and leaves a One Ring on its own clock running');

    hub.events.emit('engine:transport', { playing: false, ppqPosition: 0 });
    assert.equal(ids.get('transport-play').textContent, 'Play');
    fire(ids.get('transport-play'), 'click');
    assert.equal(api.sent.filter((message) => message.type === 'setTransport').at(-1).playing, true,
      'and pressing it again plays');
  } finally {
    document.getElementById = previousGetElementById;
  }
});

test('the header Stop stays pressable while a One Ring node plays on its own, and stops it', async () => {
  const { api, hub } = await runtime();
  const ids = new Map([
    ['project-identity', makeEl('span')], ['transport-play', makeEl('button')],
    ['transport-stop', makeEl('button')], ['transport-bpm', makeEl('input')]
  ]);
  const previousGetElementById = document.getElementById;
  document.getElementById = (id) => ids.get(id) || null;
  try {
    buildHeader(hub, makeEl('span'));
    const stop = ids.get('transport-stop');
    assert.equal(stop.disabled, true, 'nothing plays');
    const ring = hub.nodes.create('one-ring');
    hub.events.emit('engine:oneRingSynced', { nodeId: ring.id, generation: 1, created: true, ok: true, message: '' });
    const status = (playing) => hub.events.emit('engine:oneRingStatus', { nodeId: ring.id, generation: 1, playing, scene: 0 });
    status(true);
    assert.equal(stop.disabled, false, 'a One Ring on its own clock, the transport stopped, is something to stop');
    fire(stop, 'click');
    await flush();
    const sent = api.sent.filter((message) => message.type === 'setTransport').at(-1);
    assert.deepEqual([sent.playing, sent.stopOneRings], [false, true]);
    status(false);
    assert.equal(stop.disabled, true);
    status(true);
    hub.nodes.delete(ring.id);
    assert.equal(stop.disabled, true, 'a node that goes takes its playing with it');
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

/**
 * The defect this replaces: `render()` replaces the scrolling element and put
 * back only `scrollLeft`. Thirteen rows fit on a screen, so past the
 * thirteenth track every repaint -- and they come from a MIDI port appearing
 * as much as from your own edits -- threw the view back to the first tracks.
 * Then "+ MIDI Track" made a track below the fold and showed you the top.
 */
test('the arrangement stays where you scrolled it, and a new track comes to you', async () => {
  const { hub } = await runtime();
  hub.nodes.create('sequencer');
  for (let index = 0; index < 20; index += 1) hub.sequencer.model.addTrack('midi');
  hub.modules.register(createSequencerModule(hub));
  const view = captureContainer();
  hub.modules.activate('sequencer', view.container);

  // Scroll down to the rows near the bottom and let the module hear about it.
  view.scroller().scrollTop = 900;
  fire(view.scroller(), 'scroll');

  // Anything at all repaints: renaming a track, a clip moving, a port arriving.
  hub.sequencer.changed({ syncNative: false, invalidateEditors: false });
  assert.equal(view.scroller().scrollTop, 900,
    'a repaint keeps the tracks you were looking at');

  // The other half of the same defect, and the one that emptied the lanes:
  // only the clips around the current scroll are drawn, and the repaint that
  // draws the next ones is queued by this very listener. A clip at bar 101 of
  // a track is nowhere in the markup until the view goes near it.
  const far = hub.sequencer.model.state.tracks[0];
  hub.sequencer.model.addMidiClip(far.id, 400, 16, []);
  hub.sequencer.changed({ syncNative: false, invalidateEditors: false });
  assert.doesNotMatch(view.markup(), /data-clip-id/, 'nothing that far out is drawn yet');
  view.scroller().scrollLeft = 400 * hub.sequencer.model.state.zoom;
  fire(view.scroller(), 'scroll');
  await flush();
  assert.match(view.markup(), /data-clip-id/,
    'scrolling to the clip repaints the lane it lives in');

  // Back to the top by hand, then add a track: it is row 21, far below the
  // fold, and the view has to go to it.
  view.scroller().scrollTop = 0;
  fire(view.scroller(), 'scroll');
  view.action('add-midi')._listeners.click.forEach((fn) => fn({ preventDefault() {} }));
  assert.equal(hub.sequencer.model.state.tracks.length, 21, 'the track was made');
  const top = 30 + 20 * 64; // RULER_HEIGHT + index * TRACK_HEIGHT
  assert.ok(view.scroller().scrollTop > 0, 'the view followed the new track');
  assert.ok(top + 64 <= view.scroller().scrollTop + 600, 'and the whole row is on screen');
});

test('the arrangement is measured in minutes as well as bars', async () => {
  const { formatClock, secondsPerQuarter, timeStride } =
    await import('../src/renderer/js/modules/sequencer/sequencerModule.js');

  assert.equal(secondsPerQuarter(120), 0.5);
  assert.equal(secondsPerQuarter(60), 1);
  assert.equal(secondsPerQuarter(0), 0.5, 'a tempo that cannot be read falls back to 120');

  // A clock reads in ones, fives, quarter minutes and minutes. A mark every 7
  // seconds is arithmetically fine and nobody counts in sevens.
  // Whole seconds at the finest: this row says where you are in the piece,
  // and a `0:01.5` next to a bar ruler is the bar ruler's job done twice.
  const ladder = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
  for (const pxPerSecond of [0.5, 2, 6, 16, 48, 144, 480, 2000]) {
    const stride = timeStride(pxPerSecond, 600);
    assert.ok(ladder.includes(stride), `${stride}s is not a number a clock is divided into`);
    assert.ok(stride * pxPerSecond >= 62 || stride === 1 || stride === 3600,
      `marks ${(stride * pxPerSecond).toFixed(0)}px apart at ${pxPerSecond}px/s are unreadable`);
  }
  // Zoomed all the way in the visible span is seconds, not minutes, and a
  // second is as fine as this ruler gets.
  assert.equal(timeStride(2000, 20), 1);
  // Pulled far out, the ruler thins rather than emitting a mark per second.
  assert.ok(600 / timeStride(2, 600) <= 512);
  assert.ok(36000 / timeStride(480, 36000) <= 512, 'ten hours stays bounded');

  assert.equal(formatClock(0), '0:00');
  assert.equal(formatClock(62), '1:02');
  assert.equal(formatClock(125), '2:05');
  assert.equal(formatClock(3725), '1:02:05', 'past the hour the hour is written');
  // Rounded before it is split, or a 59.6 prints `:60` and an hour prints 60:00.
  assert.equal(formatClock(59.6), '1:00');
  assert.equal(formatClock(3599.6), '1:00:00');
  assert.equal(formatClock(-1), '0:00');
  assert.equal(formatClock(Number.NaN), '0:00');
});

test('the clock ruler sits above the bars, seeks like them, and follows the tempo', async () => {
  const { hub } = await runtime({ transportBpm: 120 });
  hub.nodes.create('sequencer');
  hub.modules.register(createSequencerModule(hub));
  const view = captureContainer();
  hub.modules.activate('sequencer', view.container);

  // Two rows, the clock first: it is drawn before the bar ruler and the bar
  // ruler is offset by its height, which the module publishes rather than the
  // stylesheet spelling it.
  assert.match(view.markup(), /data-seq-time-ruler="18"[^>]*data-seq-bar-ruler="30"/);
  const clockAt = view.markup().indexOf('class="seq-time-ruler"');
  const barsAt = view.markup().indexOf('class="seq-ruler"');
  assert.ok(clockAt > 0 && clockAt < barsAt, 'the clock row comes first');

  // Its marks are clickable positions, in quarters, like a bar mark.
  const marks = [...view.markup().matchAll(/<button class="seq-time-mark" data-seek="([^"]+)"[^>]*><strong>([^<]+)</g)]
    .map(([, seek, label]) => [Number(seek), label]);
  assert.ok(marks.length >= 2, 'the ruler has marks');
  assert.deepEqual(marks[0], [0, '0:00']);
  // At 120 BPM a quarter is half a second, so a mark at 0:30 is quarter 60.
  const thirty = marks.find(([, label]) => label === '0:30');
  if (thirty) assert.equal(thirty[0], 60, '0:30 at 120 BPM is quarter 60');
  // Tracks and the playhead hang below BOTH rows.
  assert.match(view.markup(), /class="seq-playhead"[^>]*data-seq-height="(\d+)"/);
  assert.ok(Number(/class="seq-playhead"[^>]*data-seq-height="(\d+)"/.exec(view.markup())[1]) >= 48,
    'the playhead spans the two rulers plus the tracks');

  // 64 bars are 64 bars at any tempo; two minutes are not. Halving the tempo
  // doubles the seconds a bar takes, so the same mark moves to a new bar.
  const before = view.timeRuler().innerHTML;
  hub.sequencer.setTempo(60);
  const after = view.timeRuler().innerHTML;
  assert.notEqual(after, before, 'a tempo change redraws the clock');
  const seekAt = (html, label) => {
    const hit = [...html.matchAll(/data-seek="([^"]+)"[^>]*><strong>([^<]+)</g)]
      .find(([, , text]) => text === label);
    return hit ? Number(hit[1]) : null;
  };
  const quarters120 = seekAt(before, '0:30');
  const quarters60 = seekAt(after, '0:30');
  if (quarters120 !== null && quarters60 !== null) {
    assert.equal(quarters60, quarters120 / 2, 'at half the tempo, 0:30 is half as many quarters');
  }

  // And the repainted marks still answer. Rebuilding a row's markup throws its
  // listeners away with the old elements, so a mark that is redrawn and not
  // re-bound is a ruler that silently stops seeking until the next full render.
  const repainted = view.timeRuler().marks();
  const target = repainted.at(-1);
  assert.ok(target, 'the repainted row has marks');
  fire(target, 'click');
  assert.equal(hub.sequencer.playheadPpq, Number(target.dataset.seek),
    'clicking a mark drawn by the tempo repaint seeks to it');
});

test('the timeline always keeps a screenful of empty bars ahead of the view', async () => {
  const { timelineEndPpq } = await import('../src/renderer/js/modules/sequencer/sequencerModule.js');
  const minimumPpq = 256; // TIMELINE_BEATS: 64 bars, what an empty project opens on

  // An untouched project: the opening horizon, not a horizon of nothing.
  assert.equal(timelineEndPpq({ minimumPpq, contentEndPpq: 4, scrollPpq: 0, viewportPpq: 40 }), 256);

  // Scrolling right used to stop at that 256 whatever you did. It must not:
  // dropping a clip at bar 200 of an empty arrangement is ordinary work.
  const far = timelineEndPpq({ minimumPpq, contentEndPpq: 4, scrollPpq: 800, viewportPpq: 40 });
  assert.ok(far >= 800 + 40, `the view at 800 must be reachable, got ${far}`);
  assert.ok(far - (800 + 40) >= 40, 'with at least a screenful still ahead of it');

  // The content still pushes it, and still with room to spare at the end.
  assert.ok(timelineEndPpq({ minimumPpq, contentEndPpq: 2000, scrollPpq: 0, viewportPpq: 40 }) > 2000,
    'a long arrangement is not cut at its last clip');

  // Whole bars, so the ruler's last mark is a bar and the width does not
  // wobble by a pixel on every scroll event.
  for (const scrollPpq of [0, 13, 101.5, 777.25]) {
    const end = timelineEndPpq({ minimumPpq, contentEndPpq: 4, scrollPpq, viewportPpq: 37.5 });
    assert.equal(end % 4, 0, `${end} is a whole number of bars`);
  }

  // Monotone in the scroll: travelling right never shortens the timeline
  // under your own view, which would snap the scroll back.
  let previous = 0;
  for (let scrollPpq = 0; scrollPpq < 4000; scrollPpq += 97) {
    const end = timelineEndPpq({ minimumPpq, contentEndPpq: 4, scrollPpq, viewportPpq: 40 });
    assert.ok(end >= previous, 'the horizon never retreats while scrolling right');
    previous = end;
  }

  assert.ok(timelineEndPpq() >= 4, 'and an unmeasured call still returns a timeline');
});

test('the lanes are repainted before the view runs off the clips that are drawn', async () => {
  const { outsideDrawnWindow } = await import('../src/renderer/js/modules/sequencer/sequencerModule.js');
  // A render at scroll 100 on a 40-quarter screen draws [60, 180].
  const drawn = { startPpq: 60, endPpq: 180, viewportPpq: 40 };

  assert.equal(outsideDrawnWindow(100, drawn), false, 'where it was drawn, nothing to do');
  assert.equal(outsideDrawnWindow(120, drawn), false, 'and a screen of slack in hand');
  assert.equal(outsideDrawnWindow(135, drawn), true, 'approaching the right edge repaints early');
  assert.equal(outsideDrawnWindow(55, drawn), true, 'and so does going back past the left one');
  assert.equal(outsideDrawnWindow(4000, drawn), true, 'a jump far out is outside, not forgotten');
  assert.equal(outsideDrawnWindow(0, {}), true, 'an unpublished window always repaints');
});

test('a track row is brought into view without dragging the arrangement around', async () => {
  const { revealScrollTop } = await import('../src/renderer/js/modules/sequencer/sequencerModule.js');
  // The arrangement's own numbers: a 30px ruler floating over 64px rows.
  const row = (index) => ({ top: 30 + index * 64, height: 64, stickyTop: 30, viewHeight: 600 });

  // What was broken: thirteen rows fit, so the twentieth is below the fold,
  // and the render that follows "+ MIDI Track" put the view back at zero.
  const twentieth = revealScrollTop({ ...row(19), scrollTop: 0 });
  assert.ok(twentieth > 0, 'a row below the fold pulls the view down');
  assert.ok(30 + 19 * 64 + 64 <= twentieth + 600, 'and the whole row lands on screen');

  // Already visible: nothing moves. A reveal that scrolls anyway drags the
  // arrangement under the hand every time a track is touched.
  assert.equal(revealScrollTop({ ...row(2), scrollTop: 0 }), 0);
  assert.equal(revealScrollTop({ ...row(19), scrollTop: twentieth }), twentieth);

  // Above the fold, the ruler does not get to cover the row it reveals.
  const back = revealScrollTop({ ...row(1), scrollTop: 900 });
  assert.ok(back <= 30 + 64 - 30, 'scrolling back up clears the sticky ruler');
  assert.ok(back >= 0, 'and never goes negative');

  assert.equal(revealScrollTop({ ...row(19), scrollTop: 40, viewHeight: 0 }), 40,
    'an unmeasured viewport is left alone');
  assert.equal(revealScrollTop(), 0);
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

test('a drag on the scroll rail survives the repaint it triggers', async () => {
  const { railThumb } = await import('../src/renderer/js/modules/sequencer/sequencerModule.js');
  const { hub } = await runtime();
  hub.nodes.create('sequencer');
  hub.sequencer.model.addTrack('midi');
  hub.modules.register(createSequencerModule(hub));
  const view = captureContainer();
  hub.modules.activate('sequencer', view.container);

  const rail = view.rail();
  const stale = view.scroller();
  assert.ok(rail && stale, 'the rail and the scroller are drawn');

  fire(rail, 'pointerdown', { button: 0, clientX: 100 });
  const grabbed = stale.scrollLeft;
  assert.ok(grabbed > 0, 'grabbing the rail scrolls to the point grabbed');

  // What the browser does next: the scroll leaves the drawn window, the module
  // repaints on the following frame, and every element the pointerdown saw is
  // replaced. The drag is still running -- its listeners are on `document`.
  fire(stale, 'scroll', {});
  await flush();
  const fresh = view.scroller();
  assert.notEqual(fresh, stale, 'the repaint replaced the scrolling element');

  fire(globalThis.document, 'pointermove', { clientX: 500 });

  // The defect: the move kept writing to the detached element, where assigning
  // scrollLeft does nothing and says nothing. The rail stopped answering after
  // about a quarter of a screen, in either direction.
  const expected = railThumb({ scrollLeft: 0, scrollWidth: 6000, clientWidth: 940, railWidth: 940 })
    .scrollFor(500);
  assert.ok(Math.abs(fresh.scrollLeft - expected) < 1,
    `the live timeline follows the thumb (${fresh.scrollLeft} vs ${expected})`);
  assert.equal(stale.scrollLeft, grabbed, 'and the element that was thrown away is left alone');

  fire(globalThis.document, 'pointerup', {});
});

test('the playhead passes under the track heads, never across them', () => {
  const css = fs.readFileSync(new URL('../src/renderer/styles/base.css', import.meta.url), 'utf8');
  // Each of these is one line of base.css, which is how the sheet is written.
  const layer = (selector) => {
    const rule = css.split('\n').find((row) => row.startsWith(`${selector} {`));
    assert.ok(rule, `${selector} has a rule of its own`);
    const declared = /z-index:([0-9]+)/.exec(rule);
    assert.ok(declared, `${selector} declares which layer it is on`);
    return Number(declared[1]);
  };
  // The heads are sticky at the left edge. The cursor used to be drawn over
  // them, so scrolling the timeline away from the playhead painted a red line
  // straight across a track's buttons and its fader.
  assert.ok(layer('.seq-playhead') < layer('.seq-track-head'),
    'the cursor passes behind the track heads');
  // And still over everything it has to cross inside the timeline.
  assert.ok(layer('.seq-playhead') > layer('.seq-ruler'));
  assert.ok(layer('.seq-playhead') > layer('.seq-time-ruler'));
  assert.ok(layer('.seq-playhead') > layer('.seq-loop-range'));
  // The corner is the heads' own header: it covers the cursor for the same
  // reason they do.
  assert.ok(layer('.seq-corner') > layer('.seq-playhead'));
});
