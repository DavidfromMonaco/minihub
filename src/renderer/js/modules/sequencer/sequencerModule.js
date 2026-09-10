import { escapeHtml } from '../../core/html.js';
import { SEQUENCER_LIMITS, SNAP_STEPS, ZOOM_MAX, ZOOM_MIN, snapStep } from '../../core/sequencerModel.js';
import { bindTempoInput } from '../../core/tempoControl.js';
import { isCanonicalMidiIngress } from '../../core/sequencerController.js';
import { closeContextMenu, openContextMenu } from '../../ui/contextMenu.js';

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
const TRACK_HEIGHT = 64;
const RULER_HEIGHT = 30;
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
 * The rail thumb, and the scroll position a point on the rail asks for.
 *
 * One function for both directions, because they are inverses: drawing the
 * thumb and reading a drag on it have to use the same mapping, or the thumb
 * jumps out from under the pointer that grabbed it. `null` means the whole
 * arrangement already fits, and a full-width thumb that cannot move is
 * furniture -- the rail hides itself instead.
 */
export function railThumb({
  scrollLeft = 0, scrollWidth = 0, clientWidth = 0, railWidth = 0, inset = 3, minSize = 22
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

const gainToDb = (gain) => gain > 0
  ? Math.max(-60, Math.min(6, 20 * Math.log10(gain))) : -60;
const dbToGain = (db) => db <= -60 ? 0 : 10 ** (db / 20);
const formatDb = (gain) => {
  const db = gainToDb(gain);
  return db <= -60 ? '−∞ dB' : `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
};

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
  root.querySelectorAll('[data-seq-beat]').forEach((element) => { element.style.setProperty('--seq-beat', `${Number(element.dataset.seqBeat) || 0}px`); });
  // `.seq-corner` and `.seq-empty` both need the header width and used to
  // spell it themselves, in two different values. One declaration, published
  // to the stylesheet.
  root.querySelectorAll('[data-seq-head]').forEach((element) => { element.style.setProperty('--seq-head', `${Number(element.dataset.seqHead) || 0}px`); });
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
  return `<span class="seq-midi-preview">${clip.notes
    .filter((note) => note.startPpq + note.durationPpq > sourceOffset && note.startPpq < sourceEnd)
    .map((note) => {
      const visibleStart = Math.max(sourceOffset, note.startPpq);
      const visibleEnd = Math.min(sourceEnd, note.startPpq + note.durationPpq);
      return `<i data-seq-left="${(visibleStart - sourceOffset) * zoom}" data-seq-width="${Math.max(1, (visibleEnd - visibleStart) * zoom)}" data-seq-bottom-pct="${Math.max(2, (note.pitch - 24) / 104 * 70)}"></i>`;
    }).join('')}</span>`;
}

function clipMarkup(track, clip, zoom, selected) {
  const left = clip.startPpq * zoom;
  const width = Math.max(CLIP_MIN_PX, clip.lengthPpq * zoom);
  const content = clipContent(track, clip, zoom);
  const unavailable = track.type === 'audio' && clip.mediaAvailable === false;
  const title = unavailable ? `${clip.name} — ${clip.mediaError || 'Audio media is unavailable'}` : clip.name;
  return `<button class="seq-clip ${track.type} ${selected ? 'selected' : ''} ${unavailable ? 'unavailable' : ''}" data-clip-id="${clip.id}" data-track-id="${track.id}" data-seq-left="${left}" data-seq-width="${width}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">
    <span class="seq-clip-resize start" data-resize="start" aria-hidden="true"></span><span class="seq-clip-name">${escapeHtml(clip.name)}</span>${unavailable ? '<span class="seq-clip-media-error">Missing media</span>' : content}<span class="seq-clip-resize end" data-resize="end" aria-hidden="true"></span></button>`;
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

function trackDestinations(hub, track) {
  if (track.type === 'midi') return hub.network.listNodes().filter((node) => ['vst', 'arpeggiator'].includes(node.type)).map((node) => ({
    id: node.id,
    name: node.type === 'vst' ? `${node.name} — VST chain`
      : `${node.name} — Arpeggiator`
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
  return `<div class="seq-inspector" data-track-inspector>
    <span class="seq-inspector-label">Track</span><strong class="seq-inspector-name">${escapeHtml(track.name)}</strong>
    <label class="seq-inspector-field"><span>Input</span><select data-inspector-control="input" aria-label="${escapeHtml(track.name)} input">${options(trackSources(hub, track), track.inputId, inputPlaceholder(hub, track))}</select></label>
    <label class="seq-inspector-field"><span>Destination</span><select data-inspector-control="output" aria-label="${escapeHtml(track.name)} destination">${options(trackDestinations(hub, track), track.outputId, destinationPlaceholder(hub, track))}</select></label>
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
 * musical division -- the narrowest multiple of the quarter still worth
 * looking at.
 */
export function gridPx(zoom) {
  const step = Math.max(0.01, Number(zoom) || 0);
  for (const quarters of [1, 2, 4, 8, 16, 32, 64]) {
    if (quarters * step >= 12) return quarters * step;
  }
  return 64 * step;
}

export function rulerStride(bars, zoom) {
  const barPx = Math.max(0.01, 4 * (Number(zoom) || 0));
  const wanted = Math.max(RULER_MIN_MARK_PX / barPx, Math.max(1, Number(bars) || 1) / 512, 1);
  return 2 ** Math.ceil(Math.log2(wanted));
}

function rulerMarkup(endPpq, zoom) {
  const bars = Math.ceil(endPpq / 4);
  const stride = rulerStride(bars, zoom);
  return Array.from({ length: Math.ceil(bars / stride) }, (_, index) => index * stride)
    .map((bar) => `<button class="seq-ruler-mark" data-seek="${bar * 4}" data-seq-left="${bar * 4 * zoom}" data-seq-width="${4 * stride * zoom}"><strong>${bar + 1}</strong></button>`).join('');
}

export function createSequencerModule(hub) {
  const controller = hub.sequencer;
  let container = null;
  let unsubs = [];
  let drag = null;
  let scrollRenderQueued = false;
  let resizeObserver = null;
  let resizeRenderQueued = false;
  let suppressSelectionClickId = null;
  let marquee = null;
  let suppressLaneClick = false;
  let tempoBindingCleanup = null;
  let metronomePulseTimer = null;
  let exportOptions = { format: 'wav', bits: 24, bitrateKbps: 320, qualityIndex: -1, tailSeconds: 2 };
  let exportStatus = null;

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
   * The horizontal scroll rail.
   *
   * Chromium's own horizontal scrollbar is a wide light slab under the
   * arrangement, and it was the first thing the author pointed at. This draws
   * the same information as four dark pixels: where you are, how much of the
   * arrangement you can see, and it is draggable. It lives OUTSIDE
   * `.seq-scroll` on purpose -- inside it, it would scroll away with the
   * content it describes.
   *
   * It hides itself when everything already fits, because a full-width thumb
   * that cannot move is furniture.
   */
  function railGeometry() {
    const rail = container?.querySelector('[data-seq-rail]');
    const scroller = container?.querySelector('[data-timeline-scroll]');
    if (!rail || !scroller) return null;
    // The position comes from the model, not from `scroller.scrollLeft`.
    // `render()` assigns that property and then draws the rail, and an
    // assignment made on freshly inserted DOM can still be clamped to zero
    // when it is read back -- which drew the thumb at the far left while the
    // view sat in the middle of the arrangement. `scrollPpq` is the value the
    // render is applying, so it is the value the rail must agree with. The two
    // measurements stay measurements.
    const thumb = railThumb({
      scrollLeft: controller.model.state.scrollPpq * controller.model.state.zoom,
      scrollWidth: scroller.scrollWidth,
      clientWidth: scroller.clientWidth,
      railWidth: rail.clientWidth
    });
    return { rail, scroller, thumb };
  }

  function renderRail() {
    const rail = container?.querySelector('[data-seq-rail]');
    const element = container?.querySelector('[data-seq-rail-thumb]');
    if (!rail || !element) return;
    // Laid out BEFORE it is measured. `hidden` collapses the rail to zero
    // width, and deciding whether to show it from that width is a deadlock:
    // hidden, therefore unmeasurable, therefore hidden.
    rail.hidden = false;
    const geometry = railGeometry();
    if (!geometry?.thumb) { rail.hidden = true; return; }
    element.style.width = `${geometry.thumb.size}px`;
    element.style.left = `${geometry.thumb.left}px`;
  }

  /** Drag the rail, or click a point on it. Both land on the same arithmetic:
   *  the thumb's travel maps onto the scroller's. */
  function bindRail() {
    const rail = container?.querySelector('[data-seq-rail]');
    const scroller = container?.querySelector('[data-timeline-scroll]');
    if (!rail || !scroller) return;
    const seekTo = (clientX) => {
      const rect = rail.getBoundingClientRect?.();
      const geometry = railGeometry();
      if (!rect || !geometry?.thumb) return;
      scroller.scrollLeft = geometry.thumb.scrollFor(clientX - rect.left);
    };
    rail.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      rail.classList.add('dragging');
      seekTo(event.clientX);
      const move = (moveEvent) => seekTo(moveEvent.clientX);
      const up = () => {
        rail.classList.remove('dragging');
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        document.removeEventListener('pointercancel', up);
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up, { once: true });
      document.addEventListener('pointercancel', up, { once: true });
    });
  }

  /**
   * Middle-button drag pans the timeline, both axes at once.
   *
   * The gesture nothing else claims: left is selection and clips, right is the
   * context menu, and the Patch Bay already spends right-drag on its own pan.
   */
  function bindPan() {
    const scroller = container?.querySelector('[data-timeline-scroll]');
    if (!scroller) return;
    scroller.addEventListener('pointerdown', (event) => {
      if (event.button !== 1) return;
      event.preventDefault();
      const from = { x: event.clientX, y: event.clientY, left: scroller.scrollLeft, top: scroller.scrollTop };
      scroller.classList.add('panning');
      const move = (moveEvent) => {
        scroller.scrollLeft = from.left - (moveEvent.clientX - from.x);
        scroller.scrollTop = from.top - (moveEvent.clientY - from.y);
      };
      const up = () => {
        scroller.classList.remove('panning');
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

  /** Move the cursor, and carry the view with it when it would leave the
   *  screen. Recording used to pin the viewport to the opening bars while the
   *  take ran on somewhere off-screen, so the timeline stopped answering the
   *  one question it exists to answer: where am I. */
  function movePlayhead(ppq) {
    if (!container) return;
    const zoom = controller.model.state.zoom;
    const head = container.querySelector('[data-playhead]');
    if (head) head.style.left = `${TRACK_HEADER + ppq * zoom}px`;
    const scroller = container.querySelector('[data-timeline-scroll]');
    if (!scroller) return;
    const viewportPpq = Math.max(16, (container.clientWidth - TRACK_HEADER) / zoom);
    const next = followScrollPpq(ppq, controller.model.state.scrollPpq, viewportPpq);
    if (next === null) return;
    // Assigning scrollLeft raises the scroller's own listener, which republishes
    // scrollPpq and repaints the clips that just entered the window.
    controller.model.state.scrollPpq = next;
    scroller.scrollLeft = next * zoom;
    renderRail();
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
        <span class="pill accent-sequencer">Patch Bay required</span>
        <h1 class="page-title">Add a Sequencer node to start arranging</h1>
        <p>The timeline runs through a real Sequencer node and its visible cables. Open Patch Bay, choose <strong>Sequencer</strong>, then click <strong>+ New Node</strong>.</p>
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
    const endPpq = Math.max(TIMELINE_BEATS, controller.model.compositionEndPpq() + 16);
    const timelineWidth = endPpq * zoom;
    const gridLinePx = gridPx(zoom);
    const viewportPpq = Math.max(16, (container.clientWidth - TRACK_HEADER) / zoom);
    const visibleStart = Math.max(0, state.scrollPpq - viewportPpq);
    const visibleEnd = state.scrollPpq + viewportPpq * 2;
    const atTrackLimit = state.tracks.length >= SEQUENCER_LIMITS.tracks;
    const recordBlockReason = controller.recordBlockReason();
    const status = transportStatus();
    const focusedTrack = state.tracks.find((track) => track.id === state.focusedTrackId) || null;
    const exportFormat = ['wav', 'mp3', 'ogg'].includes(exportOptions.format) ? exportOptions.format : 'wav';
    const capabilities = controller.exportCapabilities || {};
    const oggQualities = Array.isArray(capabilities.oggQualityOptions) ? capabilities.oggQualityOptions : [];
    const selectedOggQuality = exportOptions.qualityIndex >= 0
      ? Math.min(exportOptions.qualityIndex, Math.max(0, oggQualities.length - 1))
      : Math.max(0, oggQualities.length - 1);
    const exportPercent = Number.isFinite(Number(exportStatus?.progress))
      ? `${Math.round(Number(exportStatus.progress) * 100)}%` : '';
    const exportSpeed = Number.isFinite(Number(exportStatus?.realtimeSpeed))
      && Number(exportStatus.realtimeSpeed) > 0
      ? `${Number(exportStatus.realtimeSpeed).toFixed(2)}× realtime` : '';
    const exportStage = String(exportStatus?.stage || '').replaceAll('-', ' ');
    const exportStateText = exportStatus?.state === 'complete' ? `Saved ${exportStatus.filePath}`
      : exportStatus?.state === 'error' ? exportStatus.message
        : exportStatus?.state === 'cancelled' ? 'Export cancelled'
          : exportStatus?.state === 'preparing' ? `Preparing export…${exportStage ? ` ${exportStage}` : ''}`
            : exportStatus?.state === 'finalizing' ? 'Finalizing and closing file…'
              : controller.exporting ? `Rendering offline…${exportPercent ? ` ${exportPercent}` : ''}${exportSpeed ? ` · ${exportSpeed}` : ''}` : '';
    scrollRenderQueued = false;
    // The menu points at DOM that is about to be replaced, and at a clip that
    // may no longer exist.
    closeContextMenu();
    container.innerHTML = `<div class="sequencer-page">
      <section class="panel seq-toolbar">
        <div class="row"><h1 class="page-title">Sequencer</h1><span class="pill">${state.tracks.length} tracks</span><span class="spacer"></span>
          <button class="btn" data-action="add-midi" ${atTrackLimit ? 'disabled title="64-track project limit reached"' : ''}>+ MIDI Track</button><button class="btn" data-action="add-audio" ${atTrackLimit ? 'disabled title="64-track project limit reached"' : ''}>+ Audio Track</button>
          <button class="btn seq-nav-icon" data-action="go-start" title="Go to Start" aria-label="Go to Start"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4v16M19 5l-10 7 10 7z"/></svg></button>
          <button class="btn seq-nav-icon" data-action="go-end" title="Go to End" aria-label="Go to End"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 4v16M5 5l10 7-10 7z"/></svg></button>
          <button class="btn seq-play ${controller.playing ? 'active' : ''}" data-action="play" aria-pressed="${controller.playing}">Play</button>
          <button class="btn seq-record ${controller.recording ? 'active' : (recordBlockReason ? 'blocked' : '')}" data-action="start-record" ${controller.recording ? 'disabled' : ''} title="${escapeHtml(recordBlockReason || 'Start recording')}">Record</button>
          <button class="btn seq-stop" data-action="stop" ${controller.playing || controller.recording ? '' : 'disabled'}>Stop</button>
          <label class="seq-tempo-control">Tempo <input class="tempo-input" data-control="tempo" type="number" min="20" max="300" step="1" value="${controller.tempo}" aria-label="Sequencer tempo in BPM"><span>BPM</span></label>
          <div class="seq-metronome-control">
            <span class="seq-metronome-label">Métronome</span>
            <button class="seq-metronome-switch ${controller.metronomeEnabled ? 'active' : ''}" type="button" role="switch" aria-checked="${controller.metronomeEnabled}" data-action="toggle-metronome" aria-label="Activer ou désactiver le métronome"><span aria-hidden="true"></span></button>
            <span class="seq-metronome-light" data-metronome-light aria-label="Voyant du métronome" role="status"></span>
          </div>
          <button class="btn primary" data-action="export" ${controller.exporting ? 'disabled' : ''}>Export ${exportFormat.toUpperCase()}</button>
        </div>
        <div class="seq-record-status ${status.tone}" role="status">${escapeHtml(status.text)}</div>
        ${inspectorMarkup(hub, focusedTrack, sequencerNode.id)}
        <div class="row mt-12 seq-tools"><label>Snap <select data-control="snap">${Object.keys(SNAP_STEPS).map((value) => `<option ${value === state.snap ? 'selected' : ''}>${value}</option>`).join('')}</select></label>
          <label class="seq-zoom-control">Zoom <input data-control="zoom" type="range" min="0" max="100" value="${zoomToSlider(zoom)}" aria-label="Timeline zoom"><button class="btn seq-zoom-btn" data-action="zoom-fit" title="Frame the whole arrangement (Ctrl+wheel zooms under the cursor)">Fit</button><button class="btn seq-zoom-btn" data-action="zoom-focus" title="Frame the selected clips, or the loop range">Focus</button></label>
          <label><input data-control="loop-enabled" type="checkbox" ${state.loop.enabled ? 'checked' : ''}> Loop</label>
          <label>From <input data-control="loop-start" type="number" min="0" step="0.125" value="${state.loop.startPpq}"></label>
          <label>To <input data-control="loop-end" type="number" min="0.125" step="0.125" value="${state.loop.endPpq}"></label>
          <div class="seq-export-panel" aria-label="Sequencer export options">
            <label>Format <select data-control="export-format"><option value="wav" ${exportFormat === 'wav' ? 'selected' : ''}>WAV</option><option value="mp3" ${exportFormat === 'mp3' ? 'selected' : ''} ${capabilities.mp3Available === false ? 'disabled' : ''}>MP3</option><option value="ogg" ${exportFormat === 'ogg' ? 'selected' : ''}>OGG Vorbis</option></select></label>
            ${exportFormat === 'wav' ? `<label>Bit depth <select data-control="wav-bits">${[16,24,32].map((bits) => `<option value="${bits}" ${Number(exportOptions.bits) === bits ? 'selected' : ''}>${bits}-bit</option>`).join('')}</select></label>` : ''}
            ${exportFormat === 'mp3' ? `<label>Bitrate <select data-control="mp3-bitrate">${[128,192,256,320].map((rate) => `<option value="${rate}" ${Number(exportOptions.bitrateKbps) === rate ? 'selected' : ''}>${rate} kbps</option>`).join('')}</select></label>` : ''}
            ${exportFormat === 'ogg' ? `<label>Quality <select data-control="ogg-quality">${oggQualities.length ? oggQualities.map((quality,index) => `<option value="${index}" ${selectedOggQuality === index ? 'selected' : ''}>${escapeHtml(quality)}</option>`).join('') : '<option value="-1">High (engine default)</option>'}</select></label>` : ''}
            <label>Tail <input data-control="tail" type="number" min="0" max="30" step="0.5" value="${exportOptions.tailSeconds}"> s</label>
            <button class="btn" data-action="export-loop" ${state.loop.enabled && !controller.exporting ? '' : 'disabled'}>Export Loop</button>
            <button class="btn" data-action="cancel-export" ${controller.exporting ? '' : 'disabled'}>Cancel</button>
            <span class="seq-export-state" data-export-state>${escapeHtml(exportStateText || '')}</span>
          </div>
        </div>
      </section>
      <section class="panel seq-arrangement">
        <div class="seq-scroll" data-timeline-scroll>
          <div class="seq-canvas" data-seq-canvas data-seq-head="${TRACK_HEADER}" data-seq-width="${TRACK_HEADER + timelineWidth}" data-seq-height="${RULER_HEIGHT + Math.max(1, state.tracks.length) * TRACK_HEIGHT}">
            <div class="seq-corner">TRACKS</div><div class="seq-ruler" data-seq-left="${TRACK_HEADER}" data-seq-width="${timelineWidth}" data-seq-beat="${gridLinePx}">${rulerMarkup(endPpq, zoom)}</div>
            <div class="seq-loop-range ${state.loop.enabled ? 'enabled' : ''}" data-seq-left="${TRACK_HEADER + state.loop.startPpq * zoom}" data-seq-width="${(state.loop.endPpq - state.loop.startPpq) * zoom}" data-seq-height="${RULER_HEIGHT + Math.max(1, state.tracks.length) * TRACK_HEIGHT}"></div>
            ${state.tracks.length ? state.tracks.map((track, index) => `<div class="seq-track ${state.focusedTrackId === track.id ? 'focused' : ''}" data-track-id="${track.id}" data-seq-top="${RULER_HEIGHT + index * TRACK_HEIGHT}" data-seq-height="${TRACK_HEIGHT}">
              <div class="seq-track-head" data-seq-width="${TRACK_HEADER}">
                <button class="seq-arm ${track.armed ? 'active' : ''}" data-track-action="arm" title="Arm">R</button>
                <button class="seq-monitor ${track.monitored ? 'active' : ''}" data-track-action="monitor" title="Input monitor">I</button>
                <input class="seq-track-name" data-track-control="name" value="${escapeHtml(track.name)}">
                <button class="seq-mute ${track.muted ? 'active' : ''}" data-track-action="mute" title="Mute">M</button>
                <button class="seq-track-delete" data-track-action="delete" title="Delete track">×</button>
                <label class="seq-track-level"><input data-track-control="volume" type="range" min="-60" max="6" step="0.1" value="${gainToDb(track.volume)}" aria-label="${escapeHtml(track.name)} level in dB"><output data-track-level-value>${formatDb(track.volume)}</output></label>
                ${routeDots(routeStates(hub, track, sequencerNode.id))}
              </div>
              <div class="seq-track-lane" data-seq-left="${TRACK_HEADER}" data-seq-width="${timelineWidth}" data-seq-beat="${gridLinePx}">${track.clips.filter((clip) => clip.startPpq + clip.lengthPpq >= visibleStart && clip.startPpq <= visibleEnd).map((clip) => clipMarkup(track, clip, zoom, selectedClipIds.has(clip.id))).join('')}</div>
            </div>`).join('') : `<div class="seq-empty" data-seq-top="${RULER_HEIGHT}">Create a MIDI or audio track to begin.</div>`}
            <div class="seq-playhead" data-playhead data-seq-left="${TRACK_HEADER + controller.playheadPpq * zoom}" data-seq-height="${RULER_HEIGHT + Math.max(1, state.tracks.length) * TRACK_HEIGHT}"></div>
          </div>
        </div>
        <div class="seq-rail" data-seq-rail hidden><div class="seq-rail-thumb" data-seq-rail-thumb></div></div>
      </section>
    </div>`;
    applyDynamicStyles(container);
    bind();
    const scroller = container.querySelector('[data-timeline-scroll]');
    if (scroller) scroller.scrollLeft = state.scrollPpq * zoom;
    renderRail();
  }

  function bind() {
    container.querySelector('[data-action="add-midi"]')?.addEventListener('click', () => { controller.model.addTrack('midi'); controller.changed(); });
    container.querySelector('[data-action="add-audio"]')?.addEventListener('click', () => { controller.model.addTrack('audio'); controller.changed(); });
    container.querySelector('[data-action="go-start"]')?.addEventListener('click', () => controller.goToStart());
    container.querySelector('[data-action="go-end"]')?.addEventListener('click', () => controller.goToEnd());
    container.querySelector('[data-action="play"]')?.addEventListener('click', () => controller.playTransport());
    container.querySelector('[data-action="start-record"]')?.addEventListener('click', () => controller.startRecording({ notify: true }));
    container.querySelector('[data-action="stop"]')?.addEventListener('click', () => controller.stopTransport());
    const tempoInput = container.querySelector('[data-control="tempo"]');
    tempoBindingCleanup = bindTempoInput(tempoInput, (tempo) => controller.setTempo(tempo));
    container.querySelector('[data-action="toggle-metronome"]')?.addEventListener('click', () => {
      renderMetronomeState(controller.setMetronome(!controller.metronomeEnabled));
    });
    const requestExport = (range) => {
      exportOptions = {
        ...exportOptions,
        bits: Number(container.querySelector('[data-control="wav-bits"]')?.value ?? exportOptions.bits),
        bitrateKbps: Number(container.querySelector('[data-control="mp3-bitrate"]')?.value ?? exportOptions.bitrateKbps),
        qualityIndex: Number(container.querySelector('[data-control="ogg-quality"]')?.value ?? exportOptions.qualityIndex),
        tailSeconds: Number(container.querySelector('[data-control="tail"]')?.value ?? exportOptions.tailSeconds)
      };
      controller.exportMaster(range, exportOptions);
    };
    container.querySelector('[data-action="export"]')?.addEventListener('click', () => requestExport('full'));
    container.querySelector('[data-action="export-loop"]')?.addEventListener('click', () => requestExport('loop'));
    container.querySelector('[data-action="cancel-export"]')?.addEventListener('click', () => controller.cancelExport());
    container.querySelector('[data-control="export-format"]')?.addEventListener('change', (event) => { exportOptions.format = event.target.value; render(); });
    container.querySelector('[data-control="wav-bits"]')?.addEventListener('change', (event) => { exportOptions.bits = Number(event.target.value); });
    container.querySelector('[data-control="mp3-bitrate"]')?.addEventListener('change', (event) => { exportOptions.bitrateKbps = Number(event.target.value); });
    container.querySelector('[data-control="ogg-quality"]')?.addEventListener('change', (event) => { exportOptions.qualityIndex = Number(event.target.value); });
    container.querySelector('[data-control="tail"]')?.addEventListener('change', (event) => { exportOptions.tailSeconds = Number(event.target.value); });
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
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect?.() || { left: 0 };
      zoomAt(
        controller.model.state.zoom * (event.deltaY < 0 ? 1.2 : 1 / 1.2),
        event.clientX - rect.left
      );
    }, { passive: false });
    for (const key of ['loop-enabled', 'loop-start', 'loop-end']) container.querySelector(`[data-control="${key}"]`)?.addEventListener('change', () => {
      controller.model.setLoop({ enabled: container.querySelector('[data-control="loop-enabled"]').checked, startPpq: Number(container.querySelector('[data-control="loop-start"]').value), endPpq: Number(container.querySelector('[data-control="loop-end"]').value) }); controller.changed();
    });
    container.querySelector('[data-timeline-scroll]')?.addEventListener('scroll', (event) => {
      const next = event.currentTarget.scrollLeft / controller.model.state.zoom;
      controller.model.state.scrollPpq = next;
      renderRail();
      if (!scrollRenderQueued && (next < visibleStart + viewportPpq * 0.25 || next + viewportPpq > visibleEnd - viewportPpq * 0.25)) {
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
    container.querySelectorAll('[data-seek]').forEach((element) => element.addEventListener('click', () => controller.seek(Number(element.dataset.seek))));
    container.querySelectorAll('.seq-track').forEach(bindTrack);
    container.querySelectorAll('.seq-clip').forEach(bindClip);
    bindRail();
    bindPan();
  }

  function renderTempoValue(tempo) {
    const input = container?.querySelector('[data-control="tempo"]');
    if (input && input.value !== String(tempo)) input.value = String(tempo);
  }

  function renderMetronomeState(enabled) {
    const toggle = container?.querySelector('[data-action="toggle-metronome"]');
    toggle?.classList.toggle('active', enabled === true);
    toggle?.setAttribute('aria-checked', enabled === true ? 'true' : 'false');
  }

  function renderCountInState(event) {
    const element = container?.querySelector('.seq-record-status');
    if (!element) return;
    const status = transportStatus(event?.active === true);
    for (const tone of ['active', 'blocked', 'ready']) element.classList.toggle(tone, status.tone === tone);
    element.textContent = status.text;
  }

  function renderTransportState() {
    const play = container?.querySelector('[data-action="play"]');
    play?.classList.toggle('active', controller.playing);
    play?.setAttribute('aria-pressed', controller.playing ? 'true' : 'false');
    const stop = container?.querySelector('[data-action="stop"]');
    if (stop) stop.disabled = !(controller.playing || controller.recording);
  }

  function renderRecordingState() {
    const record = container?.querySelector('[data-action="start-record"]');
    const blockReason = controller.recordBlockReason();
    record?.classList.toggle('active', controller.recording);
    record?.classList.toggle('blocked', !controller.recording && Boolean(blockReason));
    if (record) {
      record.disabled = controller.recording;
      record.title = blockReason || 'Start recording';
    }
    renderTransportState();
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
    element.querySelector('[data-track-action="arm"]')?.addEventListener('click', (event) => {
      event.stopPropagation();
      controller.setTrackArmed(trackId, !track.armed, { additive: event.ctrlKey || event.metaKey || event.shiftKey });
    });
    element.querySelector('[data-track-action="monitor"]')?.addEventListener('click', (event) => {
      event.stopPropagation(); controller.setTrackMonitored(trackId, !track.monitored);
    });
    element.querySelector('[data-track-action="mute"]')?.addEventListener('click', () => controller.setTrack(trackId, { muted: !track.muted }));
    element.querySelector('[data-track-action="delete"]')?.addEventListener('click', () => controller.removeTrack(trackId));
    element.querySelector('[data-track-control="name"]')?.addEventListener('change', (event) => controller.setTrack(trackId, { name: event.target.value }));
    const volume = element.querySelector('[data-track-control="volume"]');
    volume?.addEventListener('input', (event) => {
      const gain = dbToGain(Number(event.target.value));
      const value = element.querySelector('[data-track-level-value]');
      if (value) value.textContent = formatDb(gain);
      controller.setTrackControl(trackId, { volume: gain }, { render: false });
    });
    volume?.addEventListener('change', (event) => controller.setTrackControl(
      trackId, { volume: dbToGain(Number(event.target.value)) }, { render: true }
    ));
    const lane = element.querySelector('.seq-track-lane');
    element.addEventListener('click', (event) => {
      if (event.target.closest?.('.seq-clip,input,select,button,textarea,[contenteditable="true"]')) return;
      controller.focusTrack(trackId);
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
      controller.selectClip(null);
    });
    lane?.addEventListener('contextmenu', (event) => {
      if (event.target.closest?.('.seq-clip')) return;
      event.preventDefault(); event.stopPropagation();
      openLaneMenu(event, track, lane);
    });
    lane?.addEventListener('dblclick', async (event) => {
      if (event.target.closest('.seq-clip')) return;
      const ppq = Math.max(0, (event.offsetX || 0) / controller.model.state.zoom);
      if (track.type === 'midi') { controller.model.addMidiClip(trackId, ppq, 4); controller.changed(); }
      else await controller.importAudio(trackId, ppq);
    });
  }

  function bindClip(element) {
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
      openClipMenu(event, element.dataset.clipId);
    });
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
      element.style.transform = trackDelta ? `translateY(${trackDelta * TRACK_HEIGHT}px)` : '';
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
   */
  function startMarquee(event) {
    const canvas = container?.querySelector('[data-seq-canvas]');
    const rect = canvas?.getBoundingClientRect?.();
    if (!rect) return;
    marquee = {
      canvas, rect, x0: event.clientX, y0: event.clientY, element: null, active: false,
      additive: event.ctrlKey || event.metaKey || event.shiftKey,
      baseIds: controller.model.selectedClipIds(), ids: []
    };
    document.addEventListener('pointermove', marqueeMove);
    document.addEventListener('pointerup', marqueeUp, { once: true });
    document.addEventListener('pointercancel', marqueeCancel, { once: true });
  }

  function marqueeMove(event) {
    if (!marquee) return;
    if (!marquee.active) {
      if (Math.abs(event.clientX - marquee.x0) < 3 && Math.abs(event.clientY - marquee.y0) < 3) return;
      marquee.active = true;
      marquee.element = document.createElement('div');
      marquee.element.setAttribute('class', 'seq-marquee');
      marquee.canvas.appendChild(marquee.element);
    }
    const zoom = controller.model.state.zoom;
    const left = Math.min(marquee.x0, event.clientX) - marquee.rect.left;
    const top = Math.min(marquee.y0, event.clientY) - marquee.rect.top;
    const width = Math.abs(event.clientX - marquee.x0);
    const height = Math.abs(event.clientY - marquee.y0);
    marquee.element.style.left = `${left}px`;
    marquee.element.style.top = `${top}px`;
    marquee.element.style.width = `${width}px`;
    marquee.element.style.height = `${height}px`;
    const covered = clipsInSpan(controller.model.state.tracks, {
      startPpq: (left - TRACK_HEADER) / zoom,
      endPpq: (left + width - TRACK_HEADER) / zoom,
      fromTrack: Math.floor((top - RULER_HEIGHT) / TRACK_HEIGHT),
      toTrack: Math.floor((top + height - RULER_HEIGHT) / TRACK_HEIGHT)
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
        { label: `Quantize to ${snap}`, disabled: !midi, action: () => controller.quantizeClips(ids, { grid: snap, strength: 100 }) },
        { separator: true },
        { label: many ? `Delete ${ids.length} clips` : 'Delete', hint: 'Del', danger: true, action: () => controller.deleteSelectedClips() }
      ]
    });
  }

  /** The menu on empty lane space: what a double-click does, plus paste. */
  function openLaneMenu(event, track, lane) {
    const ppq = ppqAtPointer(event, lane);
    openContextMenu({
      x: event.clientX, y: event.clientY,
      items: [
        { label: track.name },
        { separator: true },
        track.type === 'midi'
          ? { label: 'New MIDI clip here', hint: 'Double-click', action: () => { controller.model.addMidiClip(track.id, ppq, 4); controller.changed(); } }
          : { label: 'Import audio here…', hint: 'Double-click', action: () => { controller.importAudio(track.id, ppq); } },
        { label: 'Paste here', hint: 'Ctrl+V', disabled: !controller.hasClipboard(), action: () => controller.pasteClips(ppq) },
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
    if (!container) return;
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
    const step = snapStep(controller.model.state.snap);
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
      hub.events.on('sequencer:transport', renderTransportState),
      hub.events.on('sequencer:tempo', renderTempoValue),
      hub.events.on('sequencer:metronome', renderMetronomeState),
      hub.events.on('sequencer:metronome-tick', pulseMetronome),
      hub.events.on('engine:deviceState', render),
      hub.events.on('midi:ports', render),
      hub.events.on('midi:preference', render),
      hub.events.on('network:change', render),
      hub.events.on('sequencer:playhead', movePlayhead),
      hub.events.on('sequencer:export', (status) => { exportStatus = status; render(); }),
      hub.events.on('sequencer:export-capabilities', render)
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
    container = null; drag = null; marquee = null; suppressLaneClick = false;
  }

  return {
    id: 'sequencer', name: 'Sequencer',
    navEntry: { label: 'Sequencer', icon: 'sequencer', group: 'system', fixed: true },
    mount, unmount
  };
}
