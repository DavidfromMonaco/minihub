import { registerNodeEditor } from '../../core/nodeEditors.js';
import { VALUE_TYPE } from '../../core/commandRegistry.js';
import {
  CHANNEL_COUNT, MAX_STEPS, SCENE_POSITION, SCENE_TIMING, STEP_MODE,
  cellAt, mutateSequence, oneRingTargets, parseSeed, reseed, storeScene
} from '../../core/oneRingSequence.js';
import { syncDragKnob } from '../../ui/omniPearl.js';
import * as edits from '../../core/oneRingEdits.js';
import { KNOBS, renderPage, renderRegions } from './oneRingFaceplate.js';

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
 * so it is heard; the history folds the burst into one step.
 *
 * WHAT IS REDRAWN
 * ---------------
 * The page is five regions. After any change each region's markup is built
 * again and put in only if it differs, so the control under the keyboard stays
 * where it is. The runtime's status arrives up to ten times a second and never
 * redraws: it lights the display, the LEDs and the playheads in place -- unless
 * the scene changed, which changes what the page shows.
 *
 * The channel and cell being edited are remembered per node for the session,
 * so leaving the page and coming back finds them again.
 */

// A knob's whole range is this many pixels of vertical travel; Shift is finer.
const DRAG_TRAVEL_PX = 200;
const FINE_FACTOR = 4;
// A knob being turned is written at most this often.
const DRAG_WRITE_MS = 50;
const REFUSAL_CHARS = 56;
const KNOB_REGION = Object.freeze({ offset: 'channel', swing: 'channel', humanize: 'channel', probability: 'cell' });

/** nodeId -> what the author was looking at. */
const selections = new Map();

function selectionOf(nodeId) {
  if (!selections.has(nodeId)) {
    selections.set(nodeId, {
      channel: 0,
      cell: 0,
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

function viewOf(context) {
  const { instance, hub, type } = context;
  const selection = selectionOf(instance.id);
  const mount = mountOf(context);
  const content = instance.content;
  const status = hub.oneRing?.statusOf?.(instance.id) ?? null;
  const scene = edits.shownScene(content, status);
  const sceneData = content.scenes[scene];
  const channelIndex = clampIndex(selection.channel, CHANNEL_COUNT);
  const channel = sceneData.channels[channelIndex];
  const cellIndex = clampIndex(selection.cell, MAX_STEPS);
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
    conditionChannel: selection.conditionChannel
  };
}

function render(context) {
  const mount = mountOf(context);
  const view = viewOf(context);
  mount.regions = renderRegions(view);
  mount.scene = view.scene;
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
  for (const legend of container.querySelectorAll('[data-ring-scene-legend]')) {
    const index = Number(legend.dataset.ringSceneLegend);
    const text = mount.storeArmed
      ? (index === scene ? '' : 'Store here')
      : index === pending ? 'Next bar' : index === scene ? (playing ? 'Playing' : '') : '';
    setText(legend, text || ' ');
  }
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
  mount.regions ??= {};
  for (const [name, markup] of Object.entries(regions)) {
    if (mount.regions[name] === markup) continue;
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
  const setKnob = (name, value) => {
    if (name === 'probability') cellEdit((cell) => edits.setProbability(cell, value));
    else if (KNOBS[name]) channelSetting(name, value);
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
    run: () => hub.oneRing.command(nodeId, 'run'),
    stop: () => hub.oneRing.command(nodeId, 'stop'),
    scene: (arg) => {
      const view = viewOf(context);
      const index = Number(arg);
      if (mount.storeArmed) {
        mount.storeArmed = false;
        if (index !== view.scene) write(storeScene(view.content, view.scene, index));
        refresh();
        return;
      }
      if (view.ready) hub.oneRing.command(nodeId, 'scene', { scene: index });
      else perform(edits.selectScene(view.content, index));
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
      const value = parseNumber(element.value);
      if (value === null) {
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
      knob, name, region: KNOB_REGION[name], pointerId: event.pointerId,
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
