/**
 * The navigation bar under a timeline: where you are, how much you see, and
 * the two gestures every workstation puts there -- drag the thumb to travel,
 * drag one of its ends to zoom.
 *
 * It replaced a four-pixel rail that drew the same position and nothing else.
 * That rail was dark grey on a dark panel, hid itself whenever the view fitted,
 * and only moved -- so the author, looking at the arrangement, reported that it
 * had no navigation bar at all, and he was right in every way that counts.
 *
 * The bar works in the surface's own units (quarters for the arrangement and
 * the piano roll, seconds for an audio take), never in scroll pixels. A zoom
 * changes the pixel width of everything, so a mapping written in pixels would
 * slide out from under the hand that is dragging an end. In units, the end you
 * are not holding stays exactly where it was.
 *
 * One file for three surfaces in two windows: `clip-editor.html` loads its own
 * script, and importing the sequencer module to reach this would pull the whole
 * hub into a window that has none.
 */

/** Clear space kept between the track's edge and the thumb's travel. */
const TRACK_INSET = 2;
/** Under this a thumb is a sliver nobody can grab, however little is shown. */
const THUMB_MIN_SIZE = 24;
/** What one press of − or + does: the step Ctrl+wheel already takes. */
export const NAV_ZOOM_STEP = 1.25;

const finite = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

/**
 * Where the thumb is drawn, in pixels from the track's left edge.
 *
 * Linear in units, so that drawing and reading are the same arithmetic. A
 * thumb narrower than `minSize` is widened around its own centre for drawing
 * only -- its ends still mean what they say when dragged, because a drag reads
 * pointer DELTAS in units, never the thumb's drawn width.
 */
export function navThumb({ start = 0, span = 0, total = 0, width = 0, inset = TRACK_INSET, minSize = THUMB_MIN_SIZE } = {}) {
  const room = finite(width) - inset * 2;
  const whole = Math.max(finite(total), finite(start) + finite(span));
  if (!(room > 0) || !(whole > 0) || !(span > 0)) return null;
  let left = room * Math.max(0, finite(start)) / whole;
  let size = Math.min(room, room * span / whole);
  if (size < minSize) {
    const grown = Math.min(room, minSize);
    left = Math.max(0, Math.min(room - grown, left + size / 2 - grown / 2));
    size = grown;
  }
  return { left: inset + left, size };
}

/**
 * The view a drag asks for.
 *
 * `mode` is what was grabbed: `move` the thumb, `start` or `end` one of its
 * ends. `delta` is the pointer's travel since it went down, already converted
 * to units. `from` is the view at that moment -- a drag is measured against
 * where it began, never accumulated move by move, or rounding in the surface
 * would creep into the gesture.
 *
 * An end drag keeps the OTHER end where it was: that is the whole gesture.
 * The span is held between `minSpan` and `maxSpan`, the surface's zoom limits.
 */
export function navDrag(mode, from = {}, delta = 0, { total = 0, minSpan = 0, maxSpan = Infinity } = {}) {
  const start = Math.max(0, finite(from.start));
  const span = Math.max(0, finite(from.span));
  const end = start + span;
  const d = finite(delta);
  const low = Math.max(0, finite(minSpan));
  const high = Math.max(low, finite(maxSpan, Infinity));
  const whole = Math.max(finite(total), end);
  if (mode === 'start') {
    const next = Math.min(end - low, Math.max(0, end - high, start + d));
    return { start: Math.max(0, next), span: end - Math.max(0, next) };
  }
  if (mode === 'end') {
    const nextEnd = Math.max(start + low, Math.min(start + high, end + d));
    return { start, span: nextEnd - start };
  }
  return { start: Math.max(0, Math.min(Math.max(0, whole - span), start + d)), span };
}

/**
 * One step of − or +, around the middle of what is on screen.
 *
 * `factor` above 1 zooms OUT (the span grows). The span is clamped first and
 * the centre kept, so the last press before a limit does not throw the view
 * sideways.
 */
export function navZoom(view = {}, factor = 1, { minSpan = 0, maxSpan = Infinity } = {}) {
  const span = Math.max(0, finite(view.span));
  const centre = Math.max(0, finite(view.start)) + span / 2;
  const next = Math.max(finite(minSpan), Math.min(finite(maxSpan, Infinity), span * finite(factor, 1)));
  return { start: Math.max(0, centre - next / 2), span: next };
}

/**
 * Wire one bar to one surface.
 *
 * `view()` answers `{ start, span, total, minSpan, maxSpan }` in the surface's
 * units, or `null` when there is nothing to show yet. `apply({ start, span })`
 * is the surface doing what was asked: scroll, or zoom and scroll.
 *
 * Every part is looked up through `root` on every call, never held. All three
 * surfaces redraw by replacing their own markup -- a zoom always does -- and a
 * drag that outlived its own repaint would go on writing to an element that
 * has left the document, where nothing it does shows and nothing says so.
 */
export function attachNavigationBar({ root, view, apply } = {}) {
  const find = (selector) => (root && typeof root.querySelector === 'function'
    ? root.querySelector(selector) : null);
  const current = () => {
    const value = typeof view === 'function' ? view() : null;
    return value && finite(value.span) > 0 ? value : null;
  };
  const limits = (value) => ({
    total: finite(value?.total),
    minSpan: finite(value?.minSpan),
    maxSpan: finite(value?.maxSpan, Infinity)
  });

  /** Draw the thumb where the view is. */
  function render() {
    const track = find('[data-nav-track]');
    const thumb = find('[data-nav-thumb]');
    if (!track || !thumb) return;
    const value = current();
    const drawn = value && navThumb({ ...value, width: track.clientWidth });
    thumb.hidden = !drawn;
    if (!drawn) return;
    thumb.style.left = `${drawn.left}px`;
    thumb.style.width = `${drawn.size}px`;
  }

  /**
   * A zoom repaints the whole surface, and a pointer reports far more often
   * than a screen refreshes: the latest request waits for the next frame and
   * the ones before it are dropped. A move is only a scroll, so it goes at once.
   */
  let pending = null;
  let frameQueued = false;
  function request(next, immediate) {
    if (immediate || typeof globalThis.requestAnimationFrame !== 'function') {
      pending = null;
      apply?.(next);
      render();
      return;
    }
    pending = next;
    if (frameQueued) return;
    frameQueued = true;
    globalThis.requestAnimationFrame(() => {
      frameQueued = false;
      const latest = pending;
      pending = null;
      if (latest) { apply?.(latest); render(); }
    });
  }

  /**
   * Press on the track: an end zooms, the thumb travels, anywhere else jumps
   * the thumb's centre to that point and then travels from there -- the way
   * Reaper's and Bitwig's bars answer a click beside the thumb.
   */
  function pointerDown(event) {
    if (event.button !== 0) return;
    const track = find('[data-nav-track]');
    const value = current();
    const width = (track?.clientWidth || 0) - TRACK_INSET * 2;
    if (!track || !value || !(width > 0)) return;
    event.preventDefault();
    const part = event.target?.dataset?.navPart || '';
    const mode = part === 'start' || part === 'end' ? part : 'move';
    const bounds = limits(value);
    // Frozen for the whole gesture. The arrangement's extent grows with the
    // view, and a scale that changed under the drag would move the thumb away
    // from the pointer holding it.
    const total = Math.max(bounds.total, value.start + value.span);
    const unitsPerPx = total / width;
    let from = { start: value.start, span: value.span };
    if (part !== 'thumb' && mode === 'move') {
      const rect = track.getBoundingClientRect?.() || { left: 0 };
      const at = (event.clientX - rect.left - TRACK_INSET) * unitsPerPx;
      from = navDrag('move', { start: at - value.span / 2, span: value.span }, 0, { ...bounds, total });
      request(from, true);
    }
    const x0 = event.clientX;
    track.classList.add('dragging');
    const move = (moveEvent) => {
      request(navDrag(mode, from, (moveEvent.clientX - x0) * unitsPerPx, { ...bounds, total }), mode === 'move');
    };
    const up = () => {
      find('[data-nav-track]')?.classList.remove('dragging');
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up, { once: true });
    document.addEventListener('pointercancel', up, { once: true });
  }

  function zoomBy(factor) {
    const value = current();
    if (value) request(navZoom(value, factor, limits(value)), true);
  }

  /** Called after each repaint of the surface: the bar is new markup too. */
  function bind() {
    find('[data-nav-track]')?.addEventListener('pointerdown', pointerDown);
    find('[data-nav-zoom="out"]')?.addEventListener('click', () => zoomBy(NAV_ZOOM_STEP));
    find('[data-nav-zoom="in"]')?.addEventListener('click', () => zoomBy(1 / NAV_ZOOM_STEP));
  }

  return { render, bind, zoomBy };
}

/**
 * The markup all three surfaces insert. One shape, one stylesheet rule, in
 * `base.css` because the Clip Editor window loads that sheet too.
 *
 * `attributes` lets a surface hang its own data on the bar -- the arrangement
 * and the piano roll use it to line the track up under their timeline rather
 * than under their track heads or keyboard.
 */
export const navigationBarMarkup = (attributes = '') =>
  `<div class="nav-bar" data-nav-bar ${attributes}>`
  + '<div class="nav-track" data-nav-track title="Drag to move through the timeline, drag an end to zoom">'
  + '<div class="nav-thumb" data-nav-thumb data-nav-part="thumb">'
  + '<span class="nav-edge nav-edge-start" data-nav-part="start" aria-hidden="true"></span>'
  + '<span class="nav-edge nav-edge-end" data-nav-part="end" aria-hidden="true"></span>'
  + '</div></div>'
  + '<button type="button" class="nav-zoom" data-nav-zoom="out" title="Zoom out" aria-label="Zoom out">−</button>'
  + '<button type="button" class="nav-zoom" data-nav-zoom="in" title="Zoom in" aria-label="Zoom in">+</button>'
  + '</div>';
