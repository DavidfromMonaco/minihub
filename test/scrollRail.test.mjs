import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, makeEl, fire } from './domShim.mjs';
import { railThumb, attachScrollRail, scrollRailMarkup } from '../src/renderer/js/ui/scrollRail.js';

/**
 * The rail under the arrangement and the one under the piano roll are the same
 * object, in two windows. What this holds is the pair of properties that made
 * it worth having one: the mapping is its own inverse, and a drag survives the
 * repaint it causes.
 */

test('the scroll rail draws and reads one mapping, and hides when everything fits', () => {
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
      `the point the thumb is drawn at asks for the scroll it was drawn from (${scrollLeft})`);
  }
});

/** One surface, rebuilt on demand the way both real ones rebuild themselves. */
function surface({ scrollWidth = 4000, clientWidth = 1000, railWidth = 1000 } = {}) {
  let parts = null;
  const build = () => {
    const scroller = makeEl('div');
    scroller.dataset.pianoScroll = '';
    scroller.scrollLeft = 0;
    scroller.scrollWidth = scrollWidth;
    scroller.clientWidth = clientWidth;
    const rail = makeEl('div');
    rail.dataset.scrollRail = '';
    rail.hidden = true;
    rail.clientWidth = railWidth;
    rail.getBoundingClientRect = () => ({ left: 0, top: 0, width: railWidth, height: 14 });
    const thumb = makeEl('div');
    thumb.dataset.scrollRailThumb = '';
    parts = { scroller, rail, thumb };
  };
  build();
  const root = {
    querySelector: (selector) => {
      if (selector === '[data-scroll-rail]') return parts.rail;
      if (selector === '[data-scroll-rail-thumb]') return parts.thumb;
      if (selector === '[data-piano-scroll]') return parts.scroller;
      return null;
    }
  };
  return { root, repaint: build, parts: () => parts };
}

test('the rail draws itself, and stands down when the whole surface fits', () => {
  installDom();
  const wide = surface();
  const rail = attachScrollRail({ root: wide.root, scroller: '[data-piano-scroll]' });
  rail.render();
  assert.equal(wide.parts().rail.hidden, false, 'there is something to scroll, so the rail is there');
  assert.equal(wide.parts().thumb.style.width, '248.5px');

  const fits = surface({ scrollWidth: 900 });
  attachScrollRail({ root: fits.root, scroller: '[data-piano-scroll]' }).render();
  assert.equal(fits.parts().rail.hidden, true, 'and nothing to scroll means no rail at all');
});

test('a drag on the rail survives the repaint it triggers', () => {
  installDom();
  const view = surface();
  const rail = attachScrollRail({ root: view.root, scroller: '[data-piano-scroll]' });
  rail.render();
  rail.bind();

  const stale = view.parts();
  // Right of the thumb's half-width, or the mapping clamps at zero and the
  // grab proves nothing.
  fire(stale.rail, 'pointerdown', { button: 0, clientX: 200 });
  const grabbed = stale.scroller.scrollLeft;
  assert.ok(grabbed > 0, 'grabbing the rail scrolls to the point grabbed');
  assert.ok(stale.rail._classSet.has('dragging'), 'and the rail says it is being dragged');

  // Both surfaces redraw by replacing their own markup, and a drag in flight
  // holds nothing: its listeners are on the document, and every element is
  // looked up again on each move. Writing to the element a pointerdown saw
  // does nothing once it has left the document, and reports nothing either.
  view.repaint();
  fire(globalThis.document, 'pointermove', { clientX: 500 });

  const expected = railThumb({ scrollLeft: 0, scrollWidth: 4000, clientWidth: 1000, railWidth: 1000 })
    .scrollFor(500);
  assert.ok(Math.abs(view.parts().scroller.scrollLeft - expected) < 1,
    `the live surface follows the thumb (${view.parts().scroller.scrollLeft} vs ${expected})`);
  assert.equal(stale.scroller.scrollLeft, grabbed, 'and the one that was thrown away is left alone');

  fire(globalThis.document, 'pointerup', {});
  assert.equal(view.parts().rail._classSet.has('dragging'), false, 'the release clears the live rail');
});

test('both surfaces insert the same rail', () => {
  const markup = scrollRailMarkup();
  assert.match(markup, /data-scroll-rail\b/);
  assert.match(markup, /data-scroll-rail-thumb/);
  // Hidden until something measures it: an unmeasured rail that shows is a
  // grey bar under a surface that has nothing to scroll.
  assert.match(markup, /hidden/);
});
