import { escapeHtml } from './core/html.js';
import { historyIntent, isTextEditingTarget } from './ui/historyKeys.js';
import { notesInBox, selectNoteIds } from './core/clipEditorSelection.js';
import { MIN_NOTE_PPQ, SNAP_STEPS, clampNoteGroupDelta } from './core/sequencerModel.js';

/** Mirrors AUDITION_MAX_MS in clipEditorWindows.js, which refuses anything
 *  longer on the way in. Asking for what will be refused is a silent click. */
const AUDITION_MAX_MS = 4000;

/**
 * The piano roll's zoom, and why it is state rather than two constants.
 *
 * `PPQ_WIDTH` was 120 and `NOTE_HEIGHT` 18, both frozen: a four-bar clip was
 * 1920 px wide and the keyboard 2304 px tall, so the whole clip was never on
 * screen and there was nothing to do about it. They are now a view the window
 * owns, fitted to the clip the first time it is drawn.
 *
 * The bounds are readability, measured: below 8 px per quarter a 1/16 note is
 * half a pixel, and below 6 px a row cannot hold a note at all.
 */
const ZOOM = Object.freeze({ minWidth: 8, maxWidth: 480, minHeight: 6, maxHeight: 40 });
const KEY_WIDTH = 80;
let view = { ppqWidth: 120, noteHeight: 18, fitted: false };
const clipId = new URLSearchParams(globalThis.location.search).get('clipId') || '';
const root = document.getElementById('clip-editor-root');
let current = null;
let transport = { ppqPosition: 0, playing: false, recording: false, bpm: 120 };
let selectedNoteIds = new Set();
let drag = null;
let lasso = null;
let reloadQueued = false;
let reloadFrame = 0;
let pianoScroll = null;
/**
 * A scroll position the NEXT render must adopt instead of the one on screen.
 *
 * `'notes'` means "centre on the notes"; an object is an exact position.
 * Without this, `render()`'s own capture of the live `scrollLeft/scrollTop`
 * overwrites whatever Fit or a zoom just computed -- in the OLD scale -- and
 * both gestures then appear to do nothing at all. Found by driving the real
 * editor in a browser, not by a test.
 */
let scrollIntent = null;
/** noteId -> its DOM element, rebuilt by bind(). The drag preview writes to
 *  these sixty times a second and must not re-query the document for each. */
let noteElements = new Map();
let requestEpoch = 0;
let editQueue = Promise.resolve();
let disposed = false;

const snap = (value) => {
  const step = SNAP_STEPS[current?.snap] || 0.25;
  return Math.max(0, Math.round(value / step) * step);
};
const snapDelta = (value) => {
  const step = SNAP_STEPS[current?.snap] || 0.25;
  return Math.round(value / step) * step;
};

function applyDynamicStyles() {
  const pixels = { ceLeft: 'left', ceTop: 'top', ceWidth: 'width', ceHeight: 'height' };
  root.querySelectorAll('[data-ce-left],[data-ce-top],[data-ce-width],[data-ce-height]').forEach((element) => {
    for (const [key, property] of Object.entries(pixels)) {
      if (element.dataset[key] !== undefined) element.style[property] = `${Number(element.dataset[key]) || 0}px`;
    }
  });
  root.querySelectorAll('[data-ce-left-pct]').forEach((element) => { element.style.left = `${Number(element.dataset.ceLeftPct) || 0}%`; });
  root.querySelectorAll('[data-ce-height-pct]').forEach((element) => { element.style.height = `${Number(element.dataset.ceHeightPct) || 0}%`; });
  root.querySelectorAll('[data-ce-beat]').forEach((element) => { element.style.setProperty('--ce-beat', `${Number(element.dataset.ceBeat) || 0}px`); });
  // The row height and the keyboard gutter were spelled in the stylesheet as
  // 18px and 80px while JavaScript held its own copies. Now the zoom moves
  // them, so there is one source and the sheet reads it.
  root.querySelectorAll('[data-ce-row]').forEach((element) => { element.style.setProperty('--ce-row', `${Number(element.dataset.ceRow) || 0}px`); });
  root.querySelectorAll('[data-ce-keys]').forEach((element) => { element.style.setProperty('--ce-keys', `${Number(element.dataset.ceKeys) || 0}px`); });
  // Velocity as a 0..1 ratio: the note's colour is computed from it in CSS,
  // which is the one place that can do it without an inline style.
  root.querySelectorAll('[data-ce-vel]').forEach((element) => { element.style.setProperty('--ce-vel', String(Number(element.dataset.ceVel) || 0)); });
}

function waveform(peaks) {
  const values = Array.isArray(peaks) && peaks.length ? peaks : [0.15, 0.35, 0.6, 0.3, 0.75, 0.45, 0.2, 0.55];
  return values.map((peak, index) => `<i data-ce-left-pct="${index * 100 / values.length}" data-ce-height-pct="${Math.max(4, Number(peak) * 84)}"></i>`).join('');
}

/**
 * The keyboard down the left edge.
 *
 * These were inert `<div>`s: the piano roll could be edited but never played,
 * which is what makes it a spreadsheet with a keyboard drawn next to it. They
 * are buttons now, and pressing one sounds that pitch through the clip's own
 * track.
 */
function pianoKeys() {
  const names = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  return Array.from({ length: 128 }, (_, index) => 127 - index).map((pitch) => {
    const name = names[pitch % 12];
    const label = `${name}${Math.floor(pitch / 12) - 1}`;
    return `<button type="button" class="clip-key ${name.includes('♯') ? 'black' : ''}" data-key-pitch="${pitch}" data-ce-top="${(127 - pitch) * view.noteHeight}" data-ce-height="${view.noteHeight}" title="Play ${label}" aria-label="Play ${label}">${label}</button>`;
  }).join('');
}

/** The clip's visible window, in the source domain the notes are stored in. */
function clipWindow() {
  const lowerPpq = Number(current?.clip?.sourceOffsetPpq) || 0;
  return { lowerPpq, upperPpq: lowerPpq + (Number(current?.clip?.lengthPpq) || 0) };
}

/**
 * Where a note sits in the grid, clipped to the visible window.
 *
 * One function for the markup and for the drag preview. Two copies of this
 * arithmetic is how a note ends up drawn in one place while it renders in
 * another -- which is indistinguishable from the jump this whole pass exists
 * to remove.
 */
function noteBox(note) {
  const { lowerPpq, upperPpq } = clipWindow();
  const start = Math.max(lowerPpq, Number(note.startPpq) || 0);
  const end = Math.min(upperPpq, (Number(note.startPpq) || 0) + (Number(note.durationPpq) || 0));
  return {
    left: (start - lowerPpq) * view.ppqWidth,
    top: (127 - Math.round(Number(note.pitch) || 0)) * view.noteHeight + 1,
    width: Math.max(4, (end - start) * view.ppqWidth),
    height: view.noteHeight - 2
  };
}

function noteMarkup(clip) {
  const lower = clip.sourceOffsetPpq || 0;
  const upper = lower + clip.lengthPpq;
  return clip.notes.filter((note) => note.startPpq + note.durationPpq > lower && note.startPpq < upper).map((note) => {
    const box = noteBox(note);
    return `<button class="clip-note ${selectedNoteIds.has(note.id) ? 'selected' : ''}" data-note-id="${escapeHtml(note.id)}" data-ce-left="${box.left}" data-ce-top="${box.top}" data-ce-width="${box.width}" data-ce-height="${box.height}" data-ce-vel="${(note.velocity - 1) / 126}" title="Pitch ${note.pitch}, velocity ${note.velocity}, channel ${note.channel}"><span data-note-resize="start" aria-hidden="true"></span><span data-note-resize="end" aria-hidden="true"></span></button>`;
  }).join('');
}

function playheadMarkup() {
  return '<div class="clip-editor-playhead" data-clip-playhead aria-hidden="true"></div>';
}

/** The velocity the Selection slider shows: the selection's, or a default. */
function selectionVelocity() {
  const selected = (current?.clip?.notes || []).filter((note) => selectedNoteIds.has(note.id));
  if (!selected.length) return 100;
  return Math.round(selected.reduce((sum, note) => sum + note.velocity, 0) / selected.length);
}

function midiMarkup(state) {
  const { clip } = state;
  const gridWidth = Math.max(300, clip.lengthPpq * view.ppqWidth);
  const gridHeight = view.noteHeight * 128;
  const selection = selectedNoteIds.size;
  const velocity = selectionVelocity();
  return `<section class="clip-editor-panel clip-tools">
      <div class="clip-tool-group">
        <h2>Grid</h2>
        <label>Snap <select data-tool="snap">${Object.keys(SNAP_STEPS).map((value) => `<option ${value === state.snap ? 'selected' : ''}>${escapeHtml(value)}</option>`).join('')}</select></label>
        <label>Zoom <input data-tool="zoom-h" type="range" min="${ZOOM.minWidth}" max="${ZOOM.maxWidth}" value="${view.ppqWidth}" aria-label="Horizontal zoom"></label>
        <label>Rows <input data-tool="zoom-v" type="range" min="${ZOOM.minHeight}" max="${ZOOM.maxHeight}" value="${view.noteHeight}" aria-label="Row height"></label>
        <button class="btn" data-action="fit" title="Frame the whole clip (Ctrl+wheel zooms under the cursor)">Fit clip</button>
      </div>
      <div class="clip-tool-group">
        <h2>${selection ? `${selection} note${selection > 1 ? 's' : ''}` : 'Selection'}</h2>
        <label>Velocity <input data-tool="velocity" type="range" min="1" max="127" value="${velocity}" ${selection ? '' : 'disabled'} aria-label="Velocity of the selected notes"><output data-velocity-output>${velocity}</output></label>
        <button class="btn" data-action="duplicate-notes" ${selection ? '' : 'disabled'} title="Ctrl+D">Duplicate</button>
        <button class="btn" data-action="delete-notes" ${selection ? '' : 'disabled'} title="Del">Delete</button>
      </div>
      <div class="clip-tool-group">
        <h2>Quantize</h2>
        <label>Grid <select data-quantize="grid"><option>1 bar</option><option>1/2</option><option>1/4</option><option>1/8</option><option selected>1/16</option><option>1/32</option><option>1/8 triplet</option><option>1/16 triplet</option></select></label>
        <label>Strength <input data-quantize="strength" type="range" min="0" max="100" step="1" value="100"><output data-strength-output>100%</output></label>
        <label>Scope <select data-quantize="scope"><option value="selected" selected>Selected notes</option><option value="entire">Entire clip</option></select></label>
        <label>Timing <select data-quantize="timing"><option value="starts" selected>Note starts only</option><option value="starts+ends">Note starts + ends</option></select></label>
        <button class="btn primary" data-action="apply-quantize">Apply</button>
      </div>
    </section>
    <section class="clip-piano-shell" aria-label="Piano Roll">
      <div class="clip-piano-scroll" data-piano-scroll>
        <div class="clip-piano-canvas" data-ce-width="${KEY_WIDTH + gridWidth}" data-ce-height="${gridHeight}" data-ce-row="${view.noteHeight}" data-ce-keys="${KEY_WIDTH}">
          <div class="clip-piano-keys" data-ce-width="${KEY_WIDTH}" data-ce-height="${gridHeight}">${pianoKeys()}</div>
          <div class="clip-piano-grid" data-piano-grid data-ce-left="${KEY_WIDTH}" data-ce-width="${gridWidth}" data-ce-height="${gridHeight}" data-ce-beat="${view.ppqWidth}">${playheadMarkup()}${noteMarkup(clip)}</div>
        </div>
      </div>
    </section>`;
}

function transportMarkup() {
  return `<div class="clip-editor-transport" role="group" aria-label="Sequencer transport">
    <button class="btn clip-transport-return" data-transport-action="return-start" title="Return to Start" aria-label="Return to Start">|&lt;</button>
    <button class="btn clip-transport-play" data-transport-action="play" aria-pressed="${transport.playing}">Play</button>
    <button class="btn clip-transport-stop" data-transport-action="stop">Stop</button>
    <output class="clip-transport-position" data-transport-position>${Number(transport.ppqPosition).toFixed(2)} PPQ</output>
  </div>`;
}

function setStatus(message = '') {
  const status = root.querySelector('[data-editor-status]');
  if (status) status.textContent = message;
}

function applyTransportState(next = {}) {
  if (!next || typeof next !== 'object') return;
  transport = {
    ppqPosition: Math.max(0, Number(next.ppqPosition ?? transport.ppqPosition) || 0),
    playing: typeof next.playing === 'boolean' ? next.playing : transport.playing,
    recording: typeof next.recording === 'boolean' ? next.recording : transport.recording,
    bpm: Math.max(20, Math.min(300, Number(next.bpm ?? transport.bpm) || 120))
  };
  const play = root.querySelector('[data-transport-action="play"]');
  if (play) {
    play.classList.toggle('active', transport.playing);
    play.setAttribute('aria-pressed', String(transport.playing));
  }
  const stop = root.querySelector('[data-transport-action="stop"]');
  if (stop) stop.disabled = !transport.playing && !transport.recording;
  const position = root.querySelector('[data-transport-position]');
  if (position) position.textContent = `${transport.ppqPosition.toFixed(2)} PPQ`;
  const playhead = root.querySelector('[data-clip-playhead]');
  if (playhead && current) {
    const localPpq = transport.ppqPosition - current.clip.startPpq;
    const visible = localPpq >= 0 && localPpq <= current.clip.lengthPpq;
    playhead.hidden = !visible;
    if (visible) playhead.style.left = `${localPpq * view.ppqWidth}px`;
  }
}

function audioMarkup(state) {
  const { clip } = state;
  return `<section class="clip-editor-panel clip-audio-controls">
      <h2>Audio clip</h2>
      ${clip.mediaAvailable === false ? `<p class="clip-editor-error" role="alert">${escapeHtml(clip.mediaError || 'Audio media is unavailable')}</p>` : ''}
      <label>Trim start <input data-audio="trimStartSeconds" type="number" min="0" max="${clip.trimEndSeconds}" step="0.01" value="${Number(clip.trimStartSeconds).toFixed(3)}"> s</label>
      <label>Trim end <input data-audio="trimEndSeconds" type="number" min="0" max="${clip.durationSeconds}" step="0.01" value="${Number(clip.trimEndSeconds).toFixed(3)}"> s</label>
      <label>Gain <input data-audio="gain" type="range" min="0" max="2" step="0.01" value="${clip.gain}"></label>
      <span class="clip-audio-path">${escapeHtml(clip.filePath)}</span>
    </section>
    <section class="clip-audio-waveform" aria-label="Audio waveform preview">${waveform(clip.peaks)}</section>`;
}

const clampZoom = (next = {}) => ({
  ppqWidth: Math.max(ZOOM.minWidth, Math.min(ZOOM.maxWidth, Number(next.ppqWidth) || view.ppqWidth)),
  noteHeight: Math.max(ZOOM.minHeight, Math.min(ZOOM.maxHeight, Math.round(Number(next.noteHeight) || view.noteHeight)))
});

/**
 * The zoom that shows the whole clip, and the pitches it actually uses.
 *
 * Vertically it frames the notes rather than the 128-key keyboard: a clip
 * spanning an octave has no business being drawn across ten of them. `pad`
 * keeps a few rows of air, so a note is never flush against the edge and the
 * next one you add above it has somewhere to go.
 */
function fitZoom(width, height) {
  const clip = current?.clip;
  if (!clip || !(width > 0) || !(height > 0)) return null;
  const pitches = clip.notes.map((note) => note.pitch);
  const span = pitches.length ? Math.max(...pitches) - Math.min(...pitches) + 1 : 24;
  return clampZoom({
    ppqWidth: (width - KEY_WIDTH) / Math.max(0.25, clip.lengthPpq),
    noteHeight: height / (span + 6)
  });
}

/** Centre the view on the notes: their pitch range, and bar one. */
function scrollToNotes(scroll) {
  const pitches = current?.clip?.notes?.map((note) => note.pitch) || [];
  const middle = pitches.length
    ? (Math.max(...pitches) + Math.min(...pitches)) / 2
    : 60;
  scroll.scrollLeft = 0;
  scroll.scrollTop = Math.max(0, (127 - middle) * view.noteHeight - (scroll.clientHeight || 0) / 2);
}

function render() {
  if (!current) return;
  const previousScroll = root.querySelector('[data-piano-scroll]');
  if (!scrollIntent && previousScroll) pianoScroll = { left: previousScroll.scrollLeft, top: previousScroll.scrollTop };
  const type = current.track.type;
  root.innerHTML = `<header class="clip-editor-header"><div class="clip-editor-title"><span class="pill accent-sequencer">${type === 'midi' ? 'MIDI Clip' : 'Audio Clip'}</span><h1>${escapeHtml(current.clip.name)}</h1><p>${escapeHtml(current.track.name)}</p></div>${transportMarkup()}<span class="clip-editor-status" data-editor-status role="status"></span></header>
    ${type === 'midi' ? midiMarkup(current) : audioMarkup(current)}`;
  document.title = `${current.clip.name} — MiniHub Clip Editor`;
  applyDynamicStyles();
  bind();
  applyTransportState(transport);
  if (type !== 'midi') return;
  const scroll = root.querySelector('[data-piano-scroll]');
  if (!scroll) return;
  // The clip is framed the first time it is drawn, and only then: fitting on
  // every render would undo a zoom the moment any edit re-rendered the page.
  // The measurement needs the element in the document, hence the second pass.
  if (!view.fitted) {
    view.fitted = true;
    const fitted = fitZoom(scroll.clientWidth, scroll.clientHeight);
    if (fitted && (fitted.ppqWidth !== view.ppqWidth || fitted.noteHeight !== view.noteHeight)) {
      view = { ...fitted, fitted: true };
      scrollIntent = 'notes';
      render();
      return;
    }
  }
  const intent = scrollIntent;
  scrollIntent = null;
  if (intent === 'notes') scrollToNotes(scroll);
  else if (intent) {
    scroll.scrollLeft = intent.left;
    scroll.scrollTop = intent.top;
    pianoScroll = { left: intent.left, top: intent.top };
  } else if (pianoScroll) {
    scroll.scrollLeft = pianoScroll.left;
    scroll.scrollTop = pianoScroll.top;
  } else {
    scrollToNotes(scroll);
  }
  scroll.addEventListener('scroll', () => { pianoScroll = { left: scroll.scrollLeft, top: scroll.scrollTop }; });
}

async function applyMutation(operation, payload) {
  if (!current || disposed) return false;
  const epoch = ++requestEpoch;
  let result;
  try {
    result = await globalThis.clipEditorAPI.update(clipId, current.projectId, operation, payload);
  } catch (error) {
    if (!disposed) {
      console.error(`[clip-editor] ${operation} IPC failed`, error);
      setStatus('Clip Editor connection was interrupted.');
    }
    return false;
  }
  if (disposed || epoch !== requestEpoch) return false;
  if (!result?.ok) {
    setStatus(result?.reason === 'clip-not-found' ? 'Clip was deleted.' : 'Edit was not applied.');
    if (['clip-not-found', 'stale-project', 'project-transition'].includes(result?.reason)) globalThis.close();
    return false;
  }
  if (result.state) current = result.state;
  selectedNoteIds = new Set([...selectedNoteIds].filter((id) => current.clip.notes?.some((note) => note.id === id)));
  render();
  return true;
}

function mutate(operation, payload) {
  const run = () => applyMutation(operation, payload);
  const pending = editQueue.then(run, run);
  editQueue = pending.then(() => undefined, () => undefined);
  return pending;
}

/** How long an auditioned note should sound, from its own length. */
function noteDurationMs(note) {
  const beats = Math.max(0, Number(note?.durationPpq) || 0);
  const bpm = Math.max(20, Math.min(300, Number(transport.bpm) || 120));
  return Math.max(40, Math.min(AUDITION_MAX_MS, beats * 60000 / bpm));
}

/**
 * Ask the main renderer to sound a note.
 *
 * Deliberately outside `editQueue`: this is a performance, and queuing it
 * behind a pending edit would land the sound after the gesture that asked for
 * it. `sounded: false` is not a failure -- it means the track has no
 * Destination, or no cable behind it -- and saying so once is better than a
 * click that silently does nothing.
 */
async function requestAudition(payload) {
  if (!current || disposed || current.track.type !== 'midi') return false;
  if (typeof globalThis.clipEditorAPI.audition !== 'function') return false;
  let result;
  try {
    result = await globalThis.clipEditorAPI.audition(clipId, current.projectId, payload);
  } catch (error) {
    if (!disposed) console.error('[clip-editor] audition IPC failed', error);
    return false;
  }
  if (disposed) return false;
  if (result?.ok && result.sounded === false) {
    setStatus(`Nothing to play through: give “${current.track.name}” a Destination in the Sequencer.`);
    return false;
  }
  if (result?.ok) setStatus('');
  return result?.ok === true;
}

async function requestTransport(action) {
  if (!current || disposed) return false;
  let result;
  try {
    result = await globalThis.clipEditorAPI.transport(clipId, current.projectId, action);
  } catch (error) {
    if (!disposed) {
      console.error(`[clip-editor] ${action} transport IPC failed`, error);
      setStatus('Transport connection was interrupted.');
    }
    return false;
  }
  if (disposed) return false;
  if (!result?.ok) {
    setStatus('Transport action was not applied.');
    if (['clip-not-found', 'stale-project', 'project-transition'].includes(result?.reason)) globalThis.close();
    return false;
  }
  if (result.transport) applyTransportState(result.transport);
  setStatus('');
  return true;
}

function syncNoteSelectionUi() {
  root.querySelectorAll('[data-note-id]').forEach((element) => {
    element.classList.toggle('selected', selectedNoteIds.has(element.dataset.noteId));
  });
  const deleteButton = root.querySelector('[data-action="delete-notes"]');
  if (deleteButton) deleteButton.disabled = selectedNoteIds.size === 0;
}

function bind() {
  root.querySelectorAll('[data-transport-action]').forEach((button) => {
    button.addEventListener('click', () => requestTransport(button.dataset.transportAction));
  });
  if (current.track.type === 'audio') {
    root.querySelectorAll('[data-audio]').forEach((input) => input.addEventListener('change', () => {
      mutate('update-audio', { [input.dataset.audio]: Number(input.value) });
    }));
    return;
  }
  const strength = root.querySelector('[data-quantize="strength"]');
  strength?.addEventListener('input', () => { root.querySelector('[data-strength-output]').textContent = `${strength.value}%`; });
  root.querySelector('[data-action="apply-quantize"]')?.addEventListener('click', () => mutate('quantize', {
    grid: root.querySelector('[data-quantize="grid"]').value,
    strength: Number(strength.value),
    scope: root.querySelector('[data-quantize="scope"]').value,
    timing: root.querySelector('[data-quantize="timing"]').value,
    selectedNoteIds: [...selectedNoteIds]
  }));
  root.querySelector('[data-action="delete-notes"]')?.addEventListener('click', () => mutate('delete-notes', { noteIds: [...selectedNoteIds] }));
  root.querySelector('[data-action="duplicate-notes"]')?.addEventListener('click', duplicateSelection);
  root.querySelector('[data-tool="snap"]')?.addEventListener('change', (event) => mutate('set-snap', { snap: event.target.value }));
  const velocity = root.querySelector('[data-tool="velocity"]');
  velocity?.addEventListener('input', () => {
    const output = root.querySelector('[data-velocity-output]');
    if (output) output.textContent = String(velocity.value);
  });
  velocity?.addEventListener('change', () => mutate('set-notes', {
    noteIds: [...selectedNoteIds], velocity: Number(velocity.value)
  }));
  // On `change`, not `input`: a render replaces the very slider the pointer is
  // holding. Ctrl+wheel over the grid is the live gesture, and it holds no
  // element -- the same split the arrangement's zoom makes.
  root.querySelector('[data-tool="zoom-h"]')?.addEventListener('change', (event) => {
    applyZoom({ ppqWidth: Number(event.target.value) });
  });
  root.querySelector('[data-tool="zoom-v"]')?.addEventListener('change', (event) => {
    applyZoom({ noteHeight: Number(event.target.value) });
  });
  root.querySelector('[data-action="fit"]')?.addEventListener('click', () => {
    const scroll = root.querySelector('[data-piano-scroll]');
    const fitted = fitZoom(scroll?.clientWidth, scroll?.clientHeight);
    if (!fitted) return;
    view = { ...fitted, fitted: true };
    scrollIntent = 'notes';
    render();
  });
  bindGridSelection();
  root.querySelectorAll('[data-key-pitch]').forEach((key) => {
    key.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      requestAudition({ pitch: Number(key.dataset.keyPitch), velocity: 100, durationMs: 420 });
    });
  });
  noteElements = new Map();
  root.querySelectorAll('[data-note-id]').forEach((element) => {
    noteElements.set(element.dataset.noteId, element);
    let addedOnPointerDown = false;
    element.addEventListener('click', (event) => {
      event.stopPropagation();
      if (addedOnPointerDown) { addedOnPointerDown = false; syncNoteSelectionUi(); return; }
      const id = element.dataset.noteId;
      selectedNoteIds = selectNoteIds(selectedNoteIds, id, { additive: event.ctrlKey || event.metaKey });
      syncNoteSelectionUi();
    });
    element.addEventListener('pointerdown', (event) => {
      event.preventDefault(); event.stopPropagation();
      const note = current.clip.notes.find((item) => item.id === element.dataset.noteId);
      if (!note) return;
      if (!selectedNoteIds.has(note.id)) {
        selectedNoteIds = selectNoteIds(selectedNoteIds, note.id, { additive: event.ctrlKey || event.metaKey, toggle: false });
        addedOnPointerDown = true;
        syncNoteSelectionUi();
      }
      // A resize acts on the note you grabbed by its edge. A move carries the
      // whole selection -- which is what this editor did NOT do: dragging a
      // five-note chord moved one note and left four behind.
      const edge = event.target?.dataset?.noteResize || '';
      const ids = edge ? [note.id] : [...selectedNoteIds];
      const origins = ids
        .map((id) => current.clip.notes.find((item) => item.id === id))
        .filter(Boolean)
        .map((item) => ({ id: item.id, startPpq: item.startPpq, pitch: item.pitch, durationPpq: item.durationPpq }));
      if (!origins.length) return;
      drag = {
        edge, x: event.clientX, y: event.clientY,
        deltaPpq: 0, deltaPitch: 0, deltaDurationPpq: 0, moved: false, origins,
        anchor: { pitch: note.pitch, velocity: note.velocity }
      };
      // Pressing a note plays it, at its own velocity and for its own length.
      // Grabbing an edge does not: you are measuring, not listening.
      if (!edge) requestAudition({ pitch: note.pitch, velocity: note.velocity, durationMs: noteDurationMs(note) });
      for (const origin of origins) noteElements.get(origin.id)?.classList.add('dragging');
      // `?.` guards a missing method, not a throwing one: setPointerCapture
      // rejects a pointer id that is no longer active, and the throw used to
      // abort this handler AFTER `drag` was armed and BEFORE the move
      // listeners were attached -- a drag that can never end.
      try { element.setPointerCapture?.(event.pointerId); } catch (_) { /* capture is a nicety */ }
      document.addEventListener('pointermove', pointerMove);
      document.addEventListener('pointerup', pointerUp, { once: true });
      document.addEventListener('pointercancel', pointerCancel, { once: true });
    });
  });
  root.querySelector('[data-piano-grid]')?.addEventListener('dblclick', (event) => {
    if (event.target.closest('[data-note-id]')) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const localX = event.clientX - rect.left;
    const localY = event.clientY - rect.top;
    const sourceOffset = current.clip.sourceOffsetPpq || 0;
    mutate('add-note', {
      startPpq: sourceOffset + snap(localX / view.ppqWidth), durationPpq: SNAP_STEPS[current.snap] || 0.25,
      pitch: Math.max(0, Math.min(127, 127 - Math.floor(localY / view.noteHeight))), velocity: 100, channel: 1
    });
  });
}

/**
 * Change the zoom and keep the music where it is on screen.
 *
 * `anchor` is a point inside the scroller -- the cursor for a wheel, the
 * middle of the view for a slider. Without it, every zoom step throws you
 * somewhere else in the clip and you spend the gesture finding your place.
 */
function applyZoom(next, anchor = null) {
  const before = view;
  const zoomed = clampZoom({ ...view, ...next });
  if (zoomed.ppqWidth === before.ppqWidth && zoomed.noteHeight === before.noteHeight) return false;
  const scroll = root.querySelector('[data-piano-scroll]');
  const offsetX = anchor?.x ?? ((scroll?.clientWidth || 0) / 2);
  const offsetY = anchor?.y ?? ((scroll?.clientHeight || 0) / 2);
  // The keys occupy the first KEY_WIDTH of the canvas, sticky or not, so a
  // grid position is the canvas x minus that.
  const ppq = ((scroll?.scrollLeft || 0) + offsetX - KEY_WIDTH) / before.ppqWidth;
  const row = ((scroll?.scrollTop || 0) + offsetY) / before.noteHeight;
  view = { ...zoomed, fitted: true };
  scrollIntent = {
    left: Math.max(0, ppq * view.ppqWidth + KEY_WIDTH - offsetX),
    top: Math.max(0, row * view.noteHeight - offsetY)
  };
  render();
  return true;
}

/** Copy the selection, then select the copies so the gesture can repeat. */
async function duplicateSelection() {
  if (!selectedNoteIds.size) return;
  const before = new Set((current?.clip?.notes || []).map((note) => note.id));
  if (!await mutate('duplicate-notes', { noteIds: [...selectedNoteIds] })) return;
  const copies = (current?.clip?.notes || []).filter((note) => !before.has(note.id)).map((note) => note.id);
  if (!copies.length) return;
  selectedNoteIds = new Set(copies);
  render();
}

/**
 * The rubber band over the piano roll, and Ctrl+wheel zoom.
 *
 * Both live on the grid, which already carried a double-click that creates a
 * note; the band stays inert for three pixels so that gesture is untouched.
 * Shift on the wheel zooms the rows instead of the bars, because a piano roll
 * has two axes and one wheel.
 */
function bindGridSelection() {
  const grid = root.querySelector('[data-piano-grid]');
  const scroll = root.querySelector('[data-piano-scroll]');
  scroll?.addEventListener('wheel', (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    const rect = scroll.getBoundingClientRect?.() || { left: 0, top: 0 };
    const factor = event.deltaY < 0 ? 1.2 : 1 / 1.2;
    applyZoom(
      event.shiftKey ? { noteHeight: view.noteHeight * factor } : { ppqWidth: view.ppqWidth * factor },
      { x: event.clientX - rect.left, y: event.clientY - rect.top }
    );
  }, { passive: false });
  grid?.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target?.closest?.('[data-note-id]')) return;
    const rect = grid.getBoundingClientRect?.();
    if (!rect) return;
    lasso = {
      grid, rect, x0: event.clientX, y0: event.clientY, element: null, active: false,
      additive: event.ctrlKey || event.metaKey || event.shiftKey,
      baseIds: [...selectedNoteIds]
    };
    document.addEventListener('pointermove', lassoMove);
    document.addEventListener('pointerup', lassoUp, { once: true });
    document.addEventListener('pointercancel', lassoCancel, { once: true });
  });
}

function lassoMove(event) {
  if (!lasso) return;
  if (!lasso.active) {
    if (Math.abs(event.clientX - lasso.x0) < 3 && Math.abs(event.clientY - lasso.y0) < 3) return;
    lasso.active = true;
    lasso.element = document.createElement('div');
    lasso.element.setAttribute('class', 'clip-marquee');
    lasso.grid.appendChild(lasso.element);
  }
  const left = Math.min(lasso.x0, event.clientX) - lasso.rect.left;
  const top = Math.min(lasso.y0, event.clientY) - lasso.rect.top;
  const width = Math.abs(event.clientX - lasso.x0);
  const height = Math.abs(event.clientY - lasso.y0);
  lasso.element.style.left = `${left}px`;
  lasso.element.style.top = `${top}px`;
  lasso.element.style.width = `${width}px`;
  lasso.element.style.height = `${height}px`;
  const { lowerPpq } = clipWindow();
  const covered = notesInBox(current?.clip?.notes || [], {
    startPpq: lowerPpq + left / view.ppqWidth,
    endPpq: lowerPpq + (left + width) / view.ppqWidth,
    fromPitch: 127 - Math.floor((top + height) / view.noteHeight),
    toPitch: 127 - Math.floor(top / view.noteHeight)
  });
  // Highlighted live without a render: rebuilding the page every pixel would
  // destroy the grid the band is being drawn on.
  selectedNoteIds = new Set([...(lasso.additive ? lasso.baseIds : []), ...covered]);
  syncNoteSelectionUi();
}

function endLasso(commit) {
  document.removeEventListener('pointermove', lassoMove);
  document.removeEventListener('pointerup', lassoUp);
  document.removeEventListener('pointercancel', lassoCancel);
  const done = lasso; lasso = null;
  done?.element?.remove();
  if (!done?.active) return;
  if (!commit) selectedNoteIds = new Set(done.baseIds);
  // One render at the end, so the Selection panel catches up with the band.
  render();
}

function lassoUp() { endLasso(true); }
function lassoCancel() { endLasso(false); }

/**
 * Move the dragged notes in the DOM, now, under the cursor.
 *
 * Nothing used to move during a note drag: `pointerMove` computed the target
 * and every note stayed exactly where it was until the pointer came up, when
 * an IPC round trip and a full re-render made it reappear somewhere else.
 * That jump is the whole defect, and the arrangement's clips already held the
 * answer in their own `renderDragPreview`.
 *
 * The deltas come from the shared `clampNoteGroupDelta`, so what is drawn here
 * is what the model does when the gesture ends.
 */
function renderNoteDragPreview() {
  if (!drag) return;
  for (const origin of drag.origins) {
    const element = noteElements.get(origin.id);
    if (!element) continue;
    const box = noteBox({
      startPpq: origin.startPpq + drag.deltaPpq,
      pitch: origin.pitch + drag.deltaPitch,
      durationPpq: Math.max(MIN_NOTE_PPQ, origin.durationPpq + drag.deltaDurationPpq)
    });
    element.style.left = `${box.left}px`;
    element.style.top = `${box.top}px`;
    element.style.width = `${box.width}px`;
  }
}

/** Put the notes back on the coordinates the markup still carries: the data
 *  attributes hold the pre-drag position, so no snapshot is needed. */
function restoreNotePositions(origins = []) {
  for (const origin of origins) {
    const element = noteElements.get(origin.id);
    if (!element) continue;
    element.classList.remove('dragging');
    element.style.left = `${Number(element.dataset.ceLeft) || 0}px`;
    element.style.top = `${Number(element.dataset.ceTop) || 0}px`;
    element.style.width = `${Number(element.dataset.ceWidth) || 0}px`;
  }
}

function pointerMove(event) {
  if (!drag) return;
  const requested = snapDelta((event.clientX - drag.x) / view.ppqWidth);
  let next;
  if (drag.edge === 'start') {
    // The left edge moves the start and pays for it in duration. The delta is
    // capped so the SHORTEST note of the group keeps a legal length, which is
    // what keeps this preview and the model's own floor from disagreeing.
    const shortest = Math.min(...drag.origins.map((origin) => origin.durationPpq));
    const capped = Math.min(requested, shortest - MIN_NOTE_PPQ);
    const { deltaPpq } = clampNoteGroupDelta(drag.origins, clipWindow(), { deltaPpq: capped });
    next = { deltaPpq, deltaPitch: 0, deltaDurationPpq: -deltaPpq };
  } else if (drag.edge) {
    next = { deltaPpq: 0, deltaPitch: 0, deltaDurationPpq: requested };
  } else {
    const clamped = clampNoteGroupDelta(drag.origins, clipWindow(), {
      deltaPpq: requested,
      deltaPitch: -Math.round((event.clientY - drag.y) / view.noteHeight)
    });
    next = { ...clamped, deltaDurationPpq: 0 };
  }
  if (next.deltaPpq === drag.deltaPpq && next.deltaPitch === drag.deltaPitch
    && next.deltaDurationPpq === drag.deltaDurationPpq) return;
  const transposed = !drag.edge && next.deltaPitch !== drag.deltaPitch;
  Object.assign(drag, next);
  drag.moved = drag.deltaPpq !== 0 || drag.deltaPitch !== 0 || drag.deltaDurationPpq !== 0;
  renderNoteDragPreview();
  // Every row you cross sounds. Dragging a note by ear is the whole reason a
  // piano roll has a keyboard drawn next to it.
  if (transposed) {
    requestAudition({
      pitch: drag.anchor.pitch + drag.deltaPitch,
      velocity: drag.anchor.velocity,
      durationMs: 260
    });
  }
}

function finishNoteDrag(commit) {
  document.removeEventListener('pointermove', pointerMove);
  document.removeEventListener('pointerup', pointerUp);
  document.removeEventListener('pointercancel', pointerCancel);
  const completed = drag; drag = null;
  if (!completed) return;
  if (!commit || !completed.moved) { restoreNotePositions(completed.origins); return; }
  // The preview stays where the hand left it: a successful edit re-renders
  // over it. A refused one has to be taken back, or the note keeps a position
  // the model never accepted.
  mutate('move-notes', {
    noteIds: completed.origins.map((origin) => origin.id),
    deltaPpq: completed.deltaPpq,
    deltaPitch: completed.deltaPitch,
    deltaDurationPpq: completed.deltaDurationPpq
  }).then((applied) => { if (!applied) restoreNotePositions(completed.origins); });
}

function pointerUp() { finishNoteDrag(true); }
function pointerCancel() { finishNoteDrag(false); }

async function load() {
  if (disposed) return;
  const epoch = ++requestEpoch;
  let result;
  try { result = await globalThis.clipEditorAPI.get(clipId); }
  catch (error) {
    if (!disposed) {
      console.error('[clip-editor] clip load IPC failed', error);
      root.innerHTML = '<div class="clip-editor-loading">Clip Editor connection was interrupted.</div>';
    }
    return;
  }
  if (disposed || epoch !== requestEpoch) return;
  if (!result?.ok || !result.state) {
    root.innerHTML = '<div class="clip-editor-loading">This clip is no longer available.</div>';
    globalThis.setTimeout(() => globalThis.close(), 250);
    return;
  }
  current = result.state;
  if (result.state.transport) transport = result.state.transport;
  selectedNoteIds = new Set([...selectedNoteIds].filter((id) => current.clip.notes?.some((note) => note.id === id)));
  render();
}

function keyDown(event) {
  // Undo is answered FIRST, and with its own narrower guard.
  //
  // The line below turns away anything focused on a control, which is right for
  // this window's note editing and wrong for undo: the snap selector and the
  // velocity slider are a `<select>` and an `<input>`, so after touching either
  // one Ctrl+Z would be swallowed. The browser only owns Ctrl+Z where there is
  // text to undo. It is also answered before the `midi` check, because the edit
  // it undoes may have been made on another page entirely.
  const intent = historyIntent(event);
  if (intent && !isTextEditingTarget(event.target)) {
    event.preventDefault();
    Promise.resolve(window.clipEditorAPI?.history?.(intent)).catch(() => {});
    return;
  }
  if (event.target?.closest?.('input,select,textarea')) return;
  if (current?.track.type !== 'midi') return;
  if (event.key === 'Escape' && (lasso || drag)) {
    event.preventDefault();
    if (lasso) lassoCancel();
    if (drag) pointerCancel();
    return;
  }
  const command = event.ctrlKey || event.metaKey;
  const key = String(event.key).toLowerCase();
  if (command && key === 'a') {
    event.preventDefault();
    // Every note the grid actually draws. A trimmed clip keeps notes outside
    // its window; selecting what cannot be seen is how a chord loses two
    // members to an edit nobody aimed at them.
    const { lowerPpq, upperPpq } = clipWindow();
    selectedNoteIds = new Set(current.clip.notes
      .filter((note) => note.startPpq + note.durationPpq > lowerPpq && note.startPpq < upperPpq)
      .map((note) => note.id));
    render();
    return;
  }
  if (!selectedNoteIds.size) return;
  if (command && key === 'd') { event.preventDefault(); duplicateSelection(); return; }
  if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault();
    mutate('delete-notes', { noteIds: [...selectedNoteIds] });
    return;
  }
  const nudge = {
    ArrowLeft: { deltaPpq: -(SNAP_STEPS[current.snap] || 0.25) },
    ArrowRight: { deltaPpq: SNAP_STEPS[current.snap] || 0.25 },
    ArrowUp: { deltaPitch: 1 },
    ArrowDown: { deltaPitch: -1 }
  }[event.key];
  if (nudge) {
    event.preventDefault();
    mutate('move-notes', { noteIds: [...selectedNoteIds], ...nudge });
  }
}

document.addEventListener('keydown', keyDown);
globalThis.addEventListener('blur', pointerCancel);
globalThis.addEventListener('blur', lassoCancel);

const offChanged = globalThis.clipEditorAPI.onChanged(() => {
  if (reloadQueued) return;
  reloadQueued = true;
  reloadFrame = requestAnimationFrame(() => { reloadQueued = false; reloadFrame = 0; load(); });
});
const offTransport = globalThis.clipEditorAPI.onTransportState((state) => {
  if (!disposed) applyTransportState(state);
});

function cleanup() {
  if (disposed) return;
  disposed = true;
  requestEpoch += 1;
  if (reloadFrame) cancelAnimationFrame(reloadFrame);
  reloadFrame = 0; reloadQueued = false;
  finishNoteDrag(false);
  endLasso(false);
  offChanged?.();
  offTransport?.();
  document.removeEventListener('keydown', keyDown);
  globalThis.removeEventListener('blur', pointerCancel);
  globalThis.removeEventListener('blur', lassoCancel);
  globalThis.removeEventListener('beforeunload', cleanup);
}

globalThis.addEventListener('beforeunload', cleanup);

load();
