import { followContentWrites, registerNodeEditor } from '../../core/nodeEditors.js';
import { escapeHtml } from '../../core/html.js';
import { icon } from '../../ui/icons.js';
import {
  currentArpeggiatorStep, moveCustomNote, removeCustomNote, renderArpControlStrip,
  renderCustomPatternEditor, setCustomGateDuration, setCustomNote, syncArpControlStrip,
  velocityFromPointer
} from './arpeggiatorEditor.js';

/**
 * The Arpeggiator node's page -- Omni Pearl skin.
 *
 * The Bay opens straight onto this: the control strip and the pattern editor
 * are both here, always. There is no intermediate "open the editor" page any
 * more - the roll is the page. Drawing in it while a preset mode is selected
 * simply edits the stored Custom pattern; the mode selector alone decides what
 * the engine plays.
 *
 * The controls write `instance.content` in place, where `engineSync` reads it;
 * `publish()` saves the project and tells the engine to read it again.
 */
export function renderArpeggiatorEditor(instance, type, selectedStep = -1) {
  const c = instance.content;
  return `<div class="omni-pearl op-module" data-arp-editor>
    <div class="op-module-header"><span class="op-module-glyph">${icon(type?.icon || 'sequencer', 22)}</span>
      <h1 class="op-module-title">${escapeHtml(instance.name)}</h1><span class="op-spacer"></span>
      <button type="button" id="node-delete" class="op-btn op-btn--danger">Delete Node</button></div>
    ${renderArpControlStrip(c)}
    <div class="op-arp-stack" data-arp-custom-editor>${renderCustomPatternEditor(c, selectedStep)}</div>
  </div>`;
}

/** What one opening of the page remembers: the step selected, the one playing, a drag. */
function viewOf({ state }) {
  if (!('selectedStep' in state)) {
    state.selectedStep = -1;
    state.currentStep = -1;
    state.drag = null;
  }
  return state;
}

function render(context) {
  return renderArpeggiatorEditor(context.instance, context.type, viewOf(context).selectedStep);
}

function updatePlayhead(container, view) {
  container.querySelectorAll('[data-arp-step-marker],[data-arp-velocity]').forEach((el) => {
    const step = Number(el.dataset.arpStepMarker ?? el.dataset.arpVelocity);
    el.classList.toggle('current', step === view.currentStep);
  });
}

/** Bring the root note of the first step to the middle of the roll. */
function centerRoll(container) {
  const scroll = container.querySelector('[data-arp-roll-scroll]');
  const rootCell = container.querySelector('[data-arp-cell][data-arp-step="0"][data-arp-offset="0"]');
  if (scroll && rootCell) {
    scroll.scrollTop = Math.max(0, rootCell.offsetTop - scroll.clientHeight / 2 + rootCell.offsetHeight / 2);
  }
}

/**
 * Draw the roll again from the model. Its scroll position is kept: a roll that
 * jumps back to the top of the keyboard at every note drawn is unusable.
 */
function rerenderRoll(container, context) {
  const view = viewOf(context);
  const editor = container.querySelector('[data-arp-custom-editor]');
  if (!editor) return;
  const scroll = editor.querySelector('[data-arp-roll-scroll]');
  const scrollTop = scroll?.scrollTop || 0;
  const scrollLeft = scroll?.scrollLeft || 0;
  editor.innerHTML = renderCustomPatternEditor(context.instance.content, view.selectedStep);
  const nextScroll = editor.querySelector('[data-arp-roll-scroll]');
  if (nextScroll) {
    nextScroll.scrollTop = scrollTop;
    nextScroll.scrollLeft = scrollLeft;
  }
  const velocityScroll = editor.querySelector('[data-arp-velocity-scroll]');
  if (velocityScroll) velocityScroll.scrollLeft = nextScroll?.scrollLeft || 0;
  updatePlayhead(container, view);
}

/**
 * An undo, a redo, a command or an agent changed the pattern under the page.
 *
 * Reported from use on 2026-09-12: `Ctrl+Z` in the arpeggiator "acted on the
 * Patch Bay". It did not -- it restored the pattern correctly and the page went
 * on showing the old drawing. The strip is synced in place and the roll redrawn
 * with its scroll kept; a panel whose notes come back at the cost of jumping to
 * the top of the keyboard is barely better than one that does not come back.
 */
function refresh(container, context) {
  syncArpControlStrip(container, context.instance.content);
  rerenderRoll(container, context);
}

/** The value a control of the strip carries, typed as the content holds it. */
function controlValue(control, input) {
  if (['snapToScale', 'hold', 'enabled'].includes(control)) return input.checked;
  if (control === 'root' || control === 'patternLength') return Number(input.value);
  return input.value;
}

function bind(container, context) {
  const { instance, hub, manager } = context;
  const view = viewOf(context);
  const content = () => instance.content;

  const publish = () => {
    manager.persist();
    hub.events.emit('nativeMidi:stateChanged', { nodeId: instance.id });
  };
  const edited = () => {
    publish();
    rerenderRoll(container, context);
  };

  const onClick = (e) => {
    const action = e.target.closest('[data-arp-action]')?.dataset.arpAction;
    if (action === 'remove-note' && view.selectedStep >= 0) {
      removeCustomNote(content(), view.selectedStep);
      edited();
    }
  };

  const onInput = (e) => {
    const control = e.target.dataset.arpControl;
    if (control) {
      if (e.target.tagName === 'SELECT' && e.type !== 'change') return;
      const value = controlValue(control, e.target);
      if (content()[control] === value) return;
      content()[control] = value;
      if (control === 'patternLength' && view.selectedStep >= value) view.selectedStep = -1;
      publish();
      syncArpControlStrip(container, content());
      rerenderRoll(container, context);
      return;
    }
    const step = e.target.closest('[data-arp-step]');
    const field = e.target.dataset.arpField;
    if (!step || !field) return;
    const target = content().customPattern[Number(step.dataset.arpStep)];
    target[field] = e.target.type === 'checkbox' ? e.target.checked : Number(e.target.value);
    if (field === 'rest' && target.rest) target.tie = false;
    if (field === 'tie' && target.tie) target.rest = true;
    publish();
    if (field !== 'gate' || e.type === 'change') rerenderRoll(container, context);
  };

  const onPointerDown = (e) => {
    const resize = e.target.closest('[data-arp-resize]');
    const cell = e.target.closest('[data-arp-cell]');
    const velocity = e.target.closest('[data-arp-velocity]');
    if (resize && cell) {
      const step = Number(cell.dataset.arpStep);
      view.selectedStep = step;
      view.drag = { kind: 'gate', step };
      e.preventDefault();
    } else if (velocity) {
      const step = Number(velocity.dataset.arpVelocity);
      view.selectedStep = step;
      view.drag = { kind: 'velocity', step };
      content().customPattern[step].velocity = velocityFromPointer(e.clientY, velocity.getBoundingClientRect());
      edited();
      e.preventDefault();
    } else if (cell) {
      const step = Number(cell.dataset.arpStep);
      const offset = Number(cell.dataset.arpOffset);
      view.selectedStep = step;
      view.drag = { kind: 'note', step };
      setCustomNote(content(), step, offset);
      edited();
      e.preventDefault();
    } else {
      return;
    }
    if (typeof container.setPointerCapture === 'function') {
      try { container.setPointerCapture(e.pointerId); } catch {}
    }
  };

  const onPointerMove = (e) => {
    const drag = view.drag;
    if (!drag) return;
    const pattern = content().customPattern;
    if (drag.kind === 'velocity') {
      const velocity = container.querySelector(`[data-arp-velocity="${drag.step}"]`);
      if (!velocity) return;
      const next = velocityFromPointer(e.clientY, velocity.getBoundingClientRect());
      if (pattern[drag.step].velocity === next) return;
      pattern[drag.step].velocity = next;
    } else if (drag.kind === 'gate') {
      const source = container.querySelector(
        `[data-arp-cell][data-arp-step="${drag.step}"][data-arp-offset="${pattern[drag.step].semitoneOffset}"]`);
      if (!source) return;
      const last = content().patternLength - 1;
      const rect = source.getBoundingClientRect();
      const units = Math.max(0.05, (e.clientX - rect.left) / Math.max(1, rect.width));
      const cells = Math.max(1, Math.ceil(units));
      const end = Math.min(last, drag.step + cells - 1);
      // Dragged past the last step, the note fills it to the end.
      const fraction = end === last && drag.step + cells - 1 > end
        ? 1
        : Math.max(0.05, Math.min(1, units - (cells - 1)));
      setCustomGateDuration(content(), drag.step, end, fraction);
    } else {
      const hit = (typeof document !== 'undefined' && document.elementFromPoint)
        ? document.elementFromPoint(e.clientX, e.clientY)
        : e.target;
      const cell = hit?.closest?.('[data-arp-cell]');
      if (!cell) return;
      const step = Number(cell.dataset.arpStep);
      const offset = Number(cell.dataset.arpOffset);
      if (step === drag.step && pattern[step].semitoneOffset === offset) return;
      moveCustomNote(content(), drag.step, step, offset);
      drag.step = step;
      view.selectedStep = step;
    }
    edited();
    e.preventDefault();
  };

  const onPointerUp = (e) => {
    if (!view.drag) return;
    view.drag = null;
    if (typeof container.releasePointerCapture === 'function') {
      try { container.releasePointerCapture(e.pointerId); } catch {}
    }
  };

  const onKeyDown = (e) => {
    if (view.selectedStep < 0 || (e.key !== 'Delete' && e.key !== 'Backspace')) return;
    if (e.target.closest('input,select,textarea')) return;
    removeCustomNote(content(), view.selectedStep);
    edited();
    e.preventDefault();
  };

  // The roll and the velocity lane scroll sideways together.
  const onScroll = (e) => {
    const roll = container.querySelector('[data-arp-roll-scroll]');
    const velocity = container.querySelector('[data-arp-velocity-scroll]');
    if (!roll || !velocity) return;
    if (e.target === roll && velocity.scrollLeft !== roll.scrollLeft) velocity.scrollLeft = roll.scrollLeft;
    if (e.target === velocity && roll.scrollLeft !== velocity.scrollLeft) roll.scrollLeft = velocity.scrollLeft;
  };

  const listeners = [
    ['click', onClick],
    ['input', onInput],
    ['change', onInput],
    ['pointerdown', onPointerDown],
    ['pointermove', onPointerMove],
    ['pointerup', onPointerUp],
    ['pointercancel', onPointerUp],
    ['keydown', onKeyDown],
    ['scroll', onScroll, true]
  ];
  for (const [type, listener, capture] of listeners) container.addEventListener(type, listener, capture);

  const offs = [
    hub.events.on('engine:transport', (transport) => {
      const next = transport?.playing
        ? currentArpeggiatorStep(transport.ppqPosition, content().rate, content().patternLength)
        : -1;
      if (next === view.currentStep) return;
      view.currentStep = next;
      updatePlayhead(container, view);
    }),
    followContentWrites(container, hub, instance.id, () => {
      if (manager.get(instance.id)) refresh(container, context);
    })
  ];

  // The page opens on the root note, not at the top of the keyboard.
  updatePlayhead(container, view);
  if (typeof globalThis.requestAnimationFrame === 'function') globalThis.requestAnimationFrame(() => centerRoll(container));
  else centerRoll(container);

  return () => {
    for (const [type, listener, capture] of listeners) container.removeEventListener(type, listener, capture);
    for (const off of offs) off();
  };
}

/** Install the page. Returns its unregister function, as `registerNodeEditor` does. */
export function registerArpeggiatorEditor() {
  return registerNodeEditor('arpeggiator', { render, bind, refresh });
}
