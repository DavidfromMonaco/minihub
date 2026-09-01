export const TEMPO_MIN = 20;
export const TEMPO_MAX = 300;

export function normalizeTempo(value, fallback = 120) {
  const numeric = Number(value);
  const safeFallback = Number.isFinite(Number(fallback)) ? Number(fallback) : 120;
  return Math.max(TEMPO_MIN, Math.min(TEMPO_MAX,
    Math.round(Number.isFinite(numeric) ? numeric : safeFallback)));
}

/**
 * Keep ordinary number-input editing while adding a right-button vertical drag.
 * The gesture owns the context menu and document listeners only for its lifetime.
 */
export function bindTempoInput(input, onTempo, { pixelsPerBpm = 3 } = {}) {
  if (!input || typeof onTempo !== 'function') return () => {};
  const documentTarget = input.ownerDocument || globalThis.document;
  const sensitivity = Math.max(1, Number(pixelsPerBpm) || 3);
  let drag = null;

  const commit = (value) => {
    const next = normalizeTempo(value, input.value);
    input.value = String(next);
    onTempo(next);
    return next;
  };
  const change = () => commit(input.value);
  const contextMenu = (event) => event.preventDefault();
  const pointerMove = (event) => {
    if (!drag) return;
    event.preventDefault();
    drag.remainder += drag.lastY - event.clientY;
    drag.lastY = event.clientY;
    const steps = drag.remainder < 0
      ? Math.ceil(drag.remainder / sensitivity)
      : Math.floor(drag.remainder / sensitivity);
    if (!steps) return;
    drag.remainder -= steps * sensitivity;
    commit(Number(input.value) + steps);
  };
  const finishDrag = (event) => {
    if (!drag) return;
    if (event) event.preventDefault();
    input.releasePointerCapture?.(drag.pointerId);
    drag = null;
    delete input.dataset.tempoDragging;
    documentTarget?.removeEventListener?.('pointermove', pointerMove);
    documentTarget?.removeEventListener?.('pointerup', finishDrag);
    documentTarget?.removeEventListener?.('pointercancel', finishDrag);
  };
  const pointerDown = (event) => {
    if (event.button !== 2) return;
    event.preventDefault();
    finishDrag();
    drag = { pointerId: event.pointerId, lastY: event.clientY, remainder: 0 };
    input.dataset.tempoDragging = 'true';
    input.setPointerCapture?.(event.pointerId);
    documentTarget?.addEventListener?.('pointermove', pointerMove);
    documentTarget?.addEventListener?.('pointerup', finishDrag);
    documentTarget?.addEventListener?.('pointercancel', finishDrag);
  };

  input.addEventListener('change', change);
  input.addEventListener('pointerdown', pointerDown);
  input.addEventListener('contextmenu', contextMenu);
  return () => {
    finishDrag();
    input.removeEventListener('change', change);
    input.removeEventListener('pointerdown', pointerDown);
    input.removeEventListener('contextmenu', contextMenu);
  };
}
