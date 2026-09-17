import { registerNodeEditor } from '../../core/nodeEditors.js';
import { VALUE_TYPE } from '../../core/commandRegistry.js';
import {
  CAPTURE_MODE, CHANNEL_COUNT, MAX_STEPS, SCENE_BANKS, SCENE_POSITION, SCENE_TIMING, STEP_MODE, VOICE_COUNT,
  addScene, cellAt, clearMaterial, defaultVoice, defaultWriter, loadMaterial, mutateSequence, noteListFromClip,
  oneRingTargets, parseSeed, reseed, revertMaterial, sceneIndex, scenePlace, setCaptureSettings, setFrozen, setVoice,
  setWriterSettings, storeSceneAt
} from '../../core/oneRingSequence.js';
import { syncDragKnob } from '../../ui/omniPearl.js';
import * as edits from '../../core/oneRingEdits.js';
import {
  KNOBS, TABS, TAB_REGIONS, bodyMarkup, renderPage, renderRegions, shownBank, tabOf
} from './oneRingFaceplate.js';
import { liveRulesText } from './oneRingNotes.js';

/**
 * The One Ring node's page: the faceplate of oneRingFaceplate.js, played and
 * edited.
 *
 * PLAYING IS NOT EDITING
 * ----------------------
 * RUN, STOP, a scene key and a channel's RESTART and STOP go to the node's
 * runtime (`hub.oneRing.command`) and leave the sequence alone. Everything else
 * writes the node's content through `hub.nodes.setContent`: an undo step, which
 * oneRingNodes.js sends to the engine. A knob being turned writes as it moves,
 * so it is heard; the history folds the burst into one step. A scene key on an
 * empty place does both: making the scene is an edit, recalling it is not.
 *
 * WHAT IS REDRAWN
 * ---------------
 * The page is regions: the deck, the tabs, the body -- whose markup changes
 * only with the tab -- and the panels of the tab shown. After any change each
 * region's markup is built again and put in only if it differs, so the control
 * under the keyboard stays where it is; a new body puts its panels in with it.
 * The runtime's status arrives up to ten times a second and never redraws: it
 * lights the display, the LEDs, the playheads and part two's readouts in place
 * -- unless the scene changed, which changes what the page shows.
 *
 * The tab, the channel, cell and voice being edited are remembered per node
 * for the session, so leaving the page and coming back finds them again.
 */

// A knob's whole range is this many pixels of vertical travel; Shift is finer.
const DRAG_TRAVEL_PX = 200;
const FINE_FACTOR = 4;
// A knob being turned is written at most this often.
const DRAG_WRITE_MS = 50;
const REFUSAL_CHARS = 56;
const TAB_IDS = TABS.map((tab) => tab.id);
// A rule and the one it may not pass: moving one past the other takes it along.
const RULE_ABOVE = Object.freeze({ low: 'high', velocityLow: 'velocityHigh', shortest: 'longest' });
const RULE_BELOW = Object.freeze({ high: 'low', velocityHigh: 'velocityLow', longest: 'shortest' });
const MIDI_DESTINATION_TYPES = Object.freeze(['vst', 'arpeggiator', 'one-ring']);

/** nodeId -> what the author was looking at. */
const selections = new Map();

function selectionOf(nodeId) {
  if (!selections.has(nodeId)) {
    selections.set(nodeId, {
      channel: 0,
      cell: 0,
      // A letter key pressed, and the scene shown when it was: the deck shows
      // that letter until another scene is shown.
      bank: null,
      bankFor: -1,
      tab: 'sequence',
      voice: 0,
      materialView: 'origin',
      loadChoice: '',
      conditionChannel: 1,
      followDraft: { target: '', command: '', value: '' }
    });
  }
  return selections.get(nodeId);
}

/** Per mounted page: what is on screen and what a gesture holds. */
const mounts = new WeakMap();

function mountOf(context) {
  if (!mounts.has(context)) {
    mounts.set(context, {
      regions: null,
      scene: -1,
      ready: false,
      storeArmed: false,
      seedText: null,
      seedError: false,
      refusal: '',
      heads: new Map(),
      padHead: -1,
      tab: null,
      materialError: '',
      drag: null,
      deferred: false,
      // The field whose value is being written: its text is not kept over the
      // redraw that write causes, which prints the value as the page holds it.
      committing: null
    });
  }
  return mounts.get(context);
}

const clampIndex = (value, count) => (Number.isInteger(value) && value >= 0 && value < count ? value : 0);
const isReady = (hub, nodeId) => Number.isSafeInteger(hub.oneRing?.generationOf?.(nodeId));

/** The Sequencer's MIDI clips, as the Writer and a load name them. */
function midiClips(hub) {
  const tracks = hub.sequencer?.model?.state?.tracks ?? [];
  return tracks.filter((track) => track.type === 'midi').flatMap((track) => track.clips.map((clip) => ({
    id: clip.id,
    // A generation's clip is named after its track: said once.
    label: `${clip.name === track.name ? track.name : `${track.name} · ${clip.name}`} · bar ${Math.floor(clip.startPpq / 4) + 1}`
  })));
}

/** What a Sequencer track may play: a new generation's Destination. */
function midiDestinations(hub) {
  return (hub.network?.listNodes?.() ?? [])
    .filter((node) => MIDI_DESTINATION_TYPES.includes(node.type))
    .map((node) => ({ id: node.id, label: hub.nodes?.get?.(node.id)?.name || node.name || node.id }));
}

function viewOf(context) {
  const { instance, hub, type } = context;
  const selection = selectionOf(instance.id);
  const mount = mountOf(context);
  const content = instance.content;
  const status = hub.oneRing?.statusOf?.(instance.id) ?? null;
  const scene = edits.shownScene(content, status);
  const sceneData = content.scenes[scene];
  const bank = selection.bank && selection.bankFor === scene ? selection.bank : null;
  const channelIndex = clampIndex(selection.channel, CHANNEL_COUNT);
  const channel = sceneData.channels[channelIndex];
  const cellIndex = clampIndex(selection.cell, MAX_STEPS);
  const voiceIndex = clampIndex(selection.voice, VOICE_COUNT);
  const tab = TAB_IDS.includes(selection.tab) ? selection.tab : 'sequence';
  const internal = oneRingTargets(content);
  const external = hub.commands?.targetsFrom?.(instance.id) ?? [];
  const byId = new Map([...internal, ...external].map((target) => [target.id, target]));
  const findTarget = (id) => (id ? byId.get(id) ?? null : null);
  return {
    name: instance.name,
    icon: type?.icon || 'sequencer',
    content,
    scene,
    sceneData,
    bank,
    channelIndex,
    channel,
    cellIndex,
    cell: cellAt(channel, cellIndex),
    targets: { internal, external },
    findTarget,
    find: (target, command) => (command ? findTarget(target)?.commands.get(command) ?? null : null),
    ready: isReady(hub, instance.id),
    storeArmed: mount.storeArmed,
    seedText: mount.seedText,
    seedError: mount.seedError,
    followDraft: selection.followDraft,
    conditionChannel: selection.conditionChannel,
    tab,
    status,
    voiceIndex,
    voiceRules: sceneData.voices[voiceIndex],
    materialView: selection.materialView,
    loadChoice: selection.loadChoice,
    materialError: mount.materialError,
    writer: content.writer ?? defaultWriter(),
    writes: hub.oneRing?.writesOf?.(instance.id) ?? null,
    // Only what a tab shows is looked up.
    clips: tab === 'memory' || tab === 'writer' ? midiClips(hub) : [],
    destinations: tab === 'writer' ? midiDestinations(hub) : []
  };
}

function render(context) {
  const mount = mountOf(context);
  const view = viewOf(context);
  mount.regions = renderRegions(view);
  mount.scene = view.scene;
  mount.tab = tabOf(view);
  mount.bank = shownBank(view);
  mount.ready = view.ready;
  mount.heads.clear();
  mount.padHead = -1;
  return renderPage(view, mount.regions);
}

// ---------- live status ----------

function setText(element, text) {
  if (element && element.textContent !== text) element.textContent = text;
}

function barOf(beat) {
  if (!Number.isFinite(beat) || beat < 0) return '—';
  return `${Math.floor(beat / 4) + 1}.${Math.floor(beat % 4) + 1}`;
}

/** Light what the runtime reports, in place. */
export function applyStatus(container, context) {
  const { instance, hub } = context;
  const mount = mountOf(context);
  const content = instance.content;
  const status = hub.oneRing?.statusOf?.(instance.id) ?? null;
  const ready = isReady(hub, instance.id);
  const playing = ready && status?.playing === true;
  const scene = edits.shownScene(content, status);
  const pending = playing && content.scenes[status?.pendingScene] ? status.pendingScene : -1;
  const live = (name) => container.querySelector(`[data-ring-live="${name}"]`);
  setText(live('state'), !ready ? 'NOT IN THE ENGINE' : playing ? '▶ RUNNING' : '■ STOPPED');
  setText(live('scene'), content.scenes[scene].id);
  setText(live('bar'), status ? barOf(status.beat) : '—');
  setText(live('bpm'), status && status.bpm > 0 ? status.bpm.toFixed(1) : '—');
  setText(live('pending'), pending >= 0 ? `NEXT BAR → ${content.scenes[pending].id}` : '');
  setText(live('refused'), String(status?.rejected ?? 0));
  setText(live('guarded'), String(status?.guarded ?? 0));
  const refusal = mount.refusal.length > REFUSAL_CHARS ? `${mount.refusal.slice(0, REFUSAL_CHARS - 1)}…` : mount.refusal;
  setText(live('refusal'), refusal || '—');
  container.querySelector('[data-ring-live-run]')?.classList.toggle('is-lit', playing);
  for (const key of container.querySelectorAll('[data-ring-scene]')) {
    const index = Number(key.dataset.ringScene);
    key.classList.toggle('is-pending', index === pending);
  }
  // A recall waiting in a letter the deck does not show blinks its letter.
  const shown = mount.bank ?? scenePlace(content.scenes[scene].id)?.bank;
  const pendingBank = pending >= 0 ? scenePlace(content.scenes[pending].id)?.bank : null;
  for (const key of container.querySelectorAll('[data-ring-bank]')) {
    key.classList.toggle('is-pending', key.dataset.ringBank === pendingBank && pendingBank !== shown);
  }
  const current = content.scenes[scene].id;
  setText(live('scene-legend'), mount.storeArmed ? `Store ${current} into a place`
    : pending >= 0 ? `Next bar → ${content.scenes[pending].id}` : playing ? `${current} playing` : ' ');
  applyNotesStatus(container, context, { ready, status });
  const channel = clampIndex(selectionOf(instance.id).channel, CHANNEL_COUNT);
  for (let i = 0; i < CHANNEL_COUNT; i += 1) {
    const active = playing && status.active[i] === true;
    container.querySelector(`[data-ring-dot="${i}"]`)?.classList.toggle('is-on', active);
    container.querySelector(`[data-ring-led="${i}"]`)?.classList.toggle('is-on', active);
    const head = active ? status.playheads[i] : -1;
    const before = mount.heads.get(i) ?? -1;
    if (head === before) continue;
    const strip = container.querySelector(`[data-ring-mini="${i}"]`);
    if (!strip) continue;
    strip.querySelector(`[data-cell="${before}"]`)?.classList.remove('is-head');
    strip.querySelector(`[data-cell="${head}"]`)?.classList.add('is-head');
    mount.heads.set(i, head);
  }
  const padHead = playing && status.active[channel] ? status.playheads[channel] : -1;
  if (padHead !== mount.padHead) {
    container.querySelector(`[data-ring-pad="${mount.padHead}"]`)?.classList.remove('is-playhead');
    container.querySelector(`[data-ring-pad="${padHead}"]`)?.classList.add('is-playhead');
    mount.padHead = padHead;
  }
}

const CAPTURE_TEXT = Object.freeze({ off: 'OFF', armed: 'ARMED', capturing: 'CAPTURING' });

/** Part two's lights and readouts: the tabs' LEDs, and the tab shown. */
function applyNotesStatus(container, context, { ready, status }) {
  const { instance, hub } = context;
  const live = (name) => container.querySelector(`[data-ring-live="${name}"]`);
  const capture = ready ? status?.capture ?? 'off' : 'off';
  const sounding = ready ? status?.sounding ?? [] : [];
  const feedback = ready && status?.feedback === true;
  container.querySelector('[data-ring-live-tab="memory"]')?.classList.toggle('is-on', capture !== 'off');
  container.querySelector('[data-ring-live-tab="voices"]')?.classList.toggle('is-on', sounding.some((count) => count > 0));
  container.querySelector('[data-ring-live-tab="writer"]')?.classList.toggle('is-on', feedback);
  switch (mountOf(context).tab) {
    case 'memory': {
      const key = container.querySelector('[data-ring-live-key="capture"]');
      key?.classList.toggle('is-lit', capture === 'capturing');
      key?.classList.toggle('is-pending', capture === 'armed');
      setText(live('capture-state'), ready ? CAPTURE_TEXT[capture] ?? 'OFF' : '—');
      setText(live('capture-taken'), String(status?.captured ?? 0));
      setText(live('capture-refused'), String(status?.captureRefused ?? 0));
      break;
    }
    case 'voices': {
      for (let v = 0; v < VOICE_COUNT; v += 1) {
        container.querySelector(`[data-ring-live-voice="${v}"]`)?.classList.toggle('is-on', (sounding[v] ?? 0) > 0);
        setText(live(`voice-sounding-${v}`), `${sounding[v] ?? 0} sounding`);
      }
      const selection = selectionOf(instance.id);
      const scene = edits.shownScene(instance.content, status);
      const voice = clampIndex(selection.voice, VOICE_COUNT);
      setText(live('voice-live'), ready ? liveRulesText(status?.voices?.[voice], instance.content.scenes[scene].voices[voice]) : '—');
      setText(live('voice-refused'), String(status?.notesRefused ?? 0));
      break;
    }
    case 'writer': {
      container.querySelector('[data-ring-live-key="feedback"]')?.classList.toggle('is-lit', feedback);
      const writes = hub.oneRing?.writesOf?.(instance.id);
      setText(live('writer-feedback'), !ready ? '—' : status?.feedbackStopped ? 'STOPPED AT ITS LIMIT' : feedback ? 'ON' : 'OFF');
      setText(live('writer-sent'), String(status?.writes ?? 0));
      setText(live('writer-empty'), String(status?.writesEmpty ?? 0));
      setText(live('writer-written'), String(writes?.written ?? 0));
      setText(live('writer-refused'), String(writes?.refused ?? 0));
      setText(live('writer-last'), writes?.lastRefusal || '—');
      break;
    }
    default:
      break;
  }
}

// ---------- redrawing ----------

function focusKey(element) {
  if (!element?.dataset) return null;
  if (element.dataset.ringFocus) return `[data-ring-focus="${element.dataset.ringFocus}"]`;
  if (element.dataset.ringKnob) return `[data-ring-knob="${element.dataset.ringKnob}"]`;
  if (element.dataset.ringAct) {
    const arg = element.dataset.ringArg;
    return `[data-ring-act="${element.dataset.ringAct}"]${arg === undefined ? '' : `[data-ring-arg="${arg}"]`}`;
  }
  return null;
}

/** Put in each region whose markup changed, keep the focus where it was, and light the status. */
export function refreshPage(container, context) {
  const mount = mountOf(context);
  const view = viewOf(context);
  const regions = renderRegions(view);
  const tab = tabOf(view);
  mount.regions ??= {};
  for (const [name, markup] of Object.entries(regions)) {
    if (mount.regions[name] === markup) continue;
    if (name === 'body') {
      const body = container.querySelector('[data-ring-region="body"]');
      if (!body) continue;
      body.innerHTML = bodyMarkup(tab, regions);
      mount.regions.body = markup;
      for (const panel of TAB_REGIONS[tab]) mount.regions[panel] = regions[panel];
      mount.heads.clear();
      mount.padHead = -1;
      continue;
    }
    // A redraw under a turning knob would take the knob from under the mouse.
    if (mount.drag?.region === name) {
      mount.deferred = true;
      continue;
    }
    const element = container.querySelector(`[data-ring-region="${name}"]`);
    if (!element) continue;
    const active = globalThis.document?.activeElement;
    const key = active && element.contains?.(active) ? focusKey(active) : null;
    // Text being typed survives a redraw it did not cause: a scene recalled by
    // the sequence must not wipe a seed half entered.
    const text = key && active.tagName === 'INPUT' && active.type === 'text';
    const typing = text && active !== mount.committing && active.value !== active.defaultValue
      ? { value: active.value, start: active.selectionStart, end: active.selectionEnd }
      : null;
    element.innerHTML = markup;
    mount.regions[name] = markup;
    if (name === 'channels') mount.heads.clear();
    if (name === 'channel') mount.padHead = -1;
    const again = key ? element.querySelector(key) : null;
    again?.focus?.();
    if (again && typing) {
      again.value = typing.value;
      again.setSelectionRange?.(typing.start, typing.end);
    } else if (again && text) {
      again.setSelectionRange?.(again.value.length, again.value.length);
    }
  }
  mount.scene = view.scene;
  mount.tab = tab;
  mount.bank = shownBank(view);
  mount.ready = view.ready;
  applyStatus(container, context);
}

// ---------- binding ----------

function parseNumber(text) {
  const cleaned = String(text ?? '').replace(/[^\d+\-.,]/g, '').replace(',', '.');
  const value = Number(cleaned);
  return cleaned !== '' && Number.isFinite(value) ? value : null;
}

/** What a follow action's value field holds, as the command takes it. */
function draftValue(descriptor, text) {
  if (!descriptor) return null;
  if (descriptor.type === VALUE_TYPE.none) return { type: VALUE_TYPE.none };
  return edits.parseValue(descriptor, text);
}

function initialDraft(descriptor) {
  if (!descriptor) return '';
  if (descriptor.type === VALUE_TYPE.choice) return String(descriptor.choices?.[0]?.id ?? '');
  if (descriptor.type === VALUE_TYPE.boolean) return 'on';
  if (descriptor.type === VALUE_TYPE.integer || descriptor.type === VALUE_TYPE.number) return String(descriptor.minimum);
  return '';
}

function bind(container, context) {
  const { hub, instance } = context;
  const nodeId = instance.id;
  const mount = mountOf(context);
  const selection = selectionOf(nodeId);
  const refresh = () => refreshPage(container, context);
  const content = () => instance.content;
  const write = (next) => {
    if (next && next !== content()) hub.nodes.setContent(nodeId, next);
  };
  // Which scene the file opens in, while nothing plays: not an edit (D-032).
  const perform = (next) => {
    if (!next || next === content()) return;
    const put = () => hub.nodes.setContent(nodeId, next);
    if (typeof hub.perform === 'function') hub.perform(put);
    else put();
  };
  const channelSetting = (setting, value) => {
    const view = viewOf(context);
    write(edits.setChannelSetting(view.content, view.scene, view.channelIndex, setting, value,
      { descriptor: view.find(view.channel.target.target, view.channel.target.command) }));
  };
  const cellEdit = (change) => {
    const view = viewOf(context);
    const descriptor = view.find(view.channel.target.target, view.channel.target.command);
    write(edits.editCell(view.content, view.scene, view.channelIndex, view.cellIndex, (cell) => change(cell, descriptor)));
  };
  /** One voice rule, and the one it may not pass taken along. */
  const voiceRule = (rule, value) => {
    const view = viewOf(context);
    const rules = { ...view.voiceRules, [rule]: value };
    if (RULE_ABOVE[rule] && rules[rule] > rules[RULE_ABOVE[rule]]) rules[RULE_ABOVE[rule]] = rules[rule];
    if (RULE_BELOW[rule] && rules[rule] < rules[RULE_BELOW[rule]]) rules[RULE_BELOW[rule]] = rules[rule];
    const next = setVoice(view.content, view.scene, view.voiceIndex, rules);
    // Refused, the knob goes back to what the voice holds.
    if (next === view.content) refresh();
    else write(next);
  };
  const setKnob = (name, value) => {
    const spec = KNOBS[name];
    if (!spec || !Number.isFinite(value)) return;
    const whole = Math.min(spec.max, Math.max(spec.min, Math.round(value)));
    switch (spec.edit) {
      case 'cell': cellEdit((cell) => edits.setProbability(cell, value)); break;
      case 'channel': channelSetting(name, value); break;
      case 'capture': write(setCaptureSettings(content(), { bars: whole })); break;
      case 'voice': voiceRule(spec.rule, whole); break;
      case 'writer': write(setWriterSettings(content(), { [spec.field]: whole })); break;
      default: break;
    }
  };
  /** A typed value that does not fit: the field says so until it is drawn again. */
  const refuse = (element) => {
    element?.classList?.add('is-invalid');
    element?.setAttribute?.('aria-invalid', 'true');
  };
  const typedValue = (element, arg) => {
    const view = viewOf(context);
    const descriptor = view.find(view.channel.target.target, view.channel.target.command);
    return { descriptor, value: edits.parseValue(descriptor, arg ?? element?.value) };
  };

  const actions = {
    tab: (id) => {
      if (!TAB_IDS.includes(id) || selection.tab === id) return;
      selection.tab = id;
      refresh();
    },
    // ---- memory ----
    capture: () => hub.oneRing.memory(nodeId, content().capture.mode === CAPTURE_MODE.add ? 'CAPTURE_ADD' : 'CAPTURE_REPLACE'),
    'capture-end': () => hub.oneRing.memory(nodeId, 'CAPTURE_END'),
    'capture-mode': (arg) => write(setCaptureSettings(content(), { mode: Number(arg) })),
    'capture-mode-toggle': (_, element) => write(setCaptureSettings(content(),
      { mode: element.checked ? CAPTURE_MODE.add : CAPTURE_MODE.replace })),
    'material-view': (arg) => {
      selection.materialView = arg === 'current' ? 'current' : 'origin';
      refresh();
    },
    freeze: () => write(setFrozen(content(), !content().material.frozen)),
    revert: () => write(revertMaterial(content())),
    clear: () => write(clearMaterial(content())),
    'load-choice': (_, element) => {
      selection.loadChoice = String(element.value || '');
      mount.materialError = '';
      refresh();
    },
    'load-clip': () => {
      const found = hub.sequencer?.model?._clip?.(selection.loadChoice);
      if (!found || found.track.type !== 'midi') {
        mount.materialError = 'That clip is gone';
        refresh();
        return;
      }
      try {
        mount.materialError = '';
        selection.materialView = 'origin';
        write(loadMaterial(content(), noteListFromClip(found.clip)));
      } catch (error) {
        mount.materialError = `Not loaded: ${error?.message || error}`;
      }
      refresh();
    },
    // ---- voices ----
    voice: (arg) => {
      selection.voice = clampIndex(Number(arg), VOICE_COUNT);
      refresh();
    },
    'voice-rule': (rule, element) => voiceRule(rule, Number(element.value)),
    'voice-order': (arg, element) => voiceRule('order', Number(arg ?? element.value)),
    'voice-reset': () => {
      const view = viewOf(context);
      write(setVoice(view.content, view.scene, view.voiceIndex, defaultVoice()));
    },
    // ---- writer ----
    write: () => hub.oneRing.writer(nodeId, 'WRITE'),
    'feedback-live': () => hub.oneRing.writer(nodeId,
      hub.oneRing.statusOf(nodeId)?.feedback ? 'FEEDBACK_OFF' : 'FEEDBACK_ON'),
    'write-mode': (arg) => write(setWriterSettings(content(), { mode: Number(arg) })),
    'writer-clip': (_, element) => write(setWriterSettings(content(), { clipId: String(element.value || '') })),
    'writer-destination': (_, element) => write(setWriterSettings(content(), { destination: String(element.value || '') })),
    'writer-feedback': (_, element) => write(setWriterSettings(content(), { feedback: element.checked === true })),
    'writer-feedback-mode': (arg) => write(setWriterSettings(content(), { feedbackMode: Number(arg) })),
    'writer-feedback-mode-toggle': (_, element) => write(setWriterSettings(content(),
      { feedbackMode: element.checked ? CAPTURE_MODE.add : CAPTURE_MODE.replace })),
    // ---- the deck and the sequence ----
    run: () => hub.oneRing.command(nodeId, 'run'),
    stop: () => hub.oneRing.command(nodeId, 'stop'),
    bank: (letter) => {
      if (!SCENE_BANKS.includes(letter)) return;
      selection.bank = letter;
      selection.bankFor = viewOf(context).scene;
      refresh();
    },
    place: (place) => {
      const view = viewOf(context);
      const where = scenePlace(place);
      if (!where) return;
      // The deck stays on this letter while the recall waits for its bar.
      selection.bank = where.bank;
      selection.bankFor = view.scene;
      if (mount.storeArmed) {
        mount.storeArmed = false;
        if (sceneIndex(view.content, place) !== view.scene) write(storeSceneAt(view.content, view.scene, place));
        refresh();
        return;
      }
      let index = sceneIndex(view.content, place);
      if (index < 0) {
        write(addScene(view.content, place));
        index = sceneIndex(content(), place);
        if (index < 0) return;
      }
      if (view.ready) hub.oneRing.command(nodeId, 'scene', { scene: index });
      else perform(edits.selectScene(content(), index));
      refresh();
    },
    store: () => {
      mount.storeArmed = !mount.storeArmed;
      refresh();
    },
    timing: (arg) => write(edits.setSceneTiming(content(), Number(arg))),
    'timing-toggle': (_, element) => write(edits.setSceneTiming(content(),
      element.checked ? SCENE_TIMING.nextBar : SCENE_TIMING.immediate)),
    position: (arg) => write(edits.setScenePosition(content(), Number(arg))),
    'position-toggle': (_, element) => write(edits.setScenePosition(content(),
      element.checked ? SCENE_POSITION.keep : SCENE_POSITION.restart)),
    seed: (_, element) => {
      const seed = parseSeed(element.value);
      mount.seedError = seed === null;
      mount.seedText = seed === null ? element.value : null;
      if (seed !== null) write(reseed(content(), seed));
      refresh();
    },
    'new-seed': () => {
      mount.seedError = false;
      mount.seedText = null;
      write(reseed(content()));
    },
    'mutate-channel': () => {
      const view = viewOf(context);
      write(mutateSequence(view.content, { scene: view.scene, channel: view.channelIndex }));
    },
    'mutate-all': () => {
      const view = viewOf(context);
      write(mutateSequence(view.content, { scene: view.scene }));
    },
    channel: (arg) => {
      // A new channel opens on its first cell, as the VST's did.
      selection.channel = clampIndex(Number(arg), CHANNEL_COUNT);
      selection.cell = 0;
      refresh();
    },
    target: (_, element) => {
      const view = viewOf(context);
      write(edits.setChannelTarget(view.content, view.scene, view.channelIndex, element.value));
    },
    command: (_, element) => {
      const view = viewOf(context);
      write(edits.setChannelCommand(view.content, view.scene, view.channelIndex, element.value,
        view.find(view.channel.target.target, element.value)));
    },
    'restart-channel': () => hub.oneRing.command(nodeId, 'channel', { channel: selection.channel + 1, name: 'RESTART' }),
    'stop-channel': () => hub.oneRing.command(nodeId, 'channel', { channel: selection.channel + 1, name: 'STOP' }),
    mutable: (arg) => {
      const view = viewOf(context);
      write(edits.toggleMutable(view.content, view.scene, view.channelIndex, Number(arg)));
    },
    enabled: (_, element) => channelSetting('enabled', element.checked),
    length: (arg, element) => channelSetting('length', Number(arg ?? element.value)),
    rate: (arg, element) => channelSetting('rate', Number(arg ?? element.value)),
    repeats: (arg, element) => channelSetting('repeats', Number(arg ?? element.value)),
    mode: (arg) => channelSetting('mode', Number(arg)),
    'mode-toggle': (_, element) => channelSetting('mode', element.checked ? STEP_MODE.legato : STEP_MODE.trigger),
    'knob-value': (name, element) => {
      // A knob that reads its own words (a note name, END) is asked first.
      const own = KNOBS[name]?.parse?.(element.value);
      const value = own ?? parseNumber(element.value);
      if (value === null || value === undefined) {
        refuse(element);
        return;
      }
      setKnob(name, value);
      refresh();
    },
    pad: (arg) => {
      selection.cell = clampIndex(Number(arg), MAX_STEPS);
      refresh();
    },
    active: () => cellEdit(edits.toggleActive),
    'value-mode': (arg) => cellEdit((cell, descriptor) => edits.setValueMode(cell, Number(arg), descriptor)),
    'value-fixed': (arg, element) => {
      const { value } = typedValue(element, arg);
      if (!value) refuse(element);
      else cellEdit((cell) => edits.setFixedValue(cell, value));
    },
    'value-min': (_, element) => {
      const { value } = typedValue(element);
      if (!value) refuse(element);
      else cellEdit((cell) => edits.setRangeEnd(cell, 'min', value));
    },
    'value-max': (_, element) => {
      const { value } = typedValue(element);
      if (!value) refuse(element);
      else cellEdit((cell) => edits.setRangeEnd(cell, 'max', value));
    },
    'value-list': (_, element) => {
      const { descriptor } = typedValue(element);
      const values = edits.parseValueList(descriptor, element.value);
      if (!values) refuse(element);
      else cellEdit((cell) => edits.setChoices(cell, values));
    },
    'value-choice': (arg) => cellEdit((cell) => edits.toggleChoice(cell, Number(arg))),
    'cond-add': (_, element) => {
      const condition = edits.conditionFor(element.value, selection.conditionChannel);
      element.value = '';
      cellEdit((cell) => edits.addCondition(cell, condition));
    },
    'cond-channel': (_, element) => {
      selection.conditionChannel = clampIndex(Number(element.value), CHANNEL_COUNT);
      refresh();
    },
    'cond-remove': (arg) => cellEdit((cell) => edits.removeCondition(cell, Number(arg))),
    'lock-cell': () => cellEdit(edits.toggleLocked),
    'lock-field': (arg) => cellEdit((cell) => edits.toggleLockedField(cell, Number(arg))),
    'follow-target': (_, element) => {
      selection.followDraft = { target: element.value, command: '', value: '' };
      refresh();
    },
    'follow-command': (_, element) => {
      const descriptor = viewOf(context).find(selection.followDraft.target, element.value);
      selection.followDraft = { ...selection.followDraft, command: element.value, value: initialDraft(descriptor) };
      refresh();
    },
    'follow-value': (_, element) => {
      selection.followDraft = { ...selection.followDraft, value: element.value };
    },
    'follow-add': () => {
      const view = viewOf(context);
      const { target, command, value: text } = selection.followDraft;
      const value = draftValue(view.find(target, command), text);
      if (!value) {
        refuse(container.querySelector('[data-ring-act="follow-value"]'));
        return;
      }
      write(edits.addFollowAction(view.content, view.scene, view.channelIndex, edits.followAction(target, command, value)));
    },
    'follow-remove': (arg) => {
      const view = viewOf(context);
      write(edits.removeFollowAction(view.content, view.scene, view.channelIndex, Number(arg)));
    }
  };

  const run = (name, arg, element) => {
    const action = actions[name];
    if (!action) return;
    const failed = (error) => hub.diagnostics?.log?.(`one-ring: page action ${name} failed -- ${error?.message || error}`);
    mount.committing = element?.tagName === 'INPUT' ? element : null;
    try {
      Promise.resolve(action(arg, element)).catch(failed);
    } catch (error) {
      failed(error);
    } finally {
      mount.committing = null;
    }
  };

  const isField = (element) => element?.tagName === 'INPUT' || element?.tagName === 'SELECT';

  const onClick = (event) => {
    const option = event.target?.closest?.('[data-ring-option]');
    if (option && container.contains(option)) {
      const select = option.closest('.op-selector')?.querySelector('[data-ring-act]');
      if (select && !select.disabled) run(select.dataset.ringAct, option.dataset.ringOption, select);
      return;
    }
    const element = event.target?.closest?.('[data-ring-act]');
    if (!element || !container.contains(element) || element.disabled || isField(element)) return;
    run(element.dataset.ringAct, element.dataset.ringArg, element);
  };

  const onDoubleClick = (event) => {
    const pad = event.target?.closest?.('[data-ring-act="pad"]');
    if (pad && container.contains(pad)) {
      selection.cell = clampIndex(Number(pad.dataset.ringArg), MAX_STEPS);
      cellEdit(edits.toggleActive);
      return;
    }
    const knob = event.target?.closest?.('[data-ring-knob]');
    if (knob && container.contains(knob)) setKnob(knob.dataset.ringKnob, KNOBS[knob.dataset.ringKnob]?.reset);
  };

  const onChange = (event) => {
    const element = event.target?.closest?.('[data-ring-act]');
    if (!element || !container.contains(element) || !isField(element)) return;
    run(element.dataset.ringAct, element.dataset.ringArg, element);
  };

  const knobValueOf = (knob) => Number(knob.getAttribute('aria-valuenow'));

  const showKnob = (knob, name, value) => {
    const spec = KNOBS[name];
    syncDragKnob(knob, { value, min: spec.min, max: spec.max, bipolar: spec.bipolar, text: spec.text(value) });
    const lcd = container.querySelector(`[data-ring-knob-lcd="${name}"]`);
    if (lcd && globalThis.document?.activeElement !== lcd) lcd.value = spec.text(value);
  };

  const onKeyDown = (event) => {
    const knob = event.target?.closest?.('[data-ring-knob]');
    if (knob && container.contains(knob)) {
      const name = knob.dataset.ringKnob;
      const spec = KNOBS[name];
      const value = knobValueOf(knob);
      const step = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 10, PageDown: -10 }[event.key];
      let next = null;
      if (step !== undefined) next = value + step;
      else if (event.key === 'Home') next = spec.min;
      else if (event.key === 'End') next = spec.max;
      if (next === null) return;
      event.preventDefault();
      next = Math.min(spec.max, Math.max(spec.min, next));
      showKnob(knob, name, next);
      setKnob(name, next);
      return;
    }
    const field = event.target?.closest?.('input[data-ring-act]');
    if (field && container.contains(field) && field.type === 'text') {
      if (event.key === 'Enter') {
        event.preventDefault();
        run(field.dataset.ringAct, field.dataset.ringArg, field);
      } else if (event.key === 'Escape') {
        field.value = field.defaultValue;
        field.classList?.remove('is-invalid');
        field.blur?.();
      }
      return;
    }
    if (event.key === 'Escape' && mount.storeArmed) {
      mount.storeArmed = false;
      refresh();
    }
  };

  const onPointerDown = (event) => {
    if (event.button !== 0) return;
    const knob = event.target?.closest?.('[data-ring-knob]');
    if (!knob || !container.contains(knob)) return;
    const name = knob.dataset.ringKnob;
    if (!KNOBS[name]) return;
    event.preventDefault();
    knob.focus?.({ preventScroll: true });
    mount.drag = {
      knob, name, region: KNOBS[name].region, pointerId: event.pointerId,
      startY: event.clientY, start: knobValueOf(knob), value: knobValueOf(knob), timer: null
    };
    knob.classList.add('is-dragging');
    try { knob.setPointerCapture?.(event.pointerId); } catch (_) { /* the drag works without capture */ }
  };

  const onPointerMove = (event) => {
    const drag = mount.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const spec = KNOBS[drag.name];
    const travel = (drag.startY - event.clientY) / (event.shiftKey ? DRAG_TRAVEL_PX * FINE_FACTOR : DRAG_TRAVEL_PX);
    const next = Math.min(spec.max, Math.max(spec.min, Math.round(drag.start + travel * (spec.max - spec.min))));
    if (next === drag.value) return;
    drag.value = next;
    showKnob(drag.knob, drag.name, next);
    if (drag.timer !== null) return;
    drag.timer = setTimeout(() => {
      drag.timer = null;
      if (mount.drag === drag) setKnob(drag.name, drag.value);
    }, DRAG_WRITE_MS);
  };

  const endDrag = (event) => {
    const drag = mount.drag;
    if (!drag || (event && event.pointerId !== drag.pointerId)) return;
    mount.drag = null;
    if (drag.timer !== null) clearTimeout(drag.timer);
    drag.knob.classList.remove('is-dragging');
    // The last position is written whatever the timer did with the others.
    setKnob(drag.name, drag.value);
    if (mount.deferred) {
      mount.deferred = false;
      refresh();
    }
  };

  const listeners = [
    ['click', onClick], ['dblclick', onDoubleClick], ['change', onChange], ['keydown', onKeyDown],
    ['pointerdown', onPointerDown], ['pointermove', onPointerMove], ['pointerup', endDrag],
    ['pointercancel', endDrag], ['lostpointercapture', endDrag]
  ];
  for (const [type, listener] of listeners) container.addEventListener(type, listener);

  const mine = (handler) => (message) => {
    if (message?.nodeId === nodeId) handler(message);
  };
  const offs = [
    hub.events.on('oneRing:status', mine(() => {
      const scene = edits.shownScene(instance.content, hub.oneRing.statusOf(nodeId));
      if (scene !== mount.scene) refresh();
      else applyStatus(container, context);
    })),
    hub.events.on('oneRing:ready', mine(refresh)),
    hub.events.on('oneRing:gone', mine(refresh)),
    hub.events.on('oneRing:contentChanged', mine(refresh)),
    hub.events.on('oneRing:refusal', mine(({ message }) => {
      mount.refusal = String(message || '');
      applyStatus(container, context);
    })),
    // What the writer did: its readouts.
    hub.events.on('oneRing:written', mine(() => applyStatus(container, context))),
    hub.events.on('oneRing:writeRefused', mine(() => applyStatus(container, context))),
    hub.events.on('oneRing:refused', mine(({ message }) => {
      mount.refusal = `sequence refused: ${message || 'no reason'}`;
      applyStatus(container, context);
    })),
    // What CTRL OUT reaches: the target lists.
    hub.events.on('network:change', refresh),
    hub.events.on('commands:providerChanged', refresh),
    hub.events.on('module:registered', refresh),
    hub.events.on('module:unregistered', refresh),
    hub.events.on('sequencer:changed', refresh),
    // nodeInstances.js has just drawn the page again from `render`.
    hub.events.on('history:applied', () => applyStatus(container, context))
  ];
  applyStatus(container, context);

  return () => {
    for (const [type, listener] of listeners) container.removeEventListener(type, listener);
    for (const off of offs) off();
    if (mount.drag?.timer) clearTimeout(mount.drag.timer);
    mount.drag = null;
  };
}

/** Install the page. Returns its unregister function, as `registerNodeEditor` does. */
export function registerOneRingPanel() {
  return registerNodeEditor('one-ring', { render, bind });
}
