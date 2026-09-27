import { escapeHtml } from '../../core/html.js';
import { attachNavigationBar, navigationBarMarkup } from '../../ui/navigationBar.js';
import { SEQUENCER_LIMITS, SNAP_STEPS, ZOOM_MAX, ZOOM_MIN, snapPpq, snapStep, TRACK_HEIGHTS, trackHeightOf } from '../../core/sequencerModel.js';
import { FADE_SHAPES, fadeGain, fadePaths, fadeShapeIcon } from '../../core/fades.js';
import { bindTempoInput } from '../../core/tempoControl.js';
import { isCanonicalMidiIngress } from '../../core/sequencerController.js';
import { closeContextMenu, openContextMenu } from '../../ui/contextMenu.js';
import { sequencerCommands } from '../../core/sequencerCommands.js';
import { STRIDES } from '../../ui/secondsRuler.js';
import { dbToGain, formatGainDb, formatPan, gainToDb } from '../../core/stripValues.js';
import { paneHasKeys } from '../../ui/interfaceLayout.js';
import { createInstrumentTrack, instrumentPlugins, openPluginWhenReady, trackPlugin } from '../../core/instrumentTrack.js';
import { icon } from '../../ui/icons.js';
import {
  COMMON_TIME, SIGNATURE_DENOMINATORS, SIGNATURE_NUMERATOR_MAX, formatSignature, loopBars, loopRangeFromBars,
  asRegions, barLabelStride, meterBarAt, meterBarPpq, meterRegionAt, meterSnap, meterSpans, normalizeSignature, quartersPerBar,
  quartersPerBeat
} from '../../core/musicalTime.js';

/**
 * The two numbers that decide how much arrangement fits on a screen.
 *
 * They were 360 and 140, and the height was not the clip's fault: the track
 * header held five rows -- buttons, name, Input, Destination, Level, route
 * summary -- and the lane was sized by whatever the header needed. A 62 px
 * clip sat in a 140 px lane, so 71 px of every track was empty, always. Six
 * tracks filled a screen; other workstations show twice that.
 *
 * 64 and 260 are what is left once routing moves off the track and into the
 * toolbar inspector: two rows, the performance controls only. Thirteen tracks
 * fit where six did.
 *
 * They are read by the clip geometry, the loop range, the playhead and the
 * drag preview, and `base.css` reads the header width back through
 * `--seq-head` -- `.seq-corner` used to spell 360 and `.seq-empty` 250, which
 * is three sources for one measurement and one of them already wrong.
 */
const TRACK_HEADER = 260;
const TRACK_HEIGHT = TRACK_HEIGHTS.base;
// How much one notch of Alt+wheel grows or shrinks the selected track (D-068).
const TRACK_HEIGHT_STEP = 16;

/**
 * Where each track's row starts, from the top of the canvas, and the total:
 * the selected track may be taller than the others (D-068). Exported for
 * the tests.
 */
export function trackLayout(state) {
  const tops = [];
  let y = HEAD_HEIGHT;
  for (const track of state.tracks) {
    tops.push(y);
    y += trackHeightOf(state, track.id);
  }
  return { tops, bottom: state.tracks.length ? y : HEAD_HEIGHT + TRACK_HEIGHT };
}

/** The index of the track row at `y` on the canvas, -1 above, length below. */
function trackIndexAt(layout, y) {
  if (y < HEAD_HEIGHT) return -1;
  let index = 0;
  while (index + 1 < layout.tops.length && layout.tops[index + 1] <= y) index += 1;
  return y >= layout.bottom ? layout.tops.length : index;
}
const RULER_HEIGHT = 30;

/** The metronome's two keys: its mode, the key's label, and its tooltip. */
const METRONOME_KEYS = Object.freeze([
  ['rec', 'Rec', 'Clicks during a take and its count-in only'],
  ['play-rec', 'Play + Rec', 'Clicks whenever the transport runs']
]);

/** What a take does to the clips already on its track (D-063). */
const RECORD_MODE_KEYS = Object.freeze([
  ['overdub', 'Overdub', 'A take adds to what the track holds: notes into the clip they are played over, sound laid over sound. Round a loop, every pass adds up'],
  ['replace', 'Replace', 'A take replaces what it goes over. Round a loop, the last pass played is kept']
]);
/**
 * The clock ruler, above the bars.
 *
 * Shorter than the bar ruler because it answers a different question and is
 * read less often: the bars are where you work, the minutes are where you are
 * in the piece. 18px holds a 10px label with room above and below.
 */
const TIME_RULER_HEIGHT = 18;
/**
 * Everything in the arrangement hangs below both rulers.
 *
 * Named, because it is the offset of the tracks, of the playhead, of the loop
 * range, of the empty-state line, of the canvas height and of the marquee's
 * track arithmetic -- six places that must agree, and that all used to spell
 * `RULER_HEIGHT` when there was one row. `base.css` reads the two heights back
 * through `--seq-time-ruler` and `--seq-bar-ruler`, so the corner and the
 * marks cannot disagree with them either.
 */
const HEAD_HEIGHT = TIME_RULER_HEIGHT + RULER_HEIGHT;
const TIMELINE_BEATS = 256;

/**
 * Where the timeline must scroll so the playhead stays on screen.
 *
 * Returns `null` when the playhead is already comfortably inside the viewport,
 * so a running transport does not rewrite `scrollLeft` sixty times a second.
 *
 * The playhead is parked at `LEAD` of the viewport rather than centred: during
 * a take what matters is the bars you are about to play, so the empty side of
 * the screen belongs ahead of the cursor, not behind it. A jump backwards (a
 * seek, a loop wrap) lands on the same rule, which is what keeps the two cases
 * from needing two behaviours.
 */
const FOLLOW_MARGIN = 0.12;
const FOLLOW_LEAD = 0.18;

/**
 * How far right the timeline reaches.
 *
 * It used to be the content and nothing else: `max(64 bars, last clip + 4
 * bars)`. That is a timeline that ends, and a workstation's does not -- you
 * drop a clip at bar 200 of an empty arrangement because that is where the
 * second half starts, and every DAW lets you, because the arrangement extends
 * ahead of the view rather than behind the music.
 *
 * So: always a screenful of empty bars past the right edge of what you are
 * looking at. Scrolling right therefore never reaches an end, which is the
 * point; the rail's thumb shrinks as you travel, which is the price and what
 * Reaper's does too. Rounded up to a whole bar -- `barPpq`, the signature's --
 * so the ruler's last mark is a bar and not a fraction of one, and so the
 * width does not change by a pixel-and-a-half on every scroll event.
 *
 * `Fit` deliberately does NOT use this -- it frames `compositionEndPpq()`,
 * the music. Framing the empty room ahead would zoom out for nothing.
 */
export function timelineEndPpq({ minimumPpq = 0, contentEndPpq = 0, scrollPpq = 0, viewportPpq = 0, barPpq = 4 } = {}) {
  const bar = Number(barPpq) > 0 ? Number(barPpq) : 4;
  const ahead = Math.max(0, scrollPpq) + Math.max(0, viewportPpq) * 2;
  const wanted = Math.max(minimumPpq, contentEndPpq + 16, ahead);
  return Math.ceil(Math.max(bar, wanted) / bar) * bar;
}

/**
 * Whether the view has scrolled far enough that the drawn clips no longer
 * cover it and the lanes have to be repainted.
 *
 * A quarter of a screen of slack on each side: repainting exactly at the edge
 * would repaint on every other scroll event, and repainting too late shows a
 * band of empty lane before the clips arrive.
 */
export function outsideDrawnWindow(scrollPpq, { startPpq = 0, endPpq = 0, viewportPpq = 0 } = {}) {
  // A window of no width has drawn nothing, so everything is outside it.
  if (!(endPpq > startPpq)) return true;
  const margin = Math.max(0, viewportPpq) * 0.25;
  // A window drawn from the very start has nothing more to draw before it.
  // Without this, at the start of the timeline -- where a project opens --
  // every scroll event repainted the page, the vertical ones too: the
  // repaint replaced the scrolling element under the wheel, and the tracks
  // would not scroll (the author, 2026-09-27).
  const beforeStart = startPpq > 0 && scrollPpq < startPpq + margin;
  return beforeStart || scrollPpq + viewportPpq > endPpq - margin;
}

/**
 * The vertical scroll that brings one track row fully into view.
 *
 * Returns the scroll unchanged when the row is already whole on screen: a
 * reveal that scrolls anyway would drag the arrangement under the hand every
 * time a track is touched.
 *
 * `stickyTop` is the ruler, which floats over the first pixels of the
 * scrolling area -- a row scrolled to the very top would sit underneath it.
 */
export function revealScrollTop({ top = 0, height = 0, scrollTop = 0, viewHeight = 0, stickyTop = 0 } = {}) {
  const current = Math.max(0, scrollTop);
  if (!(viewHeight > 0)) return current;
  const above = top - stickyTop;
  if (above < current) return Math.max(0, above);
  const below = top + height - viewHeight;
  if (below > current) return Math.max(0, below);
  return current;
}

export function followScrollPpq(playheadPpq, scrollPpq, viewportPpq) {
  const head = Number(playheadPpq);
  const left = Math.max(0, Number(scrollPpq) || 0);
  const width = Number(viewportPpq);
  if (!Number.isFinite(head) || !Number.isFinite(width) || width <= 0) return null;
  const margin = width * FOLLOW_MARGIN;
  if (head >= left + margin && head <= left + width - margin) return null;
  return Math.max(0, head - width * FOLLOW_LEAD);
}

/**
 * The zoom that makes a span of music fill the width available to it.
 *
 * The control that existed was a raw pixels-per-quarter slider, and that is
 * the wrong handle: nobody knows what 96 px per quarter frames. What is asked
 * of a timeline is two things -- show me all of it, show me this bit -- and
 * both are this one line of arithmetic. `null` when the request is
 * meaningless, so a caller never divides by a viewport it does not have yet.
 *
 * `padding` keeps a sliver of air on each side: a clip flush against the edge
 * of the screen reads as a clip that continues off it.
 */
export function frameSpan({ startPpq = 0, endPpq = 0 } = {}, viewportPx, { padding = 0.02 } = {}) {
  const start = Math.max(0, Number(startPpq) || 0);
  const span = (Number(endPpq) || 0) - start;
  const width = Number(viewportPx);
  if (!Number.isFinite(span) || span <= 0 || !Number.isFinite(width) || width <= 0) return null;
  const zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(width * (1 - padding * 2) / span * 100) / 100));
  const air = width * padding / zoom;
  return { zoom, scrollPpq: Math.max(0, start - air) };
}

/**
 * The zoom slider, on a logarithmic scale.
 *
 * The range is now 1 to 240 px per quarter, because "fit the whole
 * arrangement" needs the low end. Linear over a 240-fold range puts everything
 * useful in the first two pixels of travel and makes the rest
 * indistinguishable; a constant ratio per pixel is what a zoom control wants.
 */
const ZOOM_SLIDER_STEPS = 100;
export const zoomToSlider = (zoom) => {
  const value = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Number(zoom) || ZOOM_MIN));
  return Math.round(ZOOM_SLIDER_STEPS * Math.log(value / ZOOM_MIN) / Math.log(ZOOM_MAX / ZOOM_MIN));
};
export const sliderToZoom = (value) => {
  const step = Math.max(0, Math.min(ZOOM_SLIDER_STEPS, Number(value) || 0));
  return Math.round(ZOOM_MIN * (ZOOM_MAX / ZOOM_MIN) ** (step / ZOOM_SLIDER_STEPS) * 100) / 100;
};

/**
 * Which clips a rubber band covers.
 *
 * Expressed in musical coordinates rather than pixels, so it is the same
 * question whatever the zoom -- and so it can be tested without a DOM. Any
 * overlap counts, in either direction, and a band of zero width still covers
 * whatever it passes through: what protects a plain click on empty lane space
 * is the three-pixel threshold in `marqueeMove`, not this geometry.
 */
export function clipsInSpan(tracks, { startPpq = 0, endPpq = 0, fromTrack = 0, toTrack = 0 } = {}) {
  const left = Math.min(startPpq, endPpq);
  const right = Math.max(startPpq, endPpq);
  const first = Math.min(fromTrack, toTrack);
  const last = Math.max(fromTrack, toTrack);
  const ids = [];
  (Array.isArray(tracks) ? tracks : []).forEach((track, index) => {
    if (index < first || index > last) return;
    for (const clip of track.clips) {
      if (clip.startPpq + clip.lengthPpq > left && clip.startPpq < right) ids.push(clip.id);
    }
  });
  return ids;
}

// The renderer CSP deliberately rejects inline style attributes. Keep dynamic
// layout values as inert data attributes, then apply them through the CSSOM.
function applyDynamicStyles(root) {
  const pixelProperties = {
    seqLeft: 'left',
    seqTop: 'top',
    seqWidth: 'width',
    seqHeight: 'height',
    seqBottom: 'bottom'
  };
  root.querySelectorAll('[data-seq-left],[data-seq-top],[data-seq-width],[data-seq-height],[data-seq-bottom]').forEach((element) => {
    for (const [key, property] of Object.entries(pixelProperties)) {
      if (element.dataset[key] !== undefined) element.style[property] = `${Number(element.dataset[key]) || 0}px`;
    }
  });
  root.querySelectorAll('[data-seq-left-pct]').forEach((element) => { element.style.left = `${Number(element.dataset.seqLeftPct) || 0}%`; });
  root.querySelectorAll('[data-seq-width-pct]').forEach((element) => { element.style.width = `${Number(element.dataset.seqWidthPct) || 0}%`; });
  root.querySelectorAll('[data-seq-height-pct]').forEach((element) => { element.style.height = `${Number(element.dataset.seqHeightPct) || 0}%`; });
  root.querySelectorAll('[data-seq-bottom-pct]').forEach((element) => { element.style.bottom = `${Number(element.dataset.seqBottomPct) || 0}%`; });
  // Lengths the stylesheet needs but must not spell itself. `.seq-corner` and
  // `.seq-empty` both need the header width and used to hold it themselves, in
  // two different values; the two ruler heights are the same trap, now that
  // there are two rows and the corner has to cover both.
  const customProperties = {
    seqBeat: '--seq-beat',
    seqBar: '--seq-bar',
    seqHead: '--seq-head',
    seqTimeRuler: '--seq-time-ruler',
    seqBarRuler: '--seq-bar-ruler'
  };
  for (const [key, property] of Object.entries(customProperties)) {
    root.querySelectorAll(`[data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}]`)
      .forEach((element) => { element.style.setProperty(property, `${Number(element.dataset[key]) || 0}px`); });
  }
}

const options = (items, selected, empty = '— Select —') => {
  const available = items.some((item) => item.id === selected);
  const unavailable = selected && !available
    ? '<option value="" selected>Unavailable selection — choose again</option>'
    : '';
  return `<option value="">${escapeHtml(empty)}</option>${unavailable}${items.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === selected ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}`;
};

function waveform(peaks) {
  const values = Array.isArray(peaks) && peaks.length ? peaks : [0.15, 0.35, 0.6, 0.3, 0.75, 0.45, 0.2, 0.55];
  return values.map((peak, index) => {
    const x = index * 100 / values.length;
    const h = Math.max(4, Number(peak) * 84);
    return `<i data-seq-left-pct="${x}" data-seq-height-pct="${h}"></i>`;
  }).join('');
}

/**
 * The narrowest a clip may be drawn.
 *
 * It was 12 px, which is a lie at the bottom of the zoom range: on a 16 px
 * bar a 1/16 clip would draw three beats wide. Three pixels is hard to grab
 * and that is accepted -- at a zoom where a clip is three pixels you are
 * reading the arrangement, not editing it, and the context menu and the
 * keyboard are what act on it there.
 */
const CLIP_MIN_PX = 3;

/**
 * What is drawn inside a clip: its notes, or its waveform.
 *
 * The note marks are placed in **pixels from the clip's left edge**, and they
 * used to be placed in percentages of its width. That was the bug: resizing a
 * clip changes `element.style.width` during the drag, every percentage
 * re-resolves against the new width, and the notes stretched like rubber while
 * the pointer moved — a purely visual lie, since nothing had moved in the
 * model. Pixels do not re-resolve.
 *
 * Exported through `renderDragPreview` as well, which rebuilds this during a
 * resize: the pitch of a note does not move, but which part of the source the
 * clip shows does, and only a rebuild can follow that.
 */
function clipContent(track, clip, zoom) {
  if (track.type !== 'midi') return `<span class="seq-waveform">${waveform(clip.peaks)}</span>`;
  const sourceOffset = Number(clip.sourceOffsetPpq) || 0;
  const sourceEnd = sourceOffset + clip.lengthPpq;
  return `<span class="seq-midi-preview">${controlLinesMarkup(clip, zoom)}${clip.notes
    .filter((note) => note.startPpq + note.durationPpq > sourceOffset && note.startPpq < sourceEnd)
    .map((note) => {
      const visibleStart = Math.max(sourceOffset, note.startPpq);
      const visibleEnd = Math.min(sourceEnd, note.startPpq + note.durationPpq);
      return `<i data-seq-left="${(visibleStart - sourceOffset) * zoom}" data-seq-width="${Math.max(1, (visibleEnd - visibleStart) * zoom)}" data-seq-bottom-pct="${Math.max(2, (note.pitch - 24) / 104 * 70)}"></i>`;
    }).join('')}</span>`;
}

/**
 * A track's automation (D-065): each lane a line across the whole lane, over
 * its clips, high where the parameter is high -- the line the author asked
 * for, the knob's gesture seen along the song. Before the first point and
 * after the last, the value held. Exported for the tests.
 */
export function automationMarkup(track, zoom, width) {
  const lanes = (Array.isArray(track.automation) ? track.automation : []).filter((lane) => lane.points?.length);
  if (!lanes.length) return '';
  const right = Math.max(1, Math.round(width));
  const y = (value) => ((1 - value) * 100).toFixed(1);
  const paths = lanes.map((lane) => {
    const points = lane.points.map((point) => `${(point.ppq * zoom).toFixed(1)} ${y(point.value)}`);
    return `<path d="M0 ${y(lane.points[0].value)} L${points.join(' L')} L${right} ${y(lane.points[lane.points.length - 1].value)}"/>`;
  }).join('');
  return `<svg class="seq-automation" data-seq-width="${right}" viewBox="0 0 ${right} 100" preserveAspectRatio="none" aria-hidden="true">${paths}</svg>`;
}

/**
 * The controller moves a MIDI clip keeps (D-064), one stepped line per
 * controller behind its notes: enough to see that a take kept the wheel or
 * the pedal, and where it moved. A key's own pressure is left out, as it is
 * of a chase -- it belongs to its note. Exported for the tests.
 */
export function controlLinesMarkup(clip, zoom) {
  const offset = Number(clip.sourceOffsetPpq) || 0;
  const end = offset + clip.lengthPpq;
  const width = Math.max(1, clip.lengthPpq * zoom);
  const lines = new Map();
  for (const control of Array.isArray(clip.controls) ? clip.controls : []) {
    if (control.kind === 'polypressure' || control.startPpq >= end) continue;
    const key = `${control.channel}:${control.kind}:${control.number}`;
    const y = (100 - control.value / (control.kind === 'pitchbend' ? 16383 : 127) * 100).toFixed(1);
    const x = Math.max(0, Math.round((control.startPpq - offset) * zoom));
    const points = lines.get(key) || [];
    // One point a pixel, the last of it; before the window, the value it opens on.
    if (points.length && points[points.length - 1][0] === x) points[points.length - 1][1] = y;
    else points.push([x, y]);
    lines.set(key, points);
  }
  if (!lines.size) return '';
  const paths = [...lines.values()].map((points) =>
    `<path d="M${points[0][0]} ${points[0][1]}${points.slice(1).map(([x, y]) => ` H${x} V${y}`).join('')} H${Math.round(width)}"/>`).join('');
  return `<svg class="seq-control-lines" data-seq-width="${width}" viewBox="0 0 ${Math.round(width)} 100" preserveAspectRatio="none" aria-hidden="true">${paths}</svg>`;
}

/**
 * A lane's grid, drawn in the track's own bars (D-060): one stretch per
 * signature the track holds, each starting on its bar line so its lines fall
 * on that track's beats and bars -- in a 7/8 track against a 4/4 project, not
 * on the project's. Bar lines are drawn a shade stronger than beats, or a
 * polymetric track would be a grid nobody could read the bars of.
 *
 * A signature change is marked where it begins, by a chip that opens its menu.
 */
function meterSpansMarkup(regions, endPpq, zoom) {
  return meterSpans(regions, 0, endPpq).map(({ fromPpq, toPpq, signature }) => {
    const beat = gridPx(zoom, signature);
    const bar = Math.max(beat, quartersPerBar(signature) * zoom);
    return `<div class="seq-meter-span" data-seq-left="${fromPpq * zoom}" data-seq-width="${(toPpq - fromPpq) * zoom}" data-seq-beat="${beat}" data-seq-bar="${bar}"></div>`;
  }).join('');
}

function meterMarksMarkup(changes, regions, zoom, visibleStart, visibleEnd, owner) {
  return (changes || []).map((change) => {
    const at = meterBarPpq(regions, change.bar);
    if (at < visibleStart - 8 || at > visibleEnd) return '';
    const text = formatSignature(change);
    return `<button class="seq-meter-mark" data-meter-bar="${change.bar}" data-seq-left="${at * zoom}" title="${text} from bar ${change.bar} of ${owner}. Click to change">${text}</button>`;
  }).join('');
}

function laneMeterMarkup(track, regions, endPpq, zoom, visibleStart, visibleEnd) {
  return meterSpansMarkup(regions, endPpq, zoom)
    + meterMarksMarkup(track.meter, regions, zoom, visibleStart, visibleEnd, 'this track');
}

/** The signatures offered first; any other is found by typing it. */
const COMMON_SIGNATURES = ['2/4', '3/4', '4/4', '5/4', '6/4', '7/4', '3/8', '5/8', '6/8', '7/8', '9/8', '11/8', '12/8', '5/16', '7/16'];

/*
 * An audio clip's fades (D-062), drawn and grabbed as Reaper does: a red
 * curve over a shaded area, a round handle at the top where each fade ends,
 * and a cursor that changes where the hand can take one. The top corners
 * start a fade that is not there yet; a handle is taken again as often as you
 * like; the curve itself is dragged up and down to bend it.
 */
const FADE_GRAB_PX = 6;
const FADE_TOP_PX = 10;

function fadePixels(clip, zoom, bpm, width) {
  const perSecond = ((Number(bpm) || 120) / 60) * zoom;
  return {
    in: Math.min(width, (Number(clip.fadeIn?.seconds) || 0) * perSecond),
    out: Math.min(width, (Number(clip.fadeOut?.seconds) || 0) * perSecond)
  };
}

function fadeMarkup(clip, zoom, bpm, width) {
  const px = fadePixels(clip, zoom, bpm, width);
  const part = (direction, fade, length) => {
    const handle = direction === 'in' ? length : width - length;
    let curve = '';
    if (length > 0) {
      const { line, shade } = fadePaths(fade, direction);
      curve = `<svg class="seq-fade ${direction}" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" data-seq-left="${direction === 'in' ? 0 : width - length}" data-seq-width="${length}"><path class="seq-fade-shade" d="${shade}"></path><path class="seq-fade-line" d="${line}"></path></svg>`;
    }
    return `${curve}<span class="seq-fade-handle ${direction}" data-seq-left="${handle}" aria-hidden="true"></span>`;
  };
  return part('in', clip.fadeIn, px.in) + part('out', clip.fadeOut, px.out);
}

/**
 * What the hand is over, in a clip `width` by `height`: a fade's length
 * (`in-length`, `out-length`) at the top, where a fade ends or where one can
 * begin, or its curve (`in-curve`, `out-curve`) within a few pixels of it.
 */
export function fadeZoneAt(clip, zoom, bpm, width, height, x, y) {
  const px = fadePixels(clip, zoom, bpm, width);
  const inEnd = px.in;
  const outStart = width - px.out;
  if (y <= FADE_TOP_PX) {
    const toIn = Math.abs(x - inEnd);
    const toOut = Math.abs(x - outStart);
    if (Math.min(toIn, toOut) <= FADE_GRAB_PX) return toIn <= toOut ? 'in-length' : 'out-length';
  }
  if (px.in > 0 && x >= 0 && x <= inEnd) {
    const gain = fadeGain(clip.fadeIn.shape, clip.fadeIn.curve, x / inEnd);
    if (Math.abs(y - (1 - gain) * height) <= FADE_GRAB_PX) return 'in-curve';
  }
  if (px.out > 0 && x >= outStart && x <= width) {
    const gain = fadeGain(clip.fadeOut.shape, clip.fadeOut.curve, (width - x) / px.out);
    if (Math.abs(y - (1 - gain) * height) <= FADE_GRAB_PX) return 'out-curve';
  }
  return '';
}

/** Which fade `x` is inside, for its menu: `in`, `out`, or none. */
export function fadeRegionAt(clip, zoom, bpm, width, x) {
  const px = fadePixels(clip, zoom, bpm, width);
  if (px.in > 0 && x <= px.in) return 'in';
  if (px.out > 0 && x >= width - px.out) return 'out';
  return '';
}

/**
 * Clips that overlap on one track, laid out in lanes, as Reaper lays out
 * layered takes (D-066): every take recorded over another stays in sight and
 * in reach, and all of them still sound. A group is a run of clips that
 * overlap one another; within it each clip takes the first lane free where
 * it starts, and the group's lanes share the track's height. A clip that
 * overlaps nothing keeps the whole height. Answers, by clip id,
 * `{ lane, lanes }`. Exported for the tests.
 */
export function clipLanes(clips) {
  const placed = new Map();
  const ordered = [...(Array.isArray(clips) ? clips : [])].sort((a, b) => a.startPpq - b.startPpq);
  let group = [];
  let groupEnd = -Infinity;
  const close = () => {
    const ends = [];
    const rows = group.map((clip) => {
      let row = ends.findIndex((end) => end <= clip.startPpq + 1e-9);
      if (row < 0) { row = ends.length; ends.push(0); }
      ends[row] = clip.startPpq + clip.lengthPpq;
      return row;
    });
    group.forEach((clip, index) => placed.set(clip.id, { lane: rows[index], lanes: ends.length }));
    group = [];
  };
  for (const clip of ordered) {
    if (group.length && clip.startPpq >= groupEnd - 1e-9) close();
    group.push(clip);
    groupEnd = group.length === 1 ? clip.startPpq + clip.lengthPpq : Math.max(groupEnd, clip.startPpq + clip.lengthPpq);
  }
  if (group.length) close();
  return placed;
}

// The lane a clip is drawn in, as the attributes that place it: nothing for a
// clip alone, which keeps the stylesheet's full height.
function laneAttributes(place, trackHeight = TRACK_HEIGHT) {
  if (!place || place.lanes < 2) return '';
  const inner = trackHeight - 6;
  const height = inner / place.lanes;
  // Too thin for its picture, the name alone.
  const compact = height < 24 ? ' data-compact' : '';
  return ` data-seq-top="${(3 + place.lane * height).toFixed(2)}" data-seq-height="${Math.max(8, height - 1).toFixed(2)}" data-lanes="${place.lanes}"${compact}`;
}

/**
 * The key that makes a clip active or inactive (D-067), in its bottom right
 * corner -- the top corners are the fades'. On every clip laid in lanes, where
 * a take is chosen among others, and on any inactive clip, so one moved out
 * of its lanes can still be heard again.
 */
function clipMuteMarkup(clip, laned) {
  if (!laned && !clip.muted) return '';
  const speaker = 'M2 5h3l4-3v10l-4-3H2z';
  const mark = clip.muted ? '<path d="M11 5l3 4M14 5l-3 4"/>' : '<path d="M11 4.5a3.5 3.5 0 0 1 0 5"/>';
  const title = clip.muted ? 'Inactive: click to hear this clip again' : 'Active: click to silence this clip';
  return `<span class="seq-clip-mute" data-clip-mute role="switch" aria-checked="${!clip.muted}" title="${title}" aria-label="${title}"><svg viewBox="0 0 16 14" aria-hidden="true"><path class="speaker" d="${speaker}"/>${mark}</svg></span>`;
}

function clipMarkup(track, clip, zoom, selected, bpm = 120, place = null, trackHeight = TRACK_HEIGHT) {
  const left = clip.startPpq * zoom;
  const width = Math.max(CLIP_MIN_PX, clip.lengthPpq * zoom);
  const content = clipContent(track, clip, zoom);
  const unavailable = track.type === 'audio' && clip.mediaAvailable === false;
  const title = unavailable ? `${clip.name} — ${clip.mediaError || 'Audio media is unavailable'}` : clip.name;
  const laned = place && place.lanes > 1;
  return `<button class="seq-clip ${track.type} ${selected ? 'selected' : ''} ${unavailable ? 'unavailable' : ''} ${laned ? 'laned' : ''} ${clip.muted ? 'muted' : ''}" data-clip-id="${clip.id}" data-track-id="${track.id}" data-seq-left="${left}" data-seq-width="${width}"${laneAttributes(place, trackHeight)} title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">
    <span class="seq-clip-resize start" data-resize="start" aria-hidden="true"></span><span class="seq-clip-name">${escapeHtml(clip.name)}</span>${unavailable ? '<span class="seq-clip-media-error">Missing media</span>' : content}${track.type === 'audio' && !unavailable ? fadeMarkup(clip, zoom, bpm, width) : ''}${clipMuteMarkup(clip, laned)}<span class="seq-clip-resize end" data-resize="end" aria-hidden="true"></span></button>`;
}

function trackSources(hub, track) {
  if (track.type === 'midi') {
    const selectedId = hub.midi.selectedInputId;
    const selected = selectedId
      ? (hub.midi.getInput?.(selectedId) || hub.midi.listInputs().find((port) => port.id === selectedId))
      : null;
    return selected ? [selected] : [];
  }
  return hub.network.listNodes()
    .filter((node) => node.type !== 'sequencer'
      && node.outputs.some((port) => port.type === 'audio')
      && hub.sequencer.canUseAudioInput(node.id))
    .map((node) => ({
      id: node.id,
      name: node.type === 'audio-input' && hub.engine.deviceState?.inputDevice
        ? `${node.name} — ${hub.engine.deviceState.inputDevice}`
        : node.name
    }));
}

/**
 * What a VST node plays, by name: "VST 4 — Splice INSTRUMENT". Every node
 * used to read "VST 4 — VST chain", so picking the right one meant knowing the
 * Patch Bay by heart. A chain of several plugins names them in order; the
 * field's width cuts what does not fit.
 */
function chainLabel(hub, nodeId) {
  const plugins = hub.nodes?.get?.(nodeId)?.content?.plugins;
  const names = (Array.isArray(plugins) ? plugins : []).map((plugin) => String(plugin?.name || '').trim()).filter(Boolean);
  return names.length ? names.join(' + ') : 'no plugin';
}

function trackDestinations(hub, track) {
  if (track.type === 'midi') return hub.network.listNodes().filter((node) => ['vst', 'arpeggiator', 'one-ring'].includes(node.type)).map((node) => ({
    id: node.id,
    name: node.type === 'vst' ? `${node.name} — ${chainLabel(hub, node.id)}`
      : node.type === 'arpeggiator' ? `${node.name} — Arpeggiator` : node.name
  }));
  return hub.network.listNodes().filter((node) => ['mixer', 'morpher', 'audio-output', 'vst'].includes(node.type)
    && node.inputs.some((port) => port.type === 'audio')
    && hub.sequencer.canUseAudioOutput(node.id)).map((node) => ({ id: node.id, name: node.name }));
}

function inputPlaceholder(hub, track) {
  if (track.type === 'audio') return 'Choose audio source';
  return trackSources(hub, track).length ? 'Choose MIDI input' : 'No MIDI input detected';
}

function destinationPlaceholder(hub, track) {
  if (track.type === 'audio') return trackDestinations(hub, track).length
    ? 'Choose audio destination' : 'No audio destination available';
  return trackDestinations(hub, track).length
    ? 'Choose VST / Arpeggiator' : 'No VST / Arpeggiator destination';
}

function explicitSequencerNode(hub) {
  const instance = hub.nodes?.list?.().find((node) => node.type === 'sequencer');
  return instance ? hub.network.getNode(instance.id) : null;
}

function routeStates(hub, track, sequencerId) {
  const inputCables = hub.network.connectionsTo(sequencerId, track.type === 'midi' ? 'midi-in' : 'audio-in');
  const outputCables = hub.network.connectionsFrom(sequencerId, track.type === 'midi' ? 'midi-out' : 'audio-out');
  const inputMatches = track.type === 'midi'
    ? inputCables.some((connection) => isCanonicalMidiIngress(hub.network, connection))
      && track.inputId === hub.midi.selectedInputId
    : inputCables.some((connection) => connection.from.nodeId === track.inputId);
  const outputMatches = outputCables.some((connection) => connection.to.nodeId === track.outputId);

  const input = track.inputId
    ? (inputMatches
      ? { state: 'ok', text: 'Input cable connected' }
      : { state: 'warning', text: 'Input selected, Patch Bay cable missing' })
    : (inputCables.length
      ? { state: 'warning', text: 'Input cable present, source not selected' }
      : { state: 'idle', text: 'No input route' });
  const output = track.outputId
    ? (outputMatches
      ? { state: 'ok', text: 'Output cable connected' }
      : { state: 'warning', text: 'Output selected, Patch Bay cable missing' })
    : (outputCables.length
      ? { state: 'warning', text: 'Output cable present, destination not selected' }
      : { state: 'idle', text: 'No output route' });

  return { input, output };
}

const routeGlyph = (state) => state === 'ok' ? '✓' : (state === 'warning' ? '!' : '·');

/**
 * The route, as two dots that fit in a 64 px track.
 *
 * The full sentences moved to the inspector with the selects they describe,
 * but they cannot leave the track entirely: what they report -- a Destination
 * chosen with no cable behind it -- is exactly the failure the user cannot see
 * anywhere else. A dot per direction survives the diet, and carries the
 * sentence in its tooltip.
 */
function routeDots({ input, output }) {
  return `<span class="seq-route-dots" aria-hidden="true"><i class="seq-route-${input.state}" title="IN — ${escapeHtml(input.text)}">${routeGlyph(input.state)}</i><i class="seq-route-${output.state}" title="OUT — ${escapeHtml(output.text)}">${routeGlyph(output.state)}</i></span>`;
}

function routeSummary({ input, output }) {
  return `<span class="seq-route-summary" aria-live="polite"><span class="seq-route-${input.state}">${routeGlyph(input.state)} ${escapeHtml(input.text)}</span><span class="seq-route-${output.state}">${routeGlyph(output.state)} ${escapeHtml(output.text)}</span></span>`;
}

/**
 * The routing of the focused track, in the toolbar rather than on the track.
 *
 * Input and Destination are two full-width selects and a pair of sentences,
 * and they are what made a track 140 px tall. They are also what you set once
 * and read rarely -- so they belong to the selected track, in one place, the
 * way Logic and Bitwig put them in an inspector. The Patch Bay stays the
 * routing authority; this is the same pair of fields, moved.
 */
function inspectorMarkup(hub, track, sequencerId) {
  if (!track) {
    return `<div class="seq-inspector empty" data-track-inspector><span class="seq-inspector-label">Track</span><span class="seq-inspector-hint">Click a track to route its input and destination.</span></div>`;
  }
  const states = routeStates(hub, track, sequencerId);
  const destinations = trackDestinations(hub, track);
  // Where the notes go is what is read most often here, so it stands out --
  // once there is somewhere they go.
  const routed = destinations.some((item) => item.id === track.outputId);
  return `<div class="seq-inspector" data-track-inspector>
    <span class="seq-inspector-label">Track</span><strong class="seq-inspector-name">${escapeHtml(track.name)}</strong>
    <label class="seq-inspector-field"><span>Input</span><select data-inspector-control="input" aria-label="${escapeHtml(track.name)} input">${options(trackSources(hub, track), track.inputId, inputPlaceholder(hub, track))}</select></label>
    <label class="seq-inspector-field seq-inspector-destination"><span>Destination</span><select data-inspector-control="output"${routed ? ' class="routed"' : ''} aria-label="${escapeHtml(track.name)} destination">${options(destinations, track.outputId, destinationPlaceholder(hub, track))}</select></label>
    ${routeSummary(states)}
  </div>`;
}

/**
 * How many bars one ruler mark covers.
 *
 * A mark per bar stops being readable long before the clips do: at 4 px per
 * quarter a bar is 16 px, so the numbers overlap into a grey smear. The stride
 * is driven by pixels, not by bar count, and it is snapped up to a power of
 * two -- a mark every 3 bars is arithmetically fine and musically unreadable.
 * `bars / 512` is the second floor, so an hour-long arrangement never emits
 * ten thousand buttons.
 */
const RULER_MIN_MARK_PX = 54;

/**
 * The spacing of the lane and ruler grid lines, in pixels.
 *
 * The grid was drawn one line per quarter, which is right at 72 px and a solid
 * tint at 4: `calc(var(--seq-beat) - 1px)` leaves nothing transparent between
 * two 1 px rules. The answer is not to hide the grid but to draw a coarser
 * musical division -- the narrowest one still worth looking at.
 *
 * The divisions are the signature's: a beat, a group of beats that fills the
 * bar evenly, the bar, then bars by powers of two. In 4/4 that is the 1, 2,
 * 4, 8... quarters it always was; in 3/4 it skips 2, which would draw a line
 * across the middle of every other bar.
 */
export function gridPx(zoom, signature = COMMON_TIME) {
  const step = Math.max(0.01, Number(zoom) || 0);
  const { numerator } = normalizeSignature(signature);
  const beat = quartersPerBeat(signature);
  const bar = quartersPerBar(signature);
  const divisions = [];
  for (let beats = 1; beats <= numerator; beats += 1) if (numerator % beats === 0) divisions.push(beats * beat);
  for (let bars = 2; bars <= 16; bars *= 2) divisions.push(bars * bar);
  for (const quarters of divisions) {
    if (quarters * step >= 12) return quarters * step;
  }
  return divisions.at(-1) * step;
}

/**
 * The spacings a clock ruler is allowed to step through, in seconds.
 *
 * A ladder and not a formula: a mark every 7 seconds is arithmetically fine
 * and unreadable, because nobody counts in sevens. These are the intervals a
 * clock is divided into -- a hundredth, a tenth, half a second, a second,
 * five, a quarter minute, a minute, and up to the hour.
 *
 * It goes below the second, as far as the zoom does. It stopped at the second
 * once, on the argument that the bar ruler under it already carries the fine
 * divisions; the author had asked for the opposite, and was right. This row
 * measures TIME, independently of the bars: a sound designer lining a hit up
 * to 0:12.35 is not helped by being told it is somewhere in bar 7, and the
 * two scales only coincide at a tempo that happens to divide a second.
 * The ladder is the audio take's (`ui/secondsRuler.js`): one clock, not two.
 */
const TIME_STRIDES = STRIDES;
/** Wider than the bar ruler's: `0:00.25` is a longer label than `17`. */
const TIME_MIN_MARK_PX = 62;

/** Seconds per quarter at this tempo. The only place the two units meet. */
export function secondsPerQuarter(bpm) {
  const tempo = Number(bpm);
  return Number.isFinite(tempo) && tempo > 0 ? 60 / tempo : 0.5;
}

/**
 * How many seconds one mark of the clock ruler covers.
 *
 * Two floors, like `rulerStride`'s: the marks stay far enough apart to be read,
 * and the span drawn never carries more than 512 of them -- an hour at one
 * mark a second is 3,600 buttons nobody will click. The span is what is drawn,
 * not the arrangement: only the marks around the view exist, which is what
 * lets a long piece be read to the hundredth.
 */
export function timeStride(pxPerSecond, spanSeconds = 0) {
  const scale = Number(pxPerSecond);
  const span = Math.max(0, Number(spanSeconds) || 0);
  if (!Number.isFinite(scale) || scale <= 0) return TIME_STRIDES.at(-1);
  for (const stride of TIME_STRIDES) {
    if (stride * scale >= TIME_MIN_MARK_PX && span / stride <= 512) return stride;
  }
  return TIME_STRIDES.at(-1);
}

/**
 * A position as a clock reads it: `m:ss`, `h:mm:ss` once there is an hour to
 * write, and as many decimals as the stride needs -- none for whole seconds,
 * one for tenths, two for hundredths.
 */
export function formatClock(seconds, stride = 1) {
  const total = Number(seconds);
  const decimals = stride >= 1 ? 0 : stride >= 0.1 ? 1 : 2;
  if (!Number.isFinite(total) || total < 0) return decimals ? `0:00.${'0'.repeat(decimals)}` : '0:00';
  // Rounded FIRST, then split. Rounding each field after the split is what
  // prints `:60`, and what turns 59:59.6 into `60:00` instead of the hour it
  // has just reached. Counted in whole units of the last decimal, so 0.1 + 0.2
  // cannot print 0:00.30000000000000004.
  const unit = 10 ** decimals;
  const units = Math.round(total * unit);
  const whole = Math.floor(units / unit);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const pad = (value) => String(value).padStart(2, '0');
  const fraction = decimals ? `.${String(units % unit).padStart(decimals, '0')}` : '';
  const secs = `${pad(whole % 60)}${fraction}`;
  return hours > 0 ? `${hours}:${pad(minutes)}:${secs}` : `${minutes}:${secs}`;
}

/**
 * The position a press on the timeline names: `clientX` against the left edge
 * of the timeline's zero, on the Snap grid unless `free` (Alt held).
 */
export function timelinePpqAt(clientX, originX, zoom, snap, free = false, meter = COMMON_TIME) {
  const raw = Math.max(0, (Number(clientX) - Number(originX)) / Math.max(0.01, Number(zoom) || 0));
  if (!Number.isFinite(raw)) return 0;
  return free ? raw : meterSnap(asRegions(meter), raw, snap === '1 bar' ? 'bar' : snapStep(snap));
}

export function rulerStride(bars, zoom, barPpq = 4) {
  return barLabelStride(bars, zoom, barPpq, RULER_MIN_MARK_PX);
}

/**
 * The clock ruler's marks, between `fromPpq` and `toPpq` only.
 *
 * Positioned in pixels like the bar ruler's, and carrying the same `data-seek`
 * in quarters -- clicking 1:30 seeks there, which is the point of a ruler you
 * can read. The mapping is linear because MiniHub has one tempo and no tempo
 * map: seconds are quarters times 60 over the BPM. The day there is a tempo
 * map, this is the function that has to walk it.
 *
 * Windowed like the clips: at a hundredth of a second, a five-minute piece is
 * thirty thousand marks, and the scroll listener already repaints when the
 * view leaves what was drawn.
 */
function timeRulerMarkup(endPpq, zoom, bpm, fromPpq = 0, toPpq = endPpq) {
  const perQuarter = secondsPerQuarter(bpm);
  const endSeconds = Math.max(0, Number(endPpq) || 0) * perQuarter;
  const fromSeconds = Math.max(0, Number(fromPpq) || 0) * perQuarter;
  const toSeconds = Math.min(endSeconds, Math.max(fromSeconds, Number(toPpq) || 0) * perQuarter);
  const pxPerSecond = Math.max(0.0001, (Number(zoom) || 0) / perQuarter);
  const stride = timeStride(pxPerSecond, toSeconds - fromSeconds);
  const first = Math.floor(fromSeconds / stride);
  const last = Math.max(first, Math.ceil(toSeconds / stride) - 1);
  const marks = [];
  // Multiplied, never accumulated: adding 0.01 a thousand times drifts.
  for (let index = first; index <= last; index += 1) marks.push(index * stride);
  return marks
    .map((seconds) => `<button class="seq-time-mark" data-seek="${seconds / perQuarter}" data-seq-left="${seconds * pxPerSecond}" data-seq-width="${stride * pxPerSecond}"><strong>${formatClock(seconds, stride)}</strong></button>`)
    .join('');
}

function rulerMarkup(endPpq, zoom, meter = COMMON_TIME) {
  const regions = asRegions(meter);
  // Every bar line to the end, walked through the changes (D-061): a bar is
  // not one length once a song changes signature.
  const lines = [];
  for (let q = 0; q < endPpq - 1e-9 && lines.length < 100000;) {
    const at = meterBarAt(regions, q);
    lines.push(at.startPpq);
    q = at.startPpq + at.lengthPpq;
  }
  const shortest = Math.min(...regions.map((region) => quartersPerBar(region.signature)));
  const stride = rulerStride(lines.length, zoom, shortest);
  const marks = [];
  for (let index = 0; index < lines.length; index += stride) {
    const next = lines[index + stride] ?? endPpq;
    marks.push(`<button class="seq-ruler-mark" data-seek="${lines[index]}" data-seq-left="${lines[index] * zoom}" data-seq-width="${(next - lines[index]) * zoom}"><strong>${index + 1}</strong></button>`);
  }
  return marks.join('');
}

export function createSequencerModule(hub) {
  const controller = hub.sequencer;
  let container = null;
  let unsubs = [];
  let drag = null;
  let scrollRenderQueued = false;
  /**
   * The vertical scroll, kept here because `render()` replaces the scrolling
   * element itself: a new element starts at zero, and `scrollLeft` was the
   * only one being put back. Thirteen tracks fit on a screen, so from the
   * fourteenth on every render -- adding a track, renaming one, moving a clip,
   * a MIDI port appearing -- threw you back to the first tracks and the ones
   * you were working on were gone.
   *
   * Module state and not the model's: where you are looking is not the
   * project. The Clip Editor keeps its own the same way (`pianoScroll`).
   */
  let scrollTopPx = 0;
  /**
   * The span of music the last render actually drew, and the width it drew it
   * for. Only the clips inside it exist in the DOM, so the scroll listener's
   * question -- have I left what is drawn? -- can only be answered against
   * this, never against the live scroll position.
   *
   * Module state and not `render()`'s locals, which is where it was: `bind()`
   * is a SIBLING of `render()`, so the listener it installs closed over
   * nothing and every scroll event threw `visibleStart is not defined`. The
   * repaint was therefore never queued, and scrolling more than a screen off
   * the drawn window emptied every lane -- the tracks looked as though they
   * had lost their clips. Nothing caught it because nothing scrolled: the
   * regression test in sequencerUi.test.mjs now does.
   */
  let drawnWindow = { startPpq: 0, endPpq: 0, viewportPpq: 16 };
  let resizeObserver = null;
  let resizeRenderQueued = false;
  let suppressSelectionClickId = null;
  let marquee = null;
  let suppressLaneClick = false;
  // The playhead being dragged, from a ruler or its grip: `{ ppq }`.
  let scrub = null;
  let tempoBindingCleanup = null;
  let metronomePulseTimer = null;

  /**
   * The one sentence the transport shows, and the tone it wears.
   *
   * Order matters and is the point of this function: **why nothing is heard**
   * comes before **why a take cannot start**, because the first is what you
   * are asking while your hands are on the keys. Both used to be computed
   * twice -- once in `render()`, once in `renderCountInState()` -- which is
   * how the two could disagree.
   */
  function transportStatus(preCounting = controller.preCounting) {
    if (preCounting) return { tone: 'active', text: 'Pre-count — recording starts after this measure. Press Stop to cancel.' };
    if (controller.recording) return { tone: 'active', text: 'Recording now — press Stop to finish and keep the take.' };
    const blocked = (controller.liveBlockReason?.() || '') || controller.recordBlockReason();
    return blocked
      ? { tone: 'blocked', text: blocked }
      : { tone: 'ready', text: 'Ready to record the armed and routed tracks.' };
  }

  /**
   * The navigation bar under the arrangement (`ui/navigationBar.js`, shared
   * with both Clip Editors): drag the thumb to travel, an end to zoom.
   *
   * It lives OUTSIDE `.seq-scroll` on purpose: inside it, it would scroll away
   * with the content it describes.
   *
   * The position comes from the model, not from `scroller.scrollLeft`.
   * `render()` assigns that property and then draws the bar, and an assignment
   * made on freshly inserted DOM can still read back as zero -- which drew the
   * thumb at the far left while the view sat in the middle of the arrangement.
   *
   * Its extent is the music plus the same four bars of room `timelineEndPpq`
   * keeps, never less than the empty arrangement's 64 bars, and always at
   * least as far as the view reaches. It is NOT the canvas width, which keeps
   * a screenful of empty bars ahead of the view and so grows as you scroll:
   * a thumb measured against that shrinks under the hand that is moving it.
   */
  function navigationView() {
    const state = controller.model.state;
    const width = viewportPx();
    const span = width / state.zoom;
    const start = Math.max(0, state.scrollPpq);
    return {
      start,
      span,
      total: Math.max(TIMELINE_BEATS, controller.model.compositionEndPpq() + 16, start + span),
      minSpan: width / ZOOM_MAX,
      maxSpan: width / ZOOM_MIN
    };
  }

  /** A view the bar asks for: a scroll when the zoom is unchanged, else both. */
  function applyNavigation({ start, span }) {
    const state = controller.model.state;
    const zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(viewportPx() / span * 100) / 100));
    const scrollPpq = Math.max(0, start);
    if (zoom === state.zoom) {
      state.scrollPpq = scrollPpq;
      // Looked up now: the element a drag began on may have been replaced.
      const scroller = container?.querySelector('[data-timeline-scroll]');
      if (scroller) scroller.scrollLeft = scrollPpq * zoom;
      return;
    }
    state.zoom = zoom;
    state.scrollPpq = scrollPpq;
    commitView();
  }

  const navigation = attachNavigationBar({
    root: { querySelector: (selector) => container?.querySelector(selector) ?? null },
    view: navigationView,
    apply: applyNavigation
  });
  const renderNavigation = navigation.render;
  const bindNavigation = navigation.bind;

  /**
   * Middle-button drag pans the timeline, both axes at once.
   *
   * The gesture nothing else claims: left is selection and clips, right is the
   * context menu, and the Patch Bay already spends right-drag on its own pan.
   */
  function bindPan() {
    const scroller = container?.querySelector('[data-timeline-scroll]');
    if (!scroller) return;
    // The live scroller on every move, for the reason `ui/navigationBar.js` gives: a pan
    // that crosses the virtualization boundary re-renders the timeline under
    // the hand, and the element this closure captured is detached from then
    // on. `from` stays valid across that repaint -- `render()` puts the scroll
    // back from `scrollPpq`, so the new element opens where the old one was.
    const live = () => container?.querySelector('[data-timeline-scroll]');
    scroller.addEventListener('pointerdown', (event) => {
      if (event.button !== 1) return;
      event.preventDefault();
      const from = { x: event.clientX, y: event.clientY, left: scroller.scrollLeft, top: scroller.scrollTop };
      scroller.classList.add('panning');
      const move = (moveEvent) => {
        const element = live();
        if (!element) return;
        element.classList.add('panning');
        element.scrollLeft = from.left - (moveEvent.clientX - from.x);
        element.scrollTop = from.top - (moveEvent.clientY - from.y);
      };
      const up = () => {
        live()?.classList.remove('panning');
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        document.removeEventListener('pointercancel', up);
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up, { once: true });
      document.addEventListener('pointercancel', up, { once: true });
    });
  }

  /** The timeline's own width in pixels: what a framing has to fill. */
  function viewportPx() {
    return Math.max(120, (container?.clientWidth || 0) - TRACK_HEADER);
  }

  /** Zoom and scroll are view state, never musical data: the native plan does
   *  not change because you looked closer. */
  function commitView() {
    controller.changed({ syncNative: false, invalidateEditors: false });
  }

  function applyFraming(span) {
    const framed = frameSpan(span, viewportPx());
    if (!framed) return false;
    controller.model.state.zoom = framed.zoom;
    controller.model.state.scrollPpq = framed.scrollPpq;
    commitView();
    return true;
  }

  /** Fit — bar one to the last thing in the arrangement. */
  function zoomFit() {
    return applyFraming({ startPpq: 0, endPpq: controller.model.compositionEndPpq() });
  }

  /** Focus — what you selected. Failing that the loop range, which is the
   *  other thing on screen that means "this bit". Failing both, Fit. */
  function zoomFocus() {
    const placements = controller.model.clipPlacements(controller.model.selectedClipIds());
    if (placements.length) {
      return applyFraming({
        startPpq: Math.min(...placements.map((item) => item.startPpq)),
        endPpq: Math.max(...placements.map((item) => item.startPpq + item.clip.lengthPpq))
      });
    }
    const { loop } = controller.model.state;
    if (loop.endPpq > loop.startPpq) return applyFraming({ startPpq: loop.startPpq, endPpq: loop.endPpq });
    return zoomFit();
  }

  /**
   * Zoom while keeping one point of the music where it is on screen.
   *
   * `localX` is measured from the left edge of the scroller, so the first
   * `TRACK_HEADER` pixels are the sticky headers and the timeline starts
   * after them. Zooming around the left edge instead means hunting for your
   * place again after every notch.
   */
  function zoomAt(nextZoom, localX) {
    const state = controller.model.state;
    const zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round((Number(nextZoom) || 0) * 100) / 100));
    if (zoom === state.zoom) return false;
    const offset = localX - TRACK_HEADER;
    const anchorPpq = state.scrollPpq + offset / state.zoom;
    state.zoom = zoom;
    state.scrollPpq = Math.max(0, anchorPpq - offset / zoom);
    commitView();
    return true;
  }

  function drawPlayhead(ppq) {
    const head = container?.querySelector('[data-playhead]');
    if (head) head.style.left = `${TRACK_HEADER + ppq * controller.model.state.zoom}px`;
  }

  /** Move the cursor, and carry the view with it when it would leave the
   *  screen. Recording used to pin the viewport to the opening bars while the
   *  take ran on somewhere off-screen, so the timeline stopped answering the
   *  one question it exists to answer: where am I. */
  function movePlayhead(ppq) {
    // A drag during playback holds the line where the pointer is; the engine's
    // position takes it back on release, with the seek.
    if (!container || (scrub && controller.playing)) return;
    const zoom = controller.model.state.zoom;
    drawPlayhead(ppq);
    const scroller = container.querySelector('[data-timeline-scroll]');
    if (!scroller) return;
    const viewportPpq = Math.max(16, (container.clientWidth - TRACK_HEADER) / zoom);
    const next = followScrollPpq(ppq, controller.model.state.scrollPpq, viewportPpq);
    if (next === null) return;
    // Assigning scrollLeft raises the scroller's own listener, which republishes
    // scrollPpq and repaints the clips that just entered the window.
    controller.model.state.scrollPpq = next;
    scroller.scrollLeft = next * zoom;
    renderNavigation();
  }

  /**
   * Add a track, then bring it to the screen it was created off.
   *
   * Every workstation scrolls to the track it has just made. Here it was worse
   * than a missing convenience: with the arrangement scrolled down, the render
   * that `addTrack` triggers put the view back at the top, so the answer to
   * "+ MIDI Track" was a screen that had not changed and a track somewhere
   * below. The reveal comes AFTER `controller.addTrack`, which renders
   * synchronously -- there is a fresh scroller to measure by then.
   */
  function addTrack(type) {
    const track = controller.addTrack(type);
    if (track) revealTrack(track.id);
    return track;
  }

  /**
   * "+ MIDI Track" offers the track alone, or with its instrument: the
   * installed instruments follow, narrowed by typing, and taking one makes the
   * node, loads the plugin, plugs the cables and opens the plugin's window
   * (core/instrumentTrack.js). Asked by the author on 2026-09-26.
   */
  function openAddMidiMenu(button) {
    const box = button?.getBoundingClientRect?.() || { left: 0, bottom: 0 };
    const instruments = instrumentPlugins(hub);
    const items = [{ label: 'Empty MIDI Track', keywords: 'blank none', action: () => addTrack('midi') }];
    if (instruments.length) {
      items.push({ heading: 'With an instrument' });
      for (const plugin of instruments) {
        items.push({
          label: plugin.name,
          hint: plugin.manufacturer || '',
          keywords: [plugin.manufacturer, plugin.category].filter(Boolean).join(' '),
          action: () => addInstrumentTrack(plugin.pluginId)
        });
      }
    }
    openContextMenu({ x: box.left, y: box.bottom + 4, items, search: { placeholder: 'An instrument, or Enter for an empty track…' } });
  }

  function addInstrumentTrack(pluginId) {
    const made = createInstrumentTrack(hub, pluginId);
    if (made?.track) revealTrack(made.track.id);
    if (made?.pluginInstanceId) openPluginWhenReady(hub, made.nodeId, made.pluginInstanceId);
    return made;
  }

  /** Scroll a track row fully into view, without moving when it already is. */
  function revealTrack(trackId) {
    const scroller = container?.querySelector('[data-timeline-scroll]');
    const state = controller.model.state;
    const index = state.tracks.findIndex((track) => track.id === trackId);
    if (!scroller || index < 0) return;
    // The rail floats over the bottom of the scrolling area and `.seq-scroll`
    // reserves that band as padding. Read rather than repeated: a second
    // spelling of 14px here is one that would go stale the day the rail grows.
    const padding = parseFloat(globalThis.getComputedStyle?.(scroller)?.paddingBottom);
    scrollTopPx = revealScrollTop({
      top: trackLayout(state).tops[index],
      height: trackHeightOf(state, trackId),
      scrollTop: scrollTopPx,
      viewHeight: (scroller.clientHeight || 0) - (Number.isFinite(padding) ? padding : 0),
      stickyTop: HEAD_HEIGHT
    });
    scroller.scrollTop = scrollTopPx;
  }

  function resizeRender() {
    if (resizeRenderQueued || !container) return;
    resizeRenderQueued = true;
    requestAnimationFrame(() => { resizeRenderQueued = false; render(); });
  }

  function render() {
    if (!container) return;
    tempoBindingCleanup?.();
    tempoBindingCleanup = null;
    const sequencerNode = explicitSequencerNode(hub);
    if (!sequencerNode) {
      scrollRenderQueued = false;
      container.innerHTML = `<div class="sequencer-page"><section class="panel seq-runtime-empty" data-sequencer-empty>
        <span class="pill accent-sequencer family-midi">Patch Bay required</span>
        <h1 class="page-title">Add a Sequencer node to start arranging</h1>
        <p>The timeline runs through a real Sequencer node and its visible cables. Open the Patch Bay, click <strong>Add a node</strong> and choose <strong>Sequencer</strong>.</p>
        <button class="btn primary" data-action="open-routing">Open Patch Bay</button>
      </section></div>`;
      container.querySelector('[data-action="open-routing"]')?.addEventListener('click', () => {
        hub.modules.activate('routing', container);
      });
      return;
    }
    const state = controller.model.state;
    const selectedClipIds = new Set(state.selectedClipIds || (state.selectedClipId ? [state.selectedClipId] : []));
    const zoom = state.zoom;
    const projectRegions = controller.projectRegions();
    const lastBar = meterBarAt(projectRegions, Infinity);
    const viewportPpq = Math.max(16, (container.clientWidth - TRACK_HEADER) / zoom);
    const endPpq = timelineEndPpq({
      barPpq: lastBar.lengthPpq,
      minimumPpq: TIMELINE_BEATS,
      contentEndPpq: controller.model.compositionEndPpq(),
      scrollPpq: state.scrollPpq,
      viewportPpq
    });
    const timelineWidth = endPpq * zoom;
    const layout = trackLayout(state);
    const visibleStart = Math.max(0, state.scrollPpq - viewportPpq);
    const visibleEnd = state.scrollPpq + viewportPpq * 2;
    drawnWindow = { startPpq: visibleStart, endPpq: visibleEnd, viewportPpq };
    const atTrackLimit = state.tracks.length >= SEQUENCER_LIMITS.tracks;
    const recordBlockReason = controller.recordBlockReason();
    const status = transportStatus();
    const focusedTrack = state.tracks.find((track) => track.id === state.focusedTrackId) || null;
    scrollRenderQueued = false;
    // The menu points at DOM that is about to be replaced, and at a clip that
    // may no longer exist.
    closeContextMenu();
    container.innerHTML = `<div class="sequencer-page">
      <section class="panel seq-toolbar">
        <div class="row seq-head-row"><h1 class="page-title">Sequencer</h1><span class="pill seq-track-count">${state.tracks.length} tracks</span><span class="spacer"></span>
          <button class="btn" data-action="add-midi" ${atTrackLimit ? 'disabled title="64-track project limit reached"' : 'title="Add a MIDI track"'}><span>+ MIDI<span class="seq-roomy"> Track</span></span></button><button class="btn" data-action="add-audio" ${atTrackLimit ? 'disabled title="64-track project limit reached"' : 'title="Add an audio track"'}><span>+ Audio<span class="seq-roomy"> Track</span></span></button>
          <label class="seq-tempo-control" title="Tempo"><span class="seq-tempo-label">Tempo</span><input class="tempo-input" data-control="tempo" type="number" min="20" max="300" step="1" value="${controller.tempo}" aria-label="Sequencer tempo in BPM"><span>BPM</span></label>
          <div class="seq-metronome-control" title="Métronome">
            <span class="seq-metronome-label">Métronome</span>
            <button class="seq-metronome-switch ${controller.metronomeEnabled ? 'active' : ''}" type="button" role="switch" aria-checked="${controller.metronomeEnabled}" data-action="toggle-metronome" aria-label="Activer ou désactiver le métronome"><span aria-hidden="true"></span></button>
            <span class="seq-metronome-light" data-metronome-light aria-label="Voyant du métronome" role="status"></span>
            <span class="seq-metronome-mode" role="group" aria-label="When the metronome clicks">${METRONOME_KEYS.map(([mode, label, hint]) => `<button type="button" data-metronome-mode="${mode}" aria-pressed="${controller.metronomeMode === mode}" title="${hint}">${label}</button>`).join('')}</span>
          </div>
        </div>
        <div class="seq-record-status ${status.tone}" role="status">${escapeHtml(status.text)}</div>
        <div class="row mt-12 seq-tools"><label>Snap <select data-control="snap">${Object.keys(SNAP_STEPS).map((value) => `<option ${value === state.snap ? 'selected' : ''}>${value}</option>`).join('')}</select></label>
          <label class="seq-zoom-control">Zoom <input data-control="zoom" type="range" min="0" max="100" value="${zoomToSlider(zoom)}" aria-label="Timeline zoom"><button class="btn seq-zoom-btn" data-action="zoom-fit" title="Frame the whole arrangement (Ctrl+wheel zooms under the cursor)">Fit</button><button class="btn seq-zoom-btn" data-action="zoom-focus" title="Frame the selected clips, or the loop range">Focus</button></label>
          <label><input data-control="loop-enabled" type="checkbox" ${state.loop.enabled ? 'checked' : ''}> Loop</label>
          <label title="First bar of the loop">From <input data-control="loop-start" type="number" min="1" step="any" value="${loopBars(state.loop, projectRegions).from}"></label>
          <label title="Last bar of the loop, included">To <input data-control="loop-end" type="number" min="1" step="any" value="${loopBars(state.loop, projectRegions).to}"></label>
          <span class="seq-record-mode-control"><span>Record</span><span class="seq-record-mode" role="group" aria-label="What a take does to the clips already on its track">${RECORD_MODE_KEYS.map(([mode, label, hint]) => `<button type="button" data-record-mode="${mode}" aria-pressed="${controller.recordMode === mode}" title="${hint}">${label}</button>`).join('')}</span></span>
        </div>
        ${inspectorMarkup(hub, focusedTrack, sequencerNode.id)}
      </section>
      <section class="panel seq-arrangement">
        <div class="seq-scroll" data-timeline-scroll>
          <div class="seq-canvas" data-seq-canvas data-seq-head="${TRACK_HEADER}" data-seq-time-ruler="${TIME_RULER_HEIGHT}" data-seq-bar-ruler="${RULER_HEIGHT}" data-seq-width="${TRACK_HEADER + timelineWidth}" data-seq-height="${layout.bottom}">
            <div class="seq-corner">TRACKS</div><div class="seq-time-ruler" data-seq-time-scale data-seq-left="${TRACK_HEADER}" data-seq-width="${timelineWidth}">${timeRulerMarkup(endPpq, zoom, controller.tempo, visibleStart, visibleEnd)}</div><div class="seq-ruler" data-seq-left="${TRACK_HEADER}" data-seq-width="${timelineWidth}">${meterSpansMarkup(projectRegions, endPpq, zoom)}${rulerMarkup(endPpq, zoom, projectRegions)}${meterMarksMarkup(state.meter, projectRegions, zoom, visibleStart, visibleEnd, 'the project')}</div>
            <div class="seq-loop-range ${state.loop.enabled ? 'enabled' : ''}" data-seq-left="${TRACK_HEADER + state.loop.startPpq * zoom}" data-seq-width="${(state.loop.endPpq - state.loop.startPpq) * zoom}" data-seq-height="${layout.bottom}"></div>
            ${state.tracks.length ? state.tracks.map((track, index) => `<div class="seq-track ${state.focusedTrackId === track.id ? 'focused' : ''}" data-track-id="${track.id}" data-seq-top="${layout.tops[index]}" data-seq-height="${trackHeightOf(state, track.id)}">
              <div class="seq-track-head" data-seq-width="${TRACK_HEADER}">
                <button class="seq-track-select" data-track-action="select" title="Select ${escapeHtml(track.name)}" aria-label="Select ${escapeHtml(track.name)}" aria-pressed="${state.focusedTrackId === track.id}"></button>
                <button class="seq-arm ${track.armed ? 'active' : ''}" data-track-action="arm" title="Arm">R</button>
                <button class="seq-monitor ${track.monitored ? 'active' : ''}" data-track-action="monitor" title="Input monitor">I</button>
                <input class="seq-track-name" data-track-control="name" value="${escapeHtml(track.name)}">
                <button class="seq-track-plugin" data-track-action="plugin" ${trackPlugin(hub, track) ? 'title="Open the plugin this track plays"' : 'disabled title="This track plays no plugin"'} aria-label="Open ${escapeHtml(track.name)}'s plugin">${icon('instrument', 13)}</button>
                <button class="seq-mute ${track.muted ? 'active' : ''}" data-track-action="mute" title="Mute">M</button>
                <button class="seq-track-delete" data-track-action="delete" title="Delete track">×</button>
                <div class="seq-track-level"><input data-track-control="volume" type="range" min="-60" max="6" step="0.1" value="${gainToDb(track.volume)}" aria-label="${escapeHtml(track.name)} level in dB"><output data-track-level-value>${formatGainDb(track.volume)}</output><input class="seq-track-pan" data-track-control="pan" type="range" min="-100" max="100" step="1" value="${Math.round((track.pan || 0) * 100)}" title="Pan (double-click: centre)" aria-label="${escapeHtml(track.name)} pan"><output data-track-pan-value>${formatPan(track.pan)}</output></div>
                ${routeDots(routeStates(hub, track, sequencerNode.id))}
              </div>
              <div class="seq-track-lane" data-seq-left="${TRACK_HEADER}" data-seq-width="${timelineWidth}">${laneMeterMarkup(track, controller.model.trackRegions(track), endPpq, zoom, visibleStart, visibleEnd)}${((lanes) => track.clips.filter((clip) => clip.startPpq + clip.lengthPpq >= visibleStart && clip.startPpq <= visibleEnd).map((clip) => clipMarkup(track, clip, zoom, selectedClipIds.has(clip.id), controller.tempo, lanes.get(clip.id), trackHeightOf(state, track.id))).join(''))(clipLanes(track.clips))}${automationMarkup(track, zoom, timelineWidth)}</div>
            </div>`).join('') : `<div class="seq-empty" data-seq-top="${HEAD_HEIGHT}">Create a MIDI or audio track to begin.</div>`}
            <div class="seq-playhead" data-playhead data-seq-left="${TRACK_HEADER + controller.playheadPpq * zoom}" data-seq-height="${layout.bottom}"><span class="seq-playhead-grip" data-playhead-grip title="Drag to move the playhead (Alt: off the grid)"></span></div>
          </div>
        </div>
        ${navigationBarMarkup(`data-seq-head="${TRACK_HEADER}"`)}
      </section>
    </div>`;
    applyDynamicStyles(container);
    bind();
    const scroller = container.querySelector('[data-timeline-scroll]');
    if (scroller) {
      scroller.scrollLeft = state.scrollPpq * zoom;
      // Both axes, or the tracks below the fold vanish on every repaint.
      scroller.scrollTop = scrollTopPx;
    }
    renderNavigation();
    drawMarquee();
  }

  function bind() {
    container.querySelector('[data-action="add-midi"]')?.addEventListener('click', (event) => openAddMidiMenu(event.currentTarget));
    container.querySelector('[data-action="add-audio"]')?.addEventListener('click', () => { addTrack('audio'); });
    const tempoInput = container.querySelector('[data-control="tempo"]');
    tempoBindingCleanup = bindTempoInput(tempoInput, (tempo) => controller.setTempo(tempo));
    container.querySelector('[data-action="toggle-metronome"]')?.addEventListener('click', () => {
      renderMetronomeState(controller.setMetronome(!controller.metronomeEnabled));
    });
    container.querySelectorAll('[data-record-mode]').forEach((button) => button.addEventListener('click', () => {
      controller.setRecordMode(button.dataset.recordMode);
    }));
    container.querySelectorAll('[data-metronome-mode]').forEach((button) => button.addEventListener('click', () => {
      controller.setMetronomeMode(button.dataset.metronomeMode);
    }));
    container.querySelector('[data-action="duplicate-clip"]')?.addEventListener('click', () => controller.duplicateSelectedClips());
    container.querySelector('[data-control="snap"]')?.addEventListener('change', (event) => { controller.model.state.snap = event.target.value; controller.changed(); });
    // On `change`, not `input`: a render rebuilds the whole page, which would
    // destroy the very slider the pointer is holding. Ctrl+wheel is the live
    // gesture -- it holds no element, so re-rendering under it is harmless.
    container.querySelector('[data-control="zoom"]')?.addEventListener('change', (event) => {
      zoomAt(sliderToZoom(event.target.value), TRACK_HEADER + viewportPx() / 2);
    });
    container.querySelector('[data-action="zoom-fit"]')?.addEventListener('click', zoomFit);
    container.querySelector('[data-action="zoom-focus"]')?.addEventListener('click', zoomFocus);
    container.querySelector('[data-timeline-scroll]')?.addEventListener('wheel', (event) => {
      // Alt+wheel: the selected track taller or shorter (D-068). It keeps the
      // height for the next time it is selected.
      if (event.altKey && !(event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        const state = controller.model.state;
        const trackId = state.focusedTrackId;
        if (!trackId) return;
        const step = event.deltaY < 0 ? TRACK_HEIGHT_STEP : -TRACK_HEIGHT_STEP;
        controller.setTrackHeight(trackId, trackHeightOf(state, trackId) + step);
        return;
      }
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect?.() || { left: 0 };
      zoomAt(
        controller.model.state.zoom * (event.deltaY < 0 ? 1.2 : 1 / 1.2),
        event.clientX - rect.left
      );
    }, { passive: false });
    for (const key of ['loop-enabled', 'loop-start', 'loop-end']) container.querySelector(`[data-control="${key}"]`)?.addEventListener('change', () => {
      const range = loopRangeFromBars(container.querySelector('[data-control="loop-start"]').value, container.querySelector('[data-control="loop-end"]').value, controller.model.state.loop, controller.projectRegions());
      controller.model.setLoop({ enabled: container.querySelector('[data-control="loop-enabled"]').checked, ...range }); controller.changed();
    });
    // The last horizontal position this scroller reported: scrolling the
    // tracks up or down draws nothing new, only a move along the timeline can
    // leave the drawn window.
    let leftSeen = null;
    container.querySelector('[data-timeline-scroll]')?.addEventListener('scroll', (event) => {
      scrollTopPx = event.currentTarget.scrollTop || 0;
      const left = event.currentTarget.scrollLeft;
      const moved = left !== leftSeen;
      leftSeen = left;
      const next = left / controller.model.state.zoom;
      controller.model.state.scrollPpq = next;
      renderNavigation();
      drawMarquee();
      if (moved && !scrollRenderQueued && outsideDrawnWindow(next, drawnWindow)) {
        scrollRenderQueued = true;
        requestAnimationFrame(render); // layout virtualization only; native transport remains the musical clock
      }
    });
    for (const field of ['input', 'output']) {
      container.querySelector(`[data-inspector-control="${field}"]`)?.addEventListener('change', (event) => {
        const trackId = controller.model.state.focusedTrackId;
        if (trackId) controller.setTrack(trackId, { [field === 'input' ? 'inputId' : 'outputId']: event.target.value });
      });
    }
    bindSeeks(container);
    bindScrub();
    container.querySelectorAll('.seq-track').forEach(bindTrack);
    container.querySelectorAll('.seq-clip').forEach(bindClip);
    bindNavigation();
    bindPan();
  }

  function renderTempoValue(tempo) {
    const input = container?.querySelector('[data-control="tempo"]');
    if (input && input.value !== String(tempo)) input.value = String(tempo);
    // The clock ruler is the one thing on this page a tempo change redraws:
    // 64 bars are 64 bars at any tempo, two minutes are not. That row alone
    // rather than the arrangement -- this arrives on every notch of a drag.
    repaintTimeRuler();
  }

  /**
   * Every mark that names a position seeks to it: a bar on the bar ruler, a
   * time on the clock. Taken out of `bind()` because the clock row is redrawn
   * on its own when the tempo moves, and marks rebuilt without their listener
   * are marks that stop answering until the next full render.
   */
  function bindSeeks(root) {
    // The keyboard's click only (`detail` 0): a mouse press is the row's, in
    // `bindScrub`, which lands where the pointer is rather than on the mark's
    // first beat -- and a mouse click here would put it back on that beat.
    root?.querySelectorAll('[data-seek]')
      .forEach((element) => element.addEventListener('click', (event) => {
        if (event.detail) return;
        controller.seek(Number(element.dataset.seek));
      }));
  }

  /**
   * Pressing either ruler puts the playhead where the pointer is, on the Snap
   * grid, and holding it drags it; so does the grip on the red line's head.
   *
   * The author could not choose where a take would start (2026-09-26): the
   * line took no pointer at all, a click in a lane did not move it, and a
   * ruler mark only knew its own first beat. Alt places it off the grid.
   *
   * Stopped, the playhead follows the pointer, and the header's Bar with it.
   * Playing, the line alone follows and the one seek is on release: a seek
   * releases every held note, and a seek per pixel would stutter the music.
   */
  function bindScrub() {
    const rows = ['.seq-ruler', '.seq-time-ruler', '[data-playhead-grip]'];
    for (const selector of rows) {
      container.querySelector(selector)?.addEventListener('pointerdown', startScrub);
    }
    const ruler = container.querySelector('.seq-ruler');
    bindMeterMarks(ruler, null);
    // The project's signature changes are made on the bar ruler, as Reaper
    // inserts its markers from the ruler's menu (D-061).
    ruler?.addEventListener('contextmenu', (event) => {
      event.preventDefault(); event.stopPropagation();
      const ppq = ppqAtPointer(event, ruler);
      openMeterMenu(event, null, meterBarAt(controller.projectRegions(), ppq).bar);
    });
  }

  /** A chip opens its change's menu, and is nothing else: no seek, no band, no clip. */
  function bindMeterMarks(root, track) {
    root?.querySelectorAll('.seq-meter-mark').forEach((mark) => {
      for (const name of ['pointerdown', 'dblclick']) mark.addEventListener(name, (event) => event.stopPropagation());
      const open = (event) => {
        event.preventDefault(); event.stopPropagation();
        openMeterMenu(event, track, Number(mark.dataset.meterBar));
      };
      mark.addEventListener('click', open);
      mark.addEventListener('contextmenu', open);
    });
  }

  function startScrub(event) {
    // A seek ends a take; a slip of the hand on the ruler must not.
    if (event.button !== 0 || controller.recording || controller.preCounting) return;
    const ruler = container?.querySelector('.seq-ruler');
    if (!ruler) return;
    event.preventDefault();
    const origin = ruler.getBoundingClientRect().left;
    const at = (pointer) => timelinePpqAt(pointer.clientX, origin, controller.model.state.zoom,
      controller.model.state.snap, pointer.altKey, controller.projectRegions());
    const live = !controller.playing;
    scrub = { ppq: at(event) };
    const place = () => {
      if (!scrub) return;
      if (live) controller.seek(scrub.ppq);
      else drawPlayhead(scrub.ppq);
    };
    place();
    let queued = false;
    const move = (moveEvent) => {
      if (!scrub) return;
      scrub.ppq = at(moveEvent);
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; place(); });
    };
    const up = (upEvent) => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', cancel);
      const done = scrub; scrub = null;
      if (done) controller.seek(upEvent ? at(upEvent) : done.ppq);
    };
    const cancel = () => up(null);
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', cancel);
  }

  /** Redraw the clock ruler in place, for a tempo that moved under it. */
  function repaintTimeRuler() {
    const row = container?.querySelector('[data-seq-time-scale]');
    if (!row) return;
    const { zoom, scrollPpq } = controller.model.state;
    const endPpq = timelineEndPpq({
      barPpq: quartersPerBar(controller.signature),
      minimumPpq: TIMELINE_BEATS,
      contentEndPpq: controller.model.compositionEndPpq(),
      scrollPpq,
      viewportPpq: Math.max(16, ((container?.clientWidth || 0) - TRACK_HEADER) / zoom)
    });
    row.innerHTML = timeRulerMarkup(endPpq, zoom, controller.tempo, drawnWindow.startPpq, drawnWindow.endPpq);
    applyDynamicStyles(row);
    bindSeeks(row);
  }

  function renderMetronomeState(enabled) {
    const toggle = container?.querySelector('[data-action="toggle-metronome"]');
    toggle?.classList.toggle('active', enabled === true);
    toggle?.setAttribute('aria-checked', enabled === true ? 'true' : 'false');
  }

  function renderRecordMode(mode) {
    container?.querySelectorAll('[data-record-mode]')
      .forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.recordMode === mode)));
  }

  function renderMetronomeMode(mode) {
    container?.querySelectorAll('[data-metronome-mode]')
      .forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.metronomeMode === mode)));
  }

  function renderCountInState(event) {
    const element = container?.querySelector('.seq-record-status');
    if (!element) return;
    const status = transportStatus(event?.active === true);
    for (const tone of ['active', 'blocked', 'ready']) element.classList.toggle(tone, status.tone === tone);
    element.textContent = status.text;
  }

  /**
   * Play, Record and Stop are the header's (`ui/header.js`): the author removed
   * this page's own on 2026-09-24, so a take can be started from any page. What
   * stays here is the sentence under the title -- why nothing is heard, why a
   * take cannot start, that one is running -- because it reads this page's
   * tracks and it is here that you fix what it names.
   */
  function renderRecordingState() {
    renderCountInState({ active: controller.preCounting });
  }

  function pulseMetronome(event) {
    const light = container?.querySelector('[data-metronome-light]');
    if (!light) return;
    globalThis.clearTimeout(metronomePulseTimer);
    const tone = event?.preCount === true ? 'precount'
      : event?.accent === true || Number(event?.beatInBar) === 0 ? 'accent' : 'beat';
    light.classList.remove('pulse-precount', 'pulse-accent', 'pulse-beat');
    // Force a style flush so two quick, real clicks restart the short impulse.
    void light.offsetWidth;
    light.classList.add(`pulse-${tone}`);
    metronomePulseTimer = globalThis.setTimeout(() => {
      light.classList.remove('pulse-precount', 'pulse-accent', 'pulse-beat');
    }, 105);
  }

  function bindTrack(element) {
    const trackId = element.dataset.trackId;
    const track = controller.model.state.tracks.find((item) => item.id === trackId);
    // A 64 px head is almost all controls, so a click meant to select the track
    // kept landing on one of them: the button on its left edge is for that alone.
    element.querySelector('[data-track-action="select"]')?.addEventListener('click', (event) => {
      event.stopPropagation(); controller.focusTrack(trackId);
    });
    element.querySelector('[data-track-action="arm"]')?.addEventListener('click', (event) => {
      event.stopPropagation();
      controller.setTrackArmed(trackId, !track.armed, { additive: event.ctrlKey || event.metaKey || event.shiftKey });
    });
    element.querySelector('[data-track-action="monitor"]')?.addEventListener('click', (event) => {
      event.stopPropagation(); controller.setTrackMonitored(trackId, !track.monitored);
    });
    element.querySelector('[data-track-action="mute"]')?.addEventListener('click', () => controller.setTrack(trackId, { muted: !track.muted }));
    element.querySelector('[data-track-action="plugin"]')?.addEventListener('click', () => {
      const target = trackPlugin(hub, track);
      if (target) openPluginWhenReady(hub, target.nodeId, target.pluginInstanceId);
    });
    element.querySelector('[data-track-action="delete"]')?.addEventListener('click', () => controller.removeTrack(trackId));
    element.querySelector('[data-track-control="name"]')?.addEventListener('change', (event) => controller.setTrack(trackId, { name: event.target.value }));
    const volume = element.querySelector('[data-track-control="volume"]');
    volume?.addEventListener('input', (event) => {
      const gain = dbToGain(Number(event.target.value));
      const value = element.querySelector('[data-track-level-value]');
      if (value) value.textContent = formatGainDb(gain);
      controller.setTrackControl(trackId, { volume: gain }, { render: false });
    });
    volume?.addEventListener('change', (event) => controller.setTrackControl(
      trackId, { volume: dbToGain(Number(event.target.value)) }, { render: true }
    ));
    // The pan follows the fader's pattern: the engine hears every step of the
    // drag, the page is redrawn once, on release. A double-click centres it,
    // as a pan does in every workstation.
    const pan = element.querySelector('[data-track-control="pan"]');
    const showPan = (value) => {
      const output = element.querySelector('[data-track-pan-value]');
      if (output) output.textContent = formatPan(value);
    };
    pan?.addEventListener('input', (event) => {
      const value = Number(event.target.value) / 100;
      showPan(value);
      controller.setTrackControl(trackId, { pan: value }, { render: false });
    });
    pan?.addEventListener('change', (event) => controller.setTrackControl(
      trackId, { pan: Number(event.target.value) / 100 }, { render: true }
    ));
    pan?.addEventListener('dblclick', () => controller.setTrackControl(trackId, { pan: 0 }, { render: true }));
    const lane = element.querySelector('.seq-track-lane');
    element.addEventListener('click', (event) => {
      if (event.target.closest?.('.seq-clip,input,select,button,textarea,[contenteditable="true"]')) return;
      controller.focusTrack(trackId);
    });
    bindMeterMarks(lane, track);
    // The track's head too: a right-click there is where a track's settings
    // are looked for, and a lane full of clips leaves no empty space to click.
    element.querySelector('.seq-track-head')?.addEventListener('contextmenu', (event) => {
      if (event.target.closest?.('input,select,textarea')) return;
      event.preventDefault(); event.stopPropagation();
      const trackBar = meterBarAt(controller.model.trackRegions(track), controller.playheadPpq);
      openContextMenu({
        x: event.clientX, y: event.clientY,
        items: [
          { label: track.name },
          { separator: true },
          {
            label: `Time signature from bar ${trackBar.bar}…`, hint: formatSignature(trackBar.signature),
            action: () => openMeterMenu(event, track, trackBar.bar)
          },
          // The parameters it moves (D-065), each to be handed back to the hand.
          ...(track.automation?.length ? [{ separator: true }, { heading: 'Automation' }] : []),
          ...(track.automation || []).map((automation) => ({
            label: `Remove ${automation.pluginName ? `${automation.pluginName} — ` : ''}${automation.name}`,
            hint: `${automation.points.length} points`, danger: true,
            action: () => controller.removeAutomationLane(track.id, automation.id)
          }))
        ]
      });
    });
    lane?.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest?.('.seq-clip')) return;
      // Any fresh press ends the previous band's claim on the next click, so
      // the flag can never go stale across gestures.
      suppressLaneClick = false;
      startMarquee(event);
    });
    lane?.addEventListener('click', (event) => {
      if (event.target.closest?.('.seq-clip')) return;
      if (suppressLaneClick) { suppressLaneClick = false; return; }
      // A click in the empty lane also places the playhead, as in Ableton and
      // Reaper. Not during a take: a seek ends it. Measured before the
      // deselection, whose render replaces this lane.
      const state = controller.model.state;
      const ppq = timelinePpqAt(event.clientX, lane.getBoundingClientRect().left, state.zoom, state.snap, event.altKey, controller.projectRegions());
      controller.selectClip(null);
      if (!controller.recording && !controller.preCounting) controller.seek(ppq);
    });
    lane?.addEventListener('contextmenu', (event) => {
      if (event.target.closest?.('.seq-clip')) return;
      event.preventDefault(); event.stopPropagation();
      openLaneMenu(event, track, lane);
    });
    lane?.addEventListener('dblclick', async (event) => {
      if (event.target.closest('.seq-clip')) return;
      const ppq = Math.max(0, (event.offsetX || 0) / controller.model.state.zoom);
      if (track.type === 'midi') { controller.addMidiClip(trackId, ppq); }
      else await controller.importAudio(trackId, ppq);
    });
  }

  function bindClip(element) {
    // The active key is its own: a press on it neither drags, resizes nor
    // fades the clip, and a click on it does not select it.
    const muteKey = element.querySelector('[data-clip-mute]');
    muteKey?.addEventListener('pointerdown', (event) => { event.stopPropagation(); event.preventDefault(); });
    muteKey?.addEventListener('dblclick', (event) => { event.stopPropagation(); event.preventDefault(); });
    muteKey?.addEventListener('click', (event) => {
      event.stopPropagation(); event.preventDefault();
      const clip = controller.model._clip(element.dataset.clipId)?.clip;
      if (clip) controller.setClipsMuted([clip.id], !clip.muted);
    });
    element.addEventListener('click', (event) => {
      event.stopPropagation();
      if (suppressSelectionClickId === element.dataset.clipId) {
        suppressSelectionClickId = null;
        return;
      }
      if (!controller.selectClip(element.dataset.clipId, {
        render: false,
        toggle: event.ctrlKey || event.metaKey,
        range: event.shiftKey,
        additive: (event.ctrlKey || event.metaKey) && event.shiftKey
      })) return;
      const selected = new Set(controller.model.state.selectedClipIds);
      container.querySelectorAll('.seq-clip').forEach((clip) => clip.classList.toggle('selected', selected.has(clip.dataset.clipId)));
    });
    element.addEventListener('dblclick', (event) => {
      event.preventDefault(); event.stopPropagation(); controller.openClipEditor(element.dataset.clipId);
    });
    element.addEventListener('contextmenu', (event) => {
      event.preventDefault(); event.stopPropagation();
      const direction = fadeRegionFor(element, event);
      if (direction) openFadeMenu(event, element.dataset.clipId, direction);
      else openClipMenu(event, element.dataset.clipId);
    });
    if (element.classList.contains('audio')) {
      // The cursor says what a press would take, before it is pressed.
      element.addEventListener('pointermove', (event) => {
        if (fadeDrag) return;
        const zone = fadeZoneFor(element, event);
        if (zone) element.dataset.fadeZone = zone;
        else delete element.dataset.fadeZone;
      });
      element.addEventListener('pointerleave', () => { if (!fadeDrag) delete element.dataset.fadeZone; });
      // Registered before the move and resize press below, and stopping it:
      // a fade corner lies over the clip's resize edge, and the fade wins there.
      element.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        const zone = fadeZoneFor(element, event);
        if (!zone) return;
        event.preventDefault(); event.stopImmediatePropagation();
        startFadeDrag(event, element, zone);
      });
    }
    element.addEventListener('pointerdown', (event) => {
      event.preventDefault(); event.stopPropagation();
      const found = controller.model._clip(element.dataset.clipId); if (!found) return;
      const edge = event.target?.dataset?.resize || '';
      if (!controller.model.isClipSelected(found.clip.id)) {
        controller.selectClip(found.clip.id, {
          render: false,
          toggle: event.ctrlKey || event.metaKey,
          range: event.shiftKey,
          additive: (event.ctrlKey || event.metaKey) && event.shiftKey
        });
        suppressSelectionClickId = found.clip.id;
      } else {
        // Let a stationary click on an already-selected clip apply normal
        // single/toggle semantics. A real drag sets suppression on pointer-up.
        suppressSelectionClickId = null;
      }
      const selectedIds = edge ? [found.clip.id] : controller.model.selectedClipIds();
      drag = {
        kind: edge ? 'resize-clip' : 'move-clip', edge, clipId: found.clip.id,
        x: event.clientX, start: found.clip.startPpq, length: found.clip.lengthPpq,
        trackId: found.track.id, originalClip: structuredClone(found.clip),
        selectedIds, origins: controller.model.clipPlacements(selectedIds), dirty: false
      };
      for (const clip of container.querySelectorAll('.seq-clip')) {
        clip.classList.toggle('selected', controller.model.isClipSelected(clip.dataset.clipId));
        if (selectedIds.includes(clip.dataset.clipId)) clip.classList.add('dragging');
      }
      // `?.` guards a missing method, not a throwing one: setPointerCapture
      // rejects a pointer id that is no longer active, and the throw used to
      // abort this handler AFTER `drag` was armed and BEFORE the move
      // listeners were attached -- a drag that can never end.
      try { element.setPointerCapture?.(event.pointerId); } catch (_) { /* capture is a nicety */ }
      document.addEventListener('pointermove', pointerMove);
      document.addEventListener('pointerup', pointerUp, { once: true });
      document.addEventListener('pointercancel', pointerCancel, { once: true });
    });
  }

  // The fade gesture in progress, if any: one at a time, like every drag here.
  let fadeDrag = null;

  function clipGeometry(element, event) {
    const found = controller.model._clip(element.dataset.clipId);
    const rect = element.getBoundingClientRect?.();
    if (!found || !rect) return null;
    return { found, width: rect.width, height: rect.height, x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function fadeZoneFor(element, event) {
    const at = clipGeometry(element, event);
    return at ? fadeZoneAt(at.found.clip, controller.model.state.zoom, controller.tempo, at.width, at.height, at.x, at.y) : '';
  }

  function fadeRegionFor(element, event) {
    const at = clipGeometry(element, event);
    if (!at || at.found.track.type !== 'audio') return '';
    return fadeRegionAt(at.found.clip, controller.model.state.zoom, controller.tempo, at.width, at.x);
  }

  /** Redraw one clip's fades in place, while a drag bends or stretches them. */
  function repaintFades(element, clipId) {
    const found = controller.model._clip(clipId);
    if (!found) return;
    element.querySelectorAll('.seq-fade, .seq-fade-handle').forEach((node) => node.remove());
    const zoom = controller.model.state.zoom;
    const width = Math.max(CLIP_MIN_PX, found.clip.lengthPpq * zoom);
    element.querySelector('.seq-clip-resize.end')?.insertAdjacentHTML('beforebegin', fadeMarkup(found.clip, zoom, controller.tempo, width));
    applyDynamicStyles(element);
  }

  /**
   * Drag a fade's length, horizontally, or its curve, vertically. Previewed on
   * the model and in place, published once on release -- one undo step per
   * gesture -- and put back by Escape or a cancelled pointer.
   */
  function startFadeDrag(event, element, zone) {
    const clipId = element.dataset.clipId;
    const found = controller.model._clip(clipId);
    if (!found) return;
    const direction = zone.startsWith('in') ? 'in' : 'out';
    const key = direction === 'in' ? 'fadeIn' : 'fadeOut';
    const original = { ...found.clip[key] };
    const secondsPerPx = 60 / ((controller.tempo || 120) * Math.max(0.01, controller.model.state.zoom));
    const height = element.getBoundingClientRect?.().height || 1;
    const x0 = event.clientX;
    const y0 = event.clientY;
    let moved = false;
    fadeDrag = { clipId, zone };
    element.dataset.fadeZone = zone;
    element.classList.add('fading');
    const apply = (changes) => {
      controller.model.updateAudioClip(clipId, { [key]: changes }, { bpm: controller.tempo });
      repaintFades(element, clipId);
    };
    const move = (next) => {
      const dx = next.clientX - x0;
      const dy = next.clientY - y0;
      if (!moved && Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
      moved = true;
      if (zone.endsWith('length')) apply({ seconds: Math.max(0, original.seconds + (direction === 'in' ? dx : -dx) * secondsPerPx) });
      else apply({ curve: Math.max(-1, Math.min(1, original.curve - (dy / height) * 2)) });
    };
    const finish = (commit) => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', cancel);
      document.removeEventListener('keydown', escape, true);
      fadeDrag = null;
      element.classList.remove('fading');
      if (!moved) return;
      // A fade drag is not a click on the clip: its selection is left alone.
      suppressSelectionClickId = clipId;
      if (commit) controller.changed();
      else apply(original);
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    const escape = (key) => { if (key.key === 'Escape') { key.preventDefault(); finish(false); } };
    try { element.setPointerCapture?.(event.pointerId); } catch (_) { /* capture is a nicety */ }
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', cancel);
    document.addEventListener('keydown', escape, true);
  }

  /** The fade's menu: Reaper's seven shapes, pictured, then the low-pass sweep. */
  function openFadeMenu(event, clipId, direction) {
    const found = controller.model._clip(clipId);
    if (!found) return;
    const fade = found.clip[direction === 'in' ? 'fadeIn' : 'fadeOut'];
    openContextMenu({
      x: event.clientX, y: event.clientY,
      className: 'ctx-fade-menu',
      items: [
        ...FADE_SHAPES.map((name, shape) => ({
          label: name, icon: fadeShapeIcon(shape, direction), checked: fade.shape === shape,
          // A shape chosen is that shape, as its picture draws it: the bend
          // given by dragging the curve starts again from straight.
          action: () => controller.setClipFade(clipId, direction, { shape, curve: 0 })
        })),
        { separator: true },
        { label: 'Low pass fade', checked: fade.lowPass === true, action: () => controller.setClipFade(clipId, direction, { lowPass: !fade.lowPass }) }
      ]
    });
  }

  function dragState(clipId) {
    const found = controller.model._clip(clipId);
    return found ? JSON.stringify([
      found.track.id, found.clip.startPpq, found.clip.lengthPpq,
      found.clip.sourceOffsetPpq, found.clip.sourceLengthPpq,
      found.clip.trimStartSeconds, found.clip.trimEndSeconds
    ]) : '';
  }

  function pointerMove(event) {
    if (!drag) return;
    if (drag.kind === 'move-clip') {
      const targetTrackId = document.elementFromPoint?.(event.clientX, event.clientY)?.closest?.('.seq-track')?.dataset?.trackId || null;
      const crossedTrack = targetTrackId && targetTrackId !== drag.trackId;
      if (Math.abs(event.clientX - drag.x) < 2 && !crossedTrack) return;
      const before = JSON.stringify(drag.selectedIds.map(dragState));
      const changed = controller.moveClips(
        drag.selectedIds,
        (event.clientX - drag.x) / controller.model.state.zoom,
        targetTrackId,
        { anchorClipId: drag.clipId, origins: drag.origins, commit: false }
      );
      if (changed && dragState(drag.clipId) !== before) drag.dirty = true;
    }
    if (drag.kind === 'resize-clip') {
      if (Math.abs(event.clientX - drag.x) < 2) return;
      const delta = (event.clientX - drag.x) / controller.model.state.zoom;
      const before = dragState(drag.clipId);
      const changed = controller.resizeClip(drag.clipId, drag.edge === 'start' ? drag.start + delta : drag.length + delta, drag.edge, { commit: false });
      if (changed && dragState(drag.clipId) !== before) drag.dirty = true;
    }
    if (drag.dirty) renderDragPreview();
  }

  function renderDragPreview() {
    if (!drag || !container) return;
    const origins = new Map(drag.origins.map((origin) => [origin.clipId, origin]));
    for (const element of container.querySelectorAll('.seq-clip')) {
      if (!drag.selectedIds.includes(element.dataset.clipId)) continue;
      const found = controller.model._clip(element.dataset.clipId);
      const origin = origins.get(element.dataset.clipId);
      if (!found || !origin) continue;
      const zoom = controller.model.state.zoom;
      element.style.left = `${found.clip.startPpq * zoom}px`;
      element.style.width = `${Math.max(CLIP_MIN_PX, found.clip.lengthPpq * zoom)}px`;
      const currentTrackIndex = controller.model.state.tracks.indexOf(found.track);
      const trackDelta = currentTrackIndex - origin.trackIndex;
      const tops = trackLayout(controller.model.state).tops;
      element.style.transform = trackDelta ? `translateY(${tops[currentTrackIndex] - tops[origin.trackIndex]}px)` : '';
      // A resize changes which part of the source the clip shows -- the start
      // edge moves `sourceOffsetPpq`, the end edge moves `lengthPpq` -- so the
      // marks have to be rebuilt to stay where the music is. A move changes
      // neither, and rebuilding it every frame would be work for nothing.
      if (drag.kind !== 'resize-clip') continue;
      const preview = element.querySelector('.seq-midi-preview,.seq-waveform');
      if (!preview) continue;
      preview.outerHTML = clipContent(found.track, found.clip, zoom);
      applyDynamicStyles(element);
    }
  }

  function pointerUp() {
    document.removeEventListener('pointermove', pointerMove);
    document.removeEventListener('pointerup', pointerUp);
    document.removeEventListener('pointercancel', pointerCancel);
    if (drag?.dirty) {
      suppressSelectionClickId = drag.clipId;
      controller.changed();
    }
    else for (const clip of container?.querySelectorAll?.('.seq-clip') || []) clip.classList.remove('dragging');
    drag = null;
  }

  function pointerCancel() {
    document.removeEventListener('pointermove', pointerMove);
    document.removeEventListener('pointerup', pointerUp);
    document.removeEventListener('pointercancel', pointerCancel);
    if (drag?.dirty) {
      if (drag.kind === 'move-clip') controller.model.restoreClipPlacements(drag.origins);
      else {
        const found = controller.model._clip(drag.clipId);
        if (found) Object.assign(found.clip, structuredClone(drag.originalClip));
      }
      renderDragPreview();
    }
    for (const clip of container?.querySelectorAll?.('.seq-clip') || []) {
      clip.classList.remove('dragging');
      clip.style.transform = '';
    }
    suppressSelectionClickId = null;
    drag = null;
  }

  /**
   * The rubber band over the lanes.
   *
   * It begins on empty lane space and stays inert until the pointer has moved
   * three pixels, so a plain click still clears the selection and a
   * double-click still creates a clip -- the two gestures that already lived
   * on this element.
   *
   * Its anchor is a point of the TIMELINE, not of the screen: playback's
   * follow-scroll moves the arrangement under a band being drawn,
   * and repaints the canvas when it leaves the drawn window. So the canvas is
   * looked up at each draw, never kept, and the band is drawn again after a
   * repaint and after a scroll, not only when the pointer moves -- the way a
   * workstation's band stays pinned to where it began while the view runs on.
   */
  function startMarquee(event) {
    const canvas = container?.querySelector('[data-seq-canvas]');
    const rect = canvas?.getBoundingClientRect?.();
    if (!rect) return;
    marquee = {
      x0: event.clientX, y0: event.clientY,
      anchorX: event.clientX - rect.left, anchorY: event.clientY - rect.top,
      x: event.clientX, y: event.clientY, element: null, active: false,
      additive: event.ctrlKey || event.metaKey || event.shiftKey,
      baseIds: controller.model.selectedClipIds(), ids: []
    };
    document.addEventListener('pointermove', marqueeMove);
    document.addEventListener('pointerup', marqueeUp, { once: true });
    document.addEventListener('pointercancel', marqueeCancel, { once: true });
  }

  function marqueeMove(event) {
    if (!marquee) return;
    marquee.x = event.clientX;
    marquee.y = event.clientY;
    if (!marquee.active) {
      if (Math.abs(event.clientX - marquee.x0) < 3 && Math.abs(event.clientY - marquee.y0) < 3) return;
      marquee.active = true;
      marquee.element = document.createElement('div');
      marquee.element.setAttribute('class', 'seq-marquee');
    }
    drawMarquee();
  }

  function drawMarquee() {
    if (!marquee?.active) return;
    const canvas = container?.querySelector('[data-seq-canvas]');
    const rect = canvas?.getBoundingClientRect?.();
    if (!rect) return;
    if (marquee.element.parentNode !== canvas) canvas.appendChild(marquee.element);
    const zoom = controller.model.state.zoom;
    const x = marquee.x - rect.left;
    const y = marquee.y - rect.top;
    const left = Math.min(marquee.anchorX, x);
    const top = Math.min(marquee.anchorY, y);
    const width = Math.abs(x - marquee.anchorX);
    const height = Math.abs(y - marquee.anchorY);
    marquee.element.style.left = `${left}px`;
    marquee.element.style.top = `${top}px`;
    marquee.element.style.width = `${width}px`;
    marquee.element.style.height = `${height}px`;
    const covered = clipsInSpan(controller.model.state.tracks, {
      startPpq: (left - TRACK_HEADER) / zoom,
      endPpq: (left + width - TRACK_HEADER) / zoom,
      fromTrack: trackIndexAt(trackLayout(controller.model.state), top),
      toTrack: trackIndexAt(trackLayout(controller.model.state), top + height)
    });
    marquee.ids = [...new Set([...(marquee.additive ? marquee.baseIds : []), ...covered])];
    // Highlighted live, committed once: a re-render per pixel of the band
    // would rebuild the page under the pointer that is drawing it.
    const selected = new Set(marquee.ids);
    for (const element of container.querySelectorAll('.seq-clip')) {
      element.classList.toggle('selected', selected.has(element.dataset.clipId));
    }
  }

  function endMarquee(commit) {
    document.removeEventListener('pointermove', marqueeMove);
    document.removeEventListener('pointerup', marqueeUp);
    document.removeEventListener('pointercancel', marqueeCancel);
    const done = marquee; marquee = null;
    done?.element?.remove();
    if (!done?.active) return;
    if (!commit) {
      const selected = new Set(done.baseIds);
      for (const element of container?.querySelectorAll?.('.seq-clip') || []) {
        element.classList.toggle('selected', selected.has(element.dataset.clipId));
      }
      return;
    }
    // The lane's own click handler clears the selection; after a band it must
    // not undo the one thing the band just did.
    suppressLaneClick = true;
    controller.model.state.selectedClipIds = done.ids;
    controller.model.state.selectedClipId = done.ids.at(-1) || null;
    controller.model.state.selectionAnchorClipId = done.ids[0] || null;
    controller.changed({ syncNative: false, invalidateEditors: false });
  }

  function marqueeUp() { endMarquee(true); }
  function marqueeCancel() { endMarquee(false); }

  /** The point on the timeline a pointer event landed on, in quarters. */
  function ppqAtPointer(event, lane) {
    const rect = lane?.getBoundingClientRect?.();
    if (!rect) return controller.playheadPpq;
    return Math.max(0, (event.clientX - rect.left) / controller.model.state.zoom);
  }

  /**
   * The menu on a clip.
   *
   * Almost every entry is wiring to an operation the model already had and
   * only the mouse could reach. Split is the exception -- it is new -- and
   * Quantize takes the toolbar's Snap as its grid rather than opening a dialog
   * to ask for one: the value is already on screen, and an option offered is
   * a decision not taken.
   */
  function openClipMenu(event, clipId) {
    const model = controller.model;
    if (!model.isClipSelected(clipId)) controller.selectClip(clipId);
    const ids = model.selectedClipIds();
    const found = model._clip(clipId);
    if (!found) return;
    const many = ids.length > 1;
    const midi = ids.every((id) => model._clip(id)?.track.type === 'midi');
    const snap = model.state.snap;
    const splittable = ids.some((id) => {
      const target = model._clip(id);
      return target && controller.playheadPpq > target.clip.startPpq
        && controller.playheadPpq < target.clip.startPpq + target.clip.lengthPpq;
    });
    // The bar under the pointer, in the clip's own track: a lane full of clips
    // must still let its track's signature be changed from where you are.
    const clipTrack = found.track;
    const clipBar = meterBarAt(model.trackRegions(clipTrack),
      ppqAtPointer(event, event.target?.closest?.('.seq-track-lane')));
    openContextMenu({
      x: event.clientX, y: event.clientY,
      items: [
        { label: many ? `${ids.length} clips selected` : found.clip.name },
        { separator: true },
        { label: 'Open in Clip Editor', hint: 'Double-click', disabled: many, action: () => controller.openClipEditor(clipId) },
        { label: 'Split at playhead', hint: 'S', disabled: !splittable, action: () => controller.splitClips(ids) },
        { separator: true },
        { label: 'Cut', hint: 'Ctrl+X', action: () => controller.cutSelectedClips() },
        { label: 'Copy', hint: 'Ctrl+C', action: () => controller.copySelectedClips() },
        { label: 'Duplicate', hint: 'Ctrl+D', action: () => controller.duplicateSelectedClips() },
        { separator: true },
        ...((allMuted) => [{
          label: `${allMuted ? 'Activate' : 'Deactivate'} ${many ? `${ids.length} clips` : 'clip'}`,
          hint: allMuted ? 'heard again' : 'kept, not heard',
          action: () => controller.setClipsMuted(ids, !allMuted)
        }])(ids.every((id) => model._clip(id)?.clip.muted)),
        { separator: true },
        { label: `Quantize to ${snap}`, disabled: !midi, action: () => controller.quantizeClips(ids, { grid: snap, strength: 100 }) },
        { separator: true },
        ...(clipTrack ? [{
          label: `Time signature from bar ${clipBar.bar}…`, hint: formatSignature(clipBar.signature),
          action: () => openMeterMenu(event, clipTrack, clipBar.bar)
        }, { separator: true }] : []),
        { label: many ? `Delete ${ids.length} clips` : 'Delete', hint: 'Del', danger: true, action: () => controller.deleteSelectedClips() }
      ]
    });
  }

  /**
   * The signatures a track can take from one of its bars (D-060). The common
   * ones are listed; any other -- 13/16 -- is typed, as the Patch Bay's
   * plugins are, since 128 entries is a list to search, not to read.
   */
  function openMeterMenu(event, track, bar) {
    // `track` null is the project's own signature, from the ruler (D-061).
    const regions = controller.model.trackRegions(track);
    const current = formatSignature(meterBarAt(regions, meterBarPpq(regions, bar)).signature);
    const changes = track ? (track.meter || []) : (controller.model.state.meter || []);
    const change = changes.find((item) => item.bar === bar);
    const apply = (signature) => (track
      ? controller.setTrackMeterChange(track.id, bar, signature)
      : controller.setProjectMeterChange(bar, signature));
    const entry = (text, searchOnly = false) => {
      const [numerator, denominator] = text.split('/').map(Number);
      return {
        label: text, searchOnly, hint: text === current ? 'current' : '',
        action: () => apply({ numerator, denominator })
      };
    };
    const every = [];
    for (let numerator = 1; numerator <= SIGNATURE_NUMERATOR_MAX; numerator += 1) {
      for (const denominator of SIGNATURE_DENOMINATORS) {
        const text = `${numerator}/${denominator}`;
        if (!COMMON_SIGNATURES.includes(text)) every.push(entry(text, true));
      }
    }
    openContextMenu({
      x: event.clientX, y: event.clientY,
      search: { placeholder: 'A signature, or type one: 13/16' },
      items: [
        { heading: track ? `${track.name} from its bar ${bar}` : `Project from bar ${bar}` },
        ...COMMON_SIGNATURES.map((text) => entry(text)),
        ...every,
        ...(change ? [{ separator: true }, {
          label: 'Remove this change', danger: true,
          action: () => apply(null)
        }] : [])
      ]
    });
  }

  /** The menu on empty lane space: what a double-click does, plus paste. */
  function openLaneMenu(event, track, lane) {
    const ppq = ppqAtPointer(event, lane);
    const trackBar = meterBarAt(controller.model.trackRegions(track), ppq);
    openContextMenu({
      x: event.clientX, y: event.clientY,
      items: [
        { label: track.name },
        { separator: true },
        ...(trackPlugin(hub, track) ? [{ label: 'Open Plugin Window', action: () => { const target = trackPlugin(hub, track); if (target) openPluginWhenReady(hub, target.nodeId, target.pluginInstanceId); } }, { separator: true }] : []),
        track.type === 'midi'
          ? { label: 'New MIDI clip here', hint: 'Double-click', action: () => { controller.addMidiClip(track.id, ppq); } }
          : { label: 'Import audio here…', hint: 'Double-click', action: () => { controller.importAudio(track.id, ppq); } },
        { label: 'Paste here', hint: 'Ctrl+V', disabled: !controller.hasClipboard(), action: () => controller.pasteClips(ppq) },
        { separator: true },
        {
          label: `Time signature from bar ${trackBar.bar}…`, hint: formatSignature(trackBar.signature),
          action: () => openMeterMenu(event, track, trackBar.bar)
        },
        { separator: true },
        { label: 'Select all clips', hint: 'Ctrl+A', action: () => controller.selectAllClips() }
      ]
    });
  }

  /**
   * Move the selection by one snap step, or across one track.
   *
   * The mouse was the only vocabulary the arrangement had, and a clip cannot
   * be placed accurately with it at any zoom. `moveClips` already knows how to
   * carry a group with one common delta; this only names the delta.
   */
  function nudgeSelection(deltaPpq, trackDelta = 0) {
    const ids = controller.model.selectedClipIds();
    if (!ids.length) return false;
    const anchorClipId = controller.model.state.selectedClipId || ids[0];
    const found = controller.model._clip(anchorClipId);
    if (!found) return false;
    let targetTrackId = null;
    if (trackDelta) {
      const target = controller.model.state.tracks[controller.model.state.tracks.indexOf(found.track) + trackDelta];
      if (!target) return false;
      targetTrackId = target.id;
    }
    return controller.moveClips(ids, deltaPpq, targetTrackId, { anchorClipId });
  }

  function keyDown(event) {
    if (!container || !paneHasKeys(container)) return;
    if (event.target?.closest?.('input,select,textarea,[contenteditable="true"]')) return;
    if (event.key === 'Escape' && (drag || marquee)) {
      event.preventDefault();
      if (drag) pointerCancel();
      if (marquee) marqueeCancel();
      return;
    }
    const command = event.ctrlKey || event.metaKey;
    const key = String(event.key).toLowerCase();
    if (command && key === 'c') {
      if (controller.copySelectedClips()) event.preventDefault();
      return;
    }
    if (command && key === 'x') {
      if (controller.cutSelectedClips()) event.preventDefault();
      return;
    }
    if (command && key === 'v') {
      if (controller.pasteClips().length) event.preventDefault();
      return;
    }
    if (command && key === 'd') {
      if (controller.duplicateSelectedClips().length) event.preventDefault();
      return;
    }
    if (command && key === 'a') {
      if (controller.selectAllClips()) event.preventDefault();
      return;
    }
    // Bare +/- rather than Ctrl+ +/-: those belong to Chromium's own page zoom
    // and taking them would fight the shell.
    if (!command && (event.key === '+' || event.key === '=')) {
      event.preventDefault();
      zoomAt(controller.model.state.zoom * 1.25, TRACK_HEADER + viewportPx() / 2);
      return;
    }
    if (!command && event.key === '-') {
      event.preventDefault();
      zoomAt(controller.model.state.zoom / 1.25, TRACK_HEADER + viewportPx() / 2);
      return;
    }
    if (!controller.model.state.selectedClipIds.length) return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      controller.deleteSelectedClips();
      return;
    }
    const step = snapStep(controller.model.state.snap, controller.signature);
    const nudges = {
      ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]
    };
    if (!command && key === 's') {
      event.preventDefault();
      controller.splitClips();
      return;
    }
    if (nudges[event.key]) {
      event.preventDefault();
      nudgeSelection(...nudges[event.key]);
    }
  }

  function mount(element) {
    container = element;
    container.classList.add('sequencer-workspace');
    if (typeof globalThis.ResizeObserver === 'function') {
      resizeObserver = new globalThis.ResizeObserver(resizeRender);
      resizeObserver.observe(container);
    } else {
      globalThis.window?.addEventListener?.('resize', resizeRender);
    }
    unsubs.push(
      hub.events.on('sequencer:changed', render),
      hub.events.on('sequencer:recording', renderRecordingState),
      hub.events.on('sequencer:count-in', renderCountInState),
      hub.events.on('sequencer:tempo', renderTempoValue),
      hub.events.on('sequencer:metronome', renderMetronomeState),
      hub.events.on('sequencer:metronome-mode', renderMetronomeMode),
      hub.events.on('sequencer:record-mode', renderRecordMode),
      hub.events.on('sequencer:metronome-tick', pulseMetronome),
      hub.events.on('engine:deviceState', render),
      hub.events.on('midi:ports', render),
      hub.events.on('midi:preference', render),
      hub.events.on('network:change', render),
      hub.events.on('sequencer:playhead', movePlayhead)
    );
    document.addEventListener('keydown', keyDown); render();
  }

  function unmount() {
    closeContextMenu();
    marqueeCancel();
    unsubs.forEach((off) => off()); unsubs = [];
    document.removeEventListener('keydown', keyDown);
    pointerCancel();
    tempoBindingCleanup?.(); tempoBindingCleanup = null;
    globalThis.clearTimeout(metronomePulseTimer); metronomePulseTimer = null;
    resizeObserver?.disconnect(); resizeObserver = null;
    globalThis.window?.removeEventListener?.('resize', resizeRender);
    resizeRenderQueued = false;
    container?.classList.remove('sequencer-workspace');
    container = null; drag = null; marquee = null; suppressLaneClick = false; scrub = null;
    scrollTopPx = 0;
  }

  return {
    id: 'sequencer', name: 'Sequencer',
    navEntry: { label: 'Sequencer', icon: 'sequencer', group: 'system', fixed: true },
    // What a plugin cabled into the Sequencer node's CTRL IN may command.
    controlCommands: () => sequencerCommands(hub),
    mount, unmount
  };
}
