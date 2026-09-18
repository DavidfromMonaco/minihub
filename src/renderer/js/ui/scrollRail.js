/**
 * The horizontal rail that replaces a native scrollbar, and the one mapping
 * both of its directions read.
 *
 * Chromium's own horizontal scrollbar is a wide light slab under the surface it
 * belongs to, and it was the first thing the author pointed at in the
 * arrangement. This draws the same information as four dark pixels: where you
 * are, how much of the whole you can see, and it is draggable.
 *
 * It lives here rather than in either surface because the Patch Bay's
 * arrangement and the Clip Editor's piano roll both need it, and they are two
 * windows: `clip-editor.html` loads its own script, so importing the sequencer
 * module to reach this would pull the whole hub into a window that has none.
 * Two copies of a mapping that has to be its own inverse is how a thumb starts
 * jumping out from under the pointer that grabbed it.
 */

/** Clear space kept between the rail's edge and the thumb's travel. */
const RAIL_INSET = 3;
/** Under this a thumb is a dot nobody can grab, however little is on screen. */
const RAIL_MIN_SIZE = 22;

/**
 * The rail thumb, and the scroll position a point on the rail asks for.
 *
 * One function for both directions, because they are inverses: drawing the
 * thumb and reading a drag on it have to use the same mapping, or the thumb
 * jumps out from under the pointer that grabbed it. `null` means the whole
 * surface already fits, and a full-width thumb that cannot move is furniture --
 * the rail hides itself instead.
 */
export function railThumb({
  scrollLeft = 0, scrollWidth = 0, clientWidth = 0, railWidth = 0,
  inset = RAIL_INSET, minSize = RAIL_MIN_SIZE
} = {}) {
  const travel = (Number(scrollWidth) || 0) - (Number(clientWidth) || 0);
  if (!(travel > 1) || !(clientWidth > 0) || !(railWidth > 0)) return null;
  const width = Math.max(minSize, railWidth - inset * 2);
  const size = Math.max(minSize, Math.min(width, width * clientWidth / scrollWidth));
  const room = Math.max(1, width - size);
  const ratio = Math.max(0, Math.min(1, scrollLeft / travel));
  return {
    size,
    left: inset + room * ratio,
    scrollFor: (x) => travel * Math.max(0, Math.min(1, (x - inset - size / 2) / room))
  };
}

/**
 * Wire one rail to one scrolling element.
 *
 * `root` is the element the three parts are looked up in, and they are looked
 * up on EVERY call, never held. Both surfaces redraw by replacing their own
 * markup -- the arrangement when the scroll leaves the drawn window, the Clip
 * Editor on any edit -- and a drag started before such a redraw would go on
 * writing to an element that is no longer in the document, where assigning
 * `scrollLeft` does nothing and reports nothing. That is exactly how the
 * arrangement's rail used to stop answering after about a quarter of a screen.
 *
 * `scroller` is the selector of the element being scrolled, because the two
 * surfaces name theirs differently. `positionOf` is for a caller whose own
 * state is the authority on where the view is: `render()` may run on markup
 * that was inserted a moment ago, where `scrollLeft` still reads back zero, and
 * the thumb would then be drawn at the far left of a view sitting in the
 * middle. Left out, the scroller is asked directly.
 */
export function attachScrollRail({ root, scroller, positionOf = null } = {}) {
  const find = (selector) => (root && typeof root.querySelector === 'function'
    ? root.querySelector(selector) : null);

  const geometry = () => {
    const rail = find('[data-scroll-rail]');
    const element = find(scroller);
    if (!rail || !element) return null;
    return {
      rail,
      scroller: element,
      thumb: railThumb({
        scrollLeft: positionOf ? positionOf() : element.scrollLeft,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        railWidth: rail.clientWidth
      })
    };
  };

  /** Draw the thumb, or hide the rail when there is nothing to scroll. */
  function render() {
    const rail = find('[data-scroll-rail]');
    const thumb = find('[data-scroll-rail-thumb]');
    if (!rail || !thumb) return;
    // Laid out BEFORE it is measured. `hidden` collapses the rail to zero
    // width, and deciding whether to show it from that width is a deadlock:
    // hidden, therefore unmeasurable, therefore hidden.
    rail.hidden = false;
    const geo = geometry();
    if (!geo?.thumb) { rail.hidden = true; return; }
    thumb.style.width = `${geo.thumb.size}px`;
    thumb.style.left = `${geo.thumb.left}px`;
  }

  /** A point on the rail, in client coordinates, becomes a scroll position. */
  function seekTo(clientX) {
    const geo = geometry();
    const rect = geo?.rail.getBoundingClientRect?.();
    if (!rect || !geo?.thumb) return;
    geo.rail.classList.add('dragging');
    geo.scroller.scrollLeft = geo.thumb.scrollFor(clientX - rect.left);
  }

  /**
   * Drag the rail, or click a point on it. Both land on the same arithmetic:
   * the thumb's travel maps onto the scroller's.
   *
   * The move and release listeners are on the document, so the pointer may
   * leave the rail -- and so the gesture survives its own repaint, which the
   * seek above is written for.
   */
  function bind() {
    const rail = find('[data-scroll-rail]');
    if (!rail) return;
    rail.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      seekTo(event.clientX);
      const move = (moveEvent) => seekTo(moveEvent.clientX);
      const up = () => {
        find('[data-scroll-rail]')?.classList.remove('dragging');
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        document.removeEventListener('pointercancel', up);
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up, { once: true });
      document.addEventListener('pointercancel', up, { once: true });
    });
  }

  return { render, bind };
}

/** The markup both surfaces insert. One shape, one stylesheet rule. */
export const scrollRailMarkup = () =>
  '<div class="scroll-rail" data-scroll-rail hidden><div class="scroll-rail-thumb" data-scroll-rail-thumb></div></div>';
