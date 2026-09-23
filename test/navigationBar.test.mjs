import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, makeEl, fire } from './domShim.mjs';
import {
  navThumb, navDrag, navZoom, attachNavigationBar, navigationBarMarkup, NAV_ZOOM_STEP
} from '../src/renderer/js/ui/navigationBar.js';
import { formatSeconds, secondsMarks, secondsStride } from '../src/renderer/js/ui/secondsRuler.js';

/**
 * The bar under the arrangement, the piano roll and an audio take is one
 * object in two windows. What this holds: the thumb is a picture of the view,
 * dragging it travels, dragging an end zooms with the other end held still,
 * and a gesture survives the repaint it causes.
 */

test('the thumb is drawn where the view is, and never too thin to grab', () => {
  const whole = navThumb({ start: 0, span: 100, total: 100, width: 504 });
  assert.equal(whole.left, 2, 'the whole view fills the track, inside its inset');
  assert.equal(whole.size, 500);

  const quarter = navThumb({ start: 50, span: 25, total: 100, width: 504 });
  assert.equal(quarter.left, 2 + 250);
  assert.equal(quarter.size, 125);

  const sliver = navThumb({ start: 50, span: 0.1, total: 100, width: 504, minSize: 24 });
  assert.equal(sliver.size, 24, 'a tiny view still draws a thumb a hand can find');
  assert.ok(Math.abs(sliver.left + sliver.size / 2 - (2 + 250.25)) < 0.01, 'grown around its own centre');

  const past = navThumb({ start: 90, span: 20, total: 100, width: 504 });
  assert.ok(Math.abs(past.left + past.size - 502) < 0.01, 'a view past the end sits at the end instead of leaving the track');

  assert.equal(navThumb({ start: 0, span: 10, total: 100, width: 0 }), null, 'an unmeasured track draws nothing');
});

test('dragging the thumb travels; dragging an end zooms and holds the other end', () => {
  const from = { start: 10, span: 20 };
  const limits = { total: 100, minSpan: 1, maxSpan: 100 };

  assert.deepEqual(navDrag('move', from, 5, limits), { start: 15, span: 20 });
  assert.deepEqual(navDrag('move', from, -50, limits), { start: 0, span: 20 }, 'not before the start');
  assert.deepEqual(navDrag('move', from, 500, limits), { start: 80, span: 20 }, 'not past the end');

  const left = navDrag('start', from, 5, limits);
  assert.deepEqual(left, { start: 15, span: 15 }, 'pulling the left end in zooms in');
  assert.equal(left.start + left.span, 30, 'and the right end has not moved');
  const leftOut = navDrag('start', from, -8, limits);
  assert.equal(leftOut.start + leftOut.span, 30, 'pushing it out zooms out around the same right end');

  const right = navDrag('end', from, -10, limits);
  assert.deepEqual(right, { start: 10, span: 10 }, 'the right end moves, the left stays');

  assert.equal(navDrag('end', from, -100, limits).span, 1, 'never narrower than the deepest zoom');
  assert.equal(navDrag('start', from, 100, limits).span, 1);
  assert.equal(navDrag('end', from, 500, { ...limits, maxSpan: 40 }).span, 40, 'never wider than the widest');
});

test('− and + step around the middle of the view, within the limits', () => {
  const out = navZoom({ start: 40, span: 20 }, 2, { minSpan: 1, maxSpan: 100 });
  assert.deepEqual(out, { start: 30, span: 40 });
  const inside = navZoom({ start: 40, span: 20 }, 0.5, { minSpan: 1, maxSpan: 100 });
  assert.deepEqual(inside, { start: 45, span: 10 });
  assert.equal(navZoom({ start: 0, span: 20 }, 0.001, { minSpan: 4 }).span, 4);
  assert.equal(navZoom({ start: 2, span: 20 }, 10, { maxSpan: 50 }).start, 0, 'never before the start');
});

/**
 * A surface in units, rebuilt on demand the way all three rebuild themselves.
 * The view is the surface's own state; `apply` writes it back.
 */
function surface({ width = 504, total = 100, start = 0, span = 25 } = {}) {
  let parts = null;
  const state = { start, span, applied: [] };
  const build = () => {
    const track = makeEl('div');
    track.dataset.navTrack = '';
    track.clientWidth = width;
    track.getBoundingClientRect = () => ({ left: 0, top: 0, width, height: 14 });
    const thumb = makeEl('div');
    thumb.dataset.navThumb = '';
    thumb.dataset.navPart = 'thumb';
    const startEdge = makeEl('span');
    startEdge.dataset.navPart = 'start';
    const endEdge = makeEl('span');
    endEdge.dataset.navPart = 'end';
    const zoomOut = makeEl('button');
    const zoomIn = makeEl('button');
    parts = { track, thumb, startEdge, endEdge, zoomOut, zoomIn };
  };
  build();
  const root = {
    querySelector: (selector) => ({
      '[data-nav-track]': parts.track,
      '[data-nav-thumb]': parts.thumb,
      '[data-nav-zoom="out"]': parts.zoomOut,
      '[data-nav-zoom="in"]': parts.zoomIn
    })[selector] ?? null
  };
  const bar = attachNavigationBar({
    root,
    view: () => ({ start: state.start, span: state.span, total, minSpan: 1, maxSpan: 200 }),
    apply: (next) => {
      state.applied.push(next);
      state.start = next.start;
      state.span = next.span;
      // Every surface repaints on a zoom, bar included.
      build();
      bar.bind();
    }
  });
  return { bar, state, parts: () => parts, repaint: () => { build(); bar.bind(); } };
}

test('pressing beside the thumb jumps there, then the drag travels from it', () => {
  installDom();
  globalThis.requestAnimationFrame = undefined;
  const view = surface();
  view.bar.render();
  view.bar.bind();
  assert.equal(view.parts().thumb.style.width, '125px');

  // 2px inset, 500px for 100 units: x=302 is unit 60, so a 25-unit thumb
  // centred there starts at 47.5.
  fire(view.parts().track, 'pointerdown', { button: 0, clientX: 302, target: view.parts().track });
  assert.equal(view.state.start, 47.5, 'the thumb is centred on the point pressed');
  fire(globalThis.document, 'pointermove', { clientX: 312 });
  assert.equal(view.state.start, 49.5, 'and ten pixels of travel are two units');
  assert.equal(view.state.span, 25, 'a move never zooms');
  fire(globalThis.document, 'pointerup', {});
});

test('grabbing the thumb does not jump it', () => {
  installDom();
  globalThis.requestAnimationFrame = undefined;
  const view = surface({ start: 10 });
  view.bar.render();
  view.bar.bind();
  fire(view.parts().track, 'pointerdown', { button: 0, clientX: 120, target: view.parts().thumb });
  assert.equal(view.state.applied.length, 0, 'a grab is not a request');
  fire(globalThis.document, 'pointermove', { clientX: 145 });
  assert.equal(view.state.start, 15);
  fire(globalThis.document, 'pointerup', {});
});

test('an end drag zooms, and survives the repaint every zoom causes', () => {
  installDom();
  globalThis.requestAnimationFrame = undefined;
  const view = surface({ start: 20, span: 40 });
  view.bar.render();
  view.bar.bind();
  const stale = view.parts();
  fire(stale.track, 'pointerdown', { button: 0, clientX: 300, target: stale.endEdge });
  fire(globalThis.document, 'pointermove', { clientX: 250 });
  assert.deepEqual(view.state.applied.at(-1), { start: 20, span: 30 }, 'the right end came in by ten units');
  assert.notEqual(view.parts(), stale, 'the surface was rebuilt under the drag');

  // Measured from where the gesture began, not accumulated: a second move to
  // the same place asks for the same view.
  fire(globalThis.document, 'pointermove', { clientX: 200 });
  fire(globalThis.document, 'pointermove', { clientX: 250 });
  assert.deepEqual(view.state.applied.at(-1), { start: 20, span: 30 });
  assert.equal(view.parts().thumb.style.width, '150px', 'the live thumb is redrawn, not the one thrown away');

  fire(globalThis.document, 'pointerup', {});
  fire(globalThis.document, 'pointermove', { clientX: 400 });
  assert.deepEqual(view.state.applied.at(-1), { start: 20, span: 30 }, 'the release ends the gesture');
});

test('− and + zoom around the middle of what is shown', () => {
  installDom();
  globalThis.requestAnimationFrame = undefined;
  const view = surface({ start: 40, span: 20 });
  view.bar.render();
  view.bar.bind();
  fire(view.parts().zoomIn, 'click', {});
  assert.equal(view.state.span, 20 / NAV_ZOOM_STEP);
  assert.equal(view.state.start + view.state.span / 2, 50, 'the middle stays the middle');
  fire(view.parts().zoomOut, 'click', {});
  assert.ok(Math.abs(view.state.span - 20) < 1e-9);
});

test('a zoom drag asks once per frame, and the last position wins', async () => {
  installDom();
  const view = surface({ start: 20, span: 40 });
  view.bar.render();
  view.bar.bind();
  fire(view.parts().track, 'pointerdown', { button: 0, clientX: 300, target: view.parts().startEdge });
  fire(globalThis.document, 'pointermove', { clientX: 310 });
  fire(globalThis.document, 'pointermove', { clientX: 320 });
  assert.equal(view.state.applied.length, 0, 'nothing yet: the frame has not come');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(view.state.applied.length, 1, 'one repaint for two moves');
  assert.deepEqual(view.state.applied[0], { start: 24, span: 36 });
  fire(globalThis.document, 'pointerup', {});
});

test('all three surfaces insert the same bar, with both ends and both buttons', () => {
  const markup = navigationBarMarkup('data-seq-head="260"');
  assert.match(markup, /data-nav-track/);
  assert.match(markup, /data-nav-thumb data-nav-part="thumb"/);
  assert.match(markup, /data-nav-part="start"/);
  assert.match(markup, /data-nav-part="end"/);
  assert.match(markup, /data-nav-zoom="out"/);
  assert.match(markup, /data-nav-zoom="in"/);
  assert.match(markup, /data-seq-head="260"/);
  assert.doesNotMatch(markup, /style=/, 'nothing the CSP would drop');
});

test('the audio ruler goes as fine as the zoom, and prints a clock', () => {
  assert.equal(secondsStride(1000), 0.1, 'a millisecond per pixel: a mark every tenth');
  assert.equal(secondsStride(4000), 0.02);
  assert.equal(secondsStride(5), 15);
  assert.equal(formatSeconds(59.96, 0.1), '1:00.0', 'rounded before it is split');
  assert.equal(formatSeconds(83.25, 0.05), '1:23.25');
  assert.equal(formatSeconds(83.25, 1), '1:23');
  assert.deepEqual(secondsMarks(0.95, 1.31, 0.1).map((value) => value.toFixed(2)), ['1.00', '1.10', '1.20', '1.30']);
  assert.deepEqual(secondsMarks(-5, 2, 1), [0, 1, 2], 'nothing before the start of the file');
});
