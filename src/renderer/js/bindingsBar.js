/**
 * The bindings bar's page: a window docked under one plugin editor.
 *
 * It draws what the main renderer sends and reports what was clicked, and that
 * is all it does. The markup is `renderControlBindings()`'s, escaped where it was
 * built, in the renderer that owns the bindings; this page holds no binding, no
 * profile and no rule about either. src/main/bindingsBarWindows.js, D-021.
 *
 * Since 2026-09-14 it also shows where each bound parameter stands and lets the
 * mouse move it. Which controls those are is decided in the main renderer: a
 * control is movable here exactly when a position arrives for it.
 */
import { applyMiniLabSurfaceLayout } from './ui/surfaceLayout.js';
import { controlBindingActionOf } from './core/controlBindingActions.js';

const root = document.getElementById('bindings-bar-root');
const api = window.bindingsBarAPI;

// The classes of the drawn controls a drag can move: the ones that turn and the
// ones that slide. Anything else ignores a drag and keeps its click.
const MOVABLE = ['ml-surface-knob', 'ml-main-turn', 'ml-surface-fader', 'ml-strip-control'];
// A knob has no length to follow, so a drag of this many pixels sweeps it from
// one end to the other, about what a plugin's own knobs ask.
const KNOB_TRAVEL_PX = 160;
// Below this a press is a click, and selects the control for Learn.
const DRAG_THRESHOLD_PX = 3;

const values = new Map(); // controlId -> normalized value
let drag = null;
let deferredHtml = null;
let sendQueued = false;

const clamp01 = (value) => Math.min(1, Math.max(0, value));

/**
 * How many columns the strip needs before the one holding the help and the
 * Learn toolbar: one per faceplate and one per keyboard name. The grid reads it
 * from `--bar-columns`, set through the CSSOM because the CSP drops a `style`
 * attribute.
 */
function leadingColumns() {
  return [...root.children]
    .filter((child) => !child.matches('.control-bindings-help:first-child, .control-learn-toolbar'))
    .length;
}

function draw(html) {
  root.innerHTML = html;
  root.style.setProperty('--bar-columns', String(Math.max(1, leadingColumns())));
  applyMiniLabSurfaceLayout(root);
  paintValues();
}

/**
 * The faceplate's scale when the bar stands beside the plugin as a column
 * (base.css reads --bar-zoom only then): the column's width, never more than the
 * strip's scale. Main narrows a column when the screen has less room beside the
 * plugin, and a faceplate drawn at the strip's scale would be cut on the right.
 */
function fitFaceplates() {
  const style = globalThis.getComputedStyle?.(root);
  if (!style) return;
  const drawnWidth = parseFloat(style.getPropertyValue('--faceplate-width'));
  const stripZoom = parseFloat(style.getPropertyValue('--faceplate-zoom'));
  const room = root.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const zoom = Math.min(stripZoom, room / drawnWidth);
  if (Number.isFinite(zoom) && zoom > 0) root.style.setProperty('--bar-zoom', zoom.toFixed(4));
}

/** Put every known position on its control; a control with none is not movable. */
function paintValues() {
  for (const control of root.querySelectorAll('[data-minilab-control-id]')) {
    const value = values.get(control.dataset.minilabControlId);
    const live = Number.isFinite(value) && MOVABLE.some((name) => control.classList.contains(name));
    control.classList.toggle('ml-live', live);
    if (live) control.style.setProperty('--ml-value', value.toFixed(4));
    else control.style.removeProperty('--ml-value');
  }
}

function travelOf(control) {
  // A fader or a strip follows the mouse along its own length.
  const track = control.querySelector('i');
  const length = track?.getBoundingClientRect?.().height;
  return control.classList.contains('ml-surface-knob') || control.classList.contains('ml-main-turn') || !(length > 0)
    ? KNOB_TRAVEL_PX
    : Math.max(24, length);
}

function sendDrag() {
  if (!drag?.moved) return;
  api.action({ kind: 'turn', controlId: drag.controlId, normalizedValue: values.get(drag.controlId) });
}

api.onRender((html) => {
  // A redraw under a dragging mouse replaces the control it holds, and the drag
  // ends there. It waits for the mouse to let go.
  if (drag) {
    deferredHtml = html;
    return;
  }
  draw(html);
});

api.onValues((message) => {
  if (message?.replace === true) {
    const held = drag ? values.get(drag.controlId) : undefined;
    values.clear();
    if (drag && Number.isFinite(held)) values.set(drag.controlId, held);
  }
  for (const [controlId, value] of Object.entries(message?.values ?? {})) {
    // The control under the mouse is where the mouse puts it; what comes back
    // from the plugin while it moves is that same value, a moment late.
    if (drag?.controlId === controlId) continue;
    values.set(controlId, value);
  }
  paintValues();
});

root.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  const control = event.target.closest?.('.ml-live[data-minilab-control-id]');
  if (!control) return;
  const controlId = control.dataset.minilabControlId;
  drag = {
    controlId, control, pointerId: event.pointerId,
    startY: event.clientY, startValue: values.get(controlId), travel: travelOf(control), moved: false
  };
  control.setPointerCapture?.(event.pointerId);
});

root.addEventListener('pointermove', (event) => {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const rise = drag.startY - event.clientY;
  if (!drag.moved && Math.abs(rise) < DRAG_THRESHOLD_PX) return;
  drag.moved = true;
  const value = clamp01(drag.startValue + rise / drag.travel);
  values.set(drag.controlId, value);
  drag.control.style.setProperty('--ml-value', value.toFixed(4));
  // One message per frame at most, whatever the mouse's own rate.
  if (sendQueued) return;
  sendQueued = true;
  requestAnimationFrame(() => {
    sendQueued = false;
    sendDrag();
  });
});

function endDrag(event) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  // The last position is sent whatever the frame did with the others: it is the
  // one the parameter has to end on.
  sendDrag();
  drag = null;
  if (deferredHtml !== null) {
    const html = deferredHtml;
    deferredHtml = null;
    draw(html);
  }
}
root.addEventListener('pointerup', endDrag);
root.addEventListener('pointercancel', endDrag);
root.addEventListener('lostpointercapture', endDrag);

root.addEventListener('click', (event) => {
  const action = controlBindingActionOf(event.target);
  if (action) api.action(action);
});

// Main resizes the window as the plugin moves: under it, beside it, narrower.
globalThis.addEventListener?.('resize', fitFaceplates);
fitFaceplates();

api.ready();
