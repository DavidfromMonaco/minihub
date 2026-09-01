import { escapeHtml } from './core/html.js';
import { selectNoteIds } from './core/clipEditorSelection.js';

const NOTE_HEIGHT = 18;
const PPQ_WIDTH = 120;
const SNAP_STEPS = Object.freeze({ '1 bar': 4, '1/2': 2, '1/4': 1, '1/8': 0.5, '1/16': 0.25, '1/32': 0.125 });
const clipId = new URLSearchParams(globalThis.location.search).get('clipId') || '';
const root = document.getElementById('clip-editor-root');
let current = null;
let transport = { ppqPosition: 0, playing: false, recording: false, bpm: 120 };
let selectedNoteIds = new Set();
let drag = null;
let reloadQueued = false;
let reloadFrame = 0;
let pianoScroll = null;
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
}

function waveform(peaks) {
  const values = Array.isArray(peaks) && peaks.length ? peaks : [0.15, 0.35, 0.6, 0.3, 0.75, 0.45, 0.2, 0.55];
  return values.map((peak, index) => `<i data-ce-left-pct="${index * 100 / values.length}" data-ce-height-pct="${Math.max(4, Number(peak) * 84)}"></i>`).join('');
}

function pianoKeys() {
  const names = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  return Array.from({ length: 128 }, (_, index) => 127 - index).map((pitch) => {
    const name = names[pitch % 12];
    return `<div class="clip-key ${name.includes('♯') ? 'black' : ''}" data-ce-top="${(127 - pitch) * NOTE_HEIGHT}" data-ce-height="${NOTE_HEIGHT}">${name}${Math.floor(pitch / 12) - 1}</div>`;
  }).join('');
}

function noteMarkup(clip) {
  const lower = clip.sourceOffsetPpq || 0;
  const upper = lower + clip.lengthPpq;
  return clip.notes.filter((note) => note.startPpq + note.durationPpq > lower && note.startPpq < upper).map((note) => {
    const start = Math.max(lower, note.startPpq);
    const end = Math.min(upper, note.startPpq + note.durationPpq);
    return `<button class="clip-note ${selectedNoteIds.has(note.id) ? 'selected' : ''}" data-note-id="${escapeHtml(note.id)}" data-ce-left="${(start - lower) * PPQ_WIDTH}" data-ce-top="${(127 - note.pitch) * NOTE_HEIGHT + 1}" data-ce-width="${Math.max(4, (end - start) * PPQ_WIDTH)}" data-ce-height="${NOTE_HEIGHT - 2}" title="Pitch ${note.pitch}, velocity ${note.velocity}, channel ${note.channel}"><span data-note-resize="end" aria-hidden="true"></span></button>`;
  }).join('');
}

function playheadMarkup() {
  return '<div class="clip-editor-playhead" data-clip-playhead aria-hidden="true"></div>';
}

function midiMarkup(state) {
  const { clip } = state;
  const gridWidth = Math.max(900, clip.lengthPpq * PPQ_WIDTH);
  const gridHeight = NOTE_HEIGHT * 128;
  return `<section class="clip-editor-panel clip-quantize">
      <h2>Post-recording quantization</h2>
      <label>Grid <select data-quantize="grid"><option>1/4</option><option>1/8</option><option selected>1/16</option><option>1/32</option><option>1/8 triplet</option><option>1/16 triplet</option></select></label>
      <label>Strength <input data-quantize="strength" type="range" min="0" max="100" step="1" value="100"><output data-strength-output>100%</output></label>
      <label>Scope <select data-quantize="scope"><option value="selected" selected>Selected notes</option><option value="entire">Entire clip</option></select></label>
      <label>Timing <select data-quantize="timing"><option value="starts" selected>Note starts only</option><option value="starts+ends">Note starts + ends</option></select></label>
      <button class="btn primary" data-action="apply-quantize">Apply</button>
      <button class="btn" data-action="delete-notes" ${selectedNoteIds.size ? '' : 'disabled'}>Delete selected</button>
    </section>
    <section class="clip-piano-shell" aria-label="Piano Roll">
      <div class="clip-piano-scroll" data-piano-scroll>
        <div class="clip-piano-canvas" data-ce-width="${80 + gridWidth}" data-ce-height="${gridHeight}">
          <div class="clip-piano-keys" data-ce-width="80" data-ce-height="${gridHeight}">${pianoKeys()}</div>
          <div class="clip-piano-grid" data-piano-grid data-ce-left="80" data-ce-width="${gridWidth}" data-ce-height="${gridHeight}" data-ce-beat="${PPQ_WIDTH}">${playheadMarkup()}${noteMarkup(clip)}</div>
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
    if (visible) playhead.style.left = `${localPpq * PPQ_WIDTH}px`;
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

function render() {
  if (!current) return;
  const previousScroll = root.querySelector('[data-piano-scroll]');
  if (previousScroll) pianoScroll = { left: previousScroll.scrollLeft, top: previousScroll.scrollTop };
  const type = current.track.type;
  root.innerHTML = `<header class="clip-editor-header"><div class="clip-editor-title"><span class="pill accent-sequencer">${type === 'midi' ? 'MIDI Clip' : 'Audio Clip'}</span><h1>${escapeHtml(current.clip.name)}</h1><p>${escapeHtml(current.track.name)}</p></div>${transportMarkup()}<span class="clip-editor-status" data-editor-status role="status"></span></header>
    ${type === 'midi' ? midiMarkup(current) : audioMarkup(current)}`;
  document.title = `${current.clip.name} — MiniHub Clip Editor`;
  applyDynamicStyles();
  bind();
  applyTransportState(transport);
  if (type === 'midi') {
    const pitches = current.clip.notes.map((note) => note.pitch);
    const focusPitch = pitches.length ? Math.round(pitches.reduce((sum, pitch) => sum + pitch, 0) / pitches.length) : 60;
    const scroll = root.querySelector('[data-piano-scroll]');
    if (scroll) {
      if (pianoScroll) {
        scroll.scrollLeft = pianoScroll.left;
        scroll.scrollTop = pianoScroll.top;
      } else {
        scroll.scrollTop = Math.max(0, (127 - focusPitch) * NOTE_HEIGHT - scroll.clientHeight / 2);
      }
      scroll.addEventListener('scroll', () => { pianoScroll = { left: scroll.scrollLeft, top: scroll.scrollTop }; });
    }
  }
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
  root.querySelectorAll('[data-note-id]').forEach((element) => {
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
      drag = { noteId: note.id, x: event.clientX, y: event.clientY, startPpq: note.startPpq, durationPpq: note.durationPpq, pitch: note.pitch, resize: !!event.target?.dataset?.noteResize };
      element.setPointerCapture?.(event.pointerId);
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
      startPpq: sourceOffset + snap(localX / PPQ_WIDTH), durationPpq: SNAP_STEPS[current.snap] || 0.25,
      pitch: Math.max(0, Math.min(127, 127 - Math.floor(localY / NOTE_HEIGHT))), velocity: 100, channel: 1
    });
  });
}

function pointerMove(event) {
  if (!drag) return;
  const deltaPpq = snapDelta((event.clientX - drag.x) / PPQ_WIDTH);
  if (drag.resize) drag.next = { durationPpq: Math.max(0.03125, drag.durationPpq + deltaPpq) };
  else drag.next = {
    startPpq: drag.startPpq + deltaPpq,
    pitch: Math.max(0, Math.min(127, drag.pitch - Math.round((event.clientY - drag.y) / NOTE_HEIGHT)))
  };
}

function finishNoteDrag(commit) {
  document.removeEventListener('pointermove', pointerMove);
  document.removeEventListener('pointerup', pointerUp);
  document.removeEventListener('pointercancel', pointerCancel);
  const completed = drag; drag = null;
  if (commit && completed?.next) mutate('update-note', { noteId: completed.noteId, changes: completed.next });
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
  if (current?.track.type !== 'midi' || !selectedNoteIds.size) return;
  if (event.target?.closest?.('input,select,textarea')) return;
  if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault(); mutate('delete-notes', { noteIds: [...selectedNoteIds] });
  }
}

document.addEventListener('keydown', keyDown);
globalThis.addEventListener('blur', pointerCancel);

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
  offChanged?.();
  offTransport?.();
  document.removeEventListener('keydown', keyDown);
  globalThis.removeEventListener('blur', pointerCancel);
  globalThis.removeEventListener('beforeunload', cleanup);
}

globalThis.addEventListener('beforeunload', cleanup);

load();
