import { escapeHtml } from '../../core/html.js';
import { SEQUENCER_LIMITS, SNAP_STEPS } from '../../core/sequencerModel.js';
import { bindTempoInput } from '../../core/tempoControl.js';
import { MINILAB_NODE_ID } from '../../core/systemNodes.js';

const TRACK_HEADER = 360;
const TRACK_HEIGHT = 140;
const RULER_HEIGHT = 30;
const TIMELINE_BEATS = 256;

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

function clipMarkup(track, clip, zoom, selected) {
  const left = clip.startPpq * zoom;
  const width = Math.max(12, clip.lengthPpq * zoom);
  const sourceOffset = Number(clip.sourceOffsetPpq) || 0;
  const sourceEnd = sourceOffset + clip.lengthPpq;
  const content = track.type === 'midi'
    ? `<span class="seq-midi-preview">${clip.notes.filter((note) => note.startPpq + note.durationPpq > sourceOffset && note.startPpq < sourceEnd).map((note) => {
      const visibleStart = Math.max(sourceOffset, note.startPpq);
      const visibleEnd = Math.min(sourceEnd, note.startPpq + note.durationPpq);
      return `<i data-seq-left-pct="${(visibleStart - sourceOffset) / clip.lengthPpq * 100}" data-seq-width-pct="${Math.max(1, (visibleEnd - visibleStart) / clip.lengthPpq * 100)}" data-seq-bottom-pct="${Math.max(2, (note.pitch - 24) / 104 * 70)}"></i>`;
    }).join('')}</span>`
    : `<span class="seq-waveform">${waveform(clip.peaks)}</span>`;
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

function routeSummary(hub, track, sequencerId) {
  const inputCables = hub.network.connectionsTo(sequencerId, track.type === 'midi' ? 'midi-in' : 'audio-in');
  const outputCables = hub.network.connectionsFrom(sequencerId, track.type === 'midi' ? 'midi-out' : 'audio-out');
  const inputMatches = track.type === 'midi'
    ? inputCables.some((connection) => connection.from.nodeId === MINILAB_NODE_ID
        && connection.from.portId === 'midi-out') && track.inputId === hub.midi.selectedInputId
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

  return `<span class="seq-route-summary" aria-live="polite"><span class="seq-route-${input.state}">${input.state === 'ok' ? '✓' : (input.state === 'warning' ? '!' : '·')} ${input.text}</span><span class="seq-route-${output.state}">${output.state === 'ok' ? '✓' : (output.state === 'warning' ? '!' : '·')} ${output.text}</span></span>`;
}

function rulerMarkup(endPpq, zoom) {
  const bars = Math.ceil(endPpq / 4);
  const stride = Math.max(1, Math.ceil(bars / 512));
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
  let tempoBindingCleanup = null;
  let metronomePulseTimer = null;
  let exportOptions = { format: 'wav', bits: 24, bitrateKbps: 320, qualityIndex: -1, tailSeconds: 2 };
  let exportStatus = null;

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
    const viewportPpq = Math.max(16, (container.clientWidth - TRACK_HEADER) / zoom);
    const visibleStart = Math.max(0, state.scrollPpq - viewportPpq);
    const visibleEnd = state.scrollPpq + viewportPpq * 2;
    const atTrackLimit = state.tracks.length >= SEQUENCER_LIMITS.tracks;
    const recordBlockReason = controller.recordBlockReason();
    const recordStatus = controller.preCounting
      ? 'Pre-count — recording starts after this measure. Press Stop to cancel.'
      : controller.recording
        ? 'Recording now — press Stop to finish and keep the take.'
      : (recordBlockReason || 'Ready to record the armed and routed tracks.');
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
        <div class="seq-record-status ${controller.recording ? 'active' : (recordBlockReason ? 'blocked' : 'ready')}" role="status">${escapeHtml(recordStatus)}</div>
        <p class="seq-routing-help">Each track has its own <strong>Input</strong> and <strong>Destination</strong>. Choose VST 1, VST 2, or another destination on the track; MiniHub creates the matching Patch Bay cable automatically.</p>
        <div class="row mt-12 seq-tools"><label>Snap <select data-control="snap">${Object.keys(SNAP_STEPS).map((value) => `<option ${value === state.snap ? 'selected' : ''}>${value}</option>`).join('')}</select></label>
          <label>Zoom <input data-control="zoom" type="range" min="24" max="240" value="${zoom}"></label>
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
          <div class="seq-canvas" data-seq-width="${TRACK_HEADER + timelineWidth}" data-seq-height="${RULER_HEIGHT + Math.max(1, state.tracks.length) * TRACK_HEIGHT}">
            <div class="seq-corner">TRACKS</div><div class="seq-ruler" data-seq-left="${TRACK_HEADER}" data-seq-width="${timelineWidth}" data-seq-beat="${zoom}">${rulerMarkup(endPpq, zoom)}</div>
            <div class="seq-loop-range ${state.loop.enabled ? 'enabled' : ''}" data-seq-left="${TRACK_HEADER + state.loop.startPpq * zoom}" data-seq-width="${(state.loop.endPpq - state.loop.startPpq) * zoom}" data-seq-height="${RULER_HEIGHT + Math.max(1, state.tracks.length) * TRACK_HEIGHT}"></div>
            ${state.tracks.length ? state.tracks.map((track, index) => `<div class="seq-track ${state.focusedTrackId === track.id ? 'focused' : ''}" data-track-id="${track.id}" data-seq-top="${RULER_HEIGHT + index * TRACK_HEIGHT}" data-seq-height="${TRACK_HEIGHT}">
              <div class="seq-track-head" data-seq-width="${TRACK_HEADER}">
                <button class="seq-arm ${track.armed ? 'active' : ''}" data-track-action="arm" title="Arm">R</button>
                <button class="seq-monitor ${track.monitored ? 'active' : ''}" data-track-action="monitor" title="Input monitor">I</button>
                <input class="seq-track-name" data-track-control="name" value="${escapeHtml(track.name)}">
                <button class="seq-mute ${track.muted ? 'active' : ''}" data-track-action="mute" title="Mute">M</button>
                <button class="seq-track-delete" data-track-action="delete" title="Delete track">×</button>
                <label class="seq-track-route-control seq-track-input"><span>Input</span><select data-track-control="input" aria-label="${escapeHtml(track.name)} input">${options(trackSources(hub, track), track.inputId, inputPlaceholder(hub, track))}</select></label>
                <label class="seq-track-route-control seq-track-output"><span>Destination</span><select data-track-control="output" aria-label="${escapeHtml(track.name)} destination">${options(trackDestinations(hub, track), track.outputId, destinationPlaceholder(hub, track))}</select></label>
                <label class="seq-track-level"><span>Level <output data-track-level-value>${formatDb(track.volume)}</output></span><input data-track-control="volume" type="range" min="-60" max="6" step="0.1" value="${gainToDb(track.volume)}" aria-label="${escapeHtml(track.name)} level in dB"></label>
                ${routeSummary(hub, track, sequencerNode.id)}
              </div>
              <div class="seq-track-lane" data-seq-left="${TRACK_HEADER}" data-seq-width="${timelineWidth}" data-seq-beat="${zoom}">${track.clips.filter((clip) => clip.startPpq + clip.lengthPpq >= visibleStart && clip.startPpq <= visibleEnd).map((clip) => clipMarkup(track, clip, zoom, selectedClipIds.has(clip.id))).join('')}</div>
            </div>`).join('') : `<div class="seq-empty" data-seq-top="${RULER_HEIGHT}">Create a MIDI or audio track to begin.</div>`}
            <div class="seq-playhead" data-playhead data-seq-left="${TRACK_HEADER + controller.playheadPpq * zoom}" data-seq-height="${RULER_HEIGHT + Math.max(1, state.tracks.length) * TRACK_HEIGHT}"></div>
          </div>
        </div>
      </section>
    </div>`;
    applyDynamicStyles(container);
    bind();
    const scroller = container.querySelector('[data-timeline-scroll]');
    if (scroller) scroller.scrollLeft = state.scrollPpq * zoom;
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
    container.querySelector('[data-control="zoom"]')?.addEventListener('change', (event) => { controller.model.state.zoom = Number(event.target.value); controller.changed(); });
    for (const key of ['loop-enabled', 'loop-start', 'loop-end']) container.querySelector(`[data-control="${key}"]`)?.addEventListener('change', () => {
      controller.model.setLoop({ enabled: container.querySelector('[data-control="loop-enabled"]').checked, startPpq: Number(container.querySelector('[data-control="loop-start"]').value), endPpq: Number(container.querySelector('[data-control="loop-end"]').value) }); controller.changed();
    });
    container.querySelector('[data-timeline-scroll]')?.addEventListener('scroll', (event) => {
      const next = event.currentTarget.scrollLeft / controller.model.state.zoom;
      controller.model.state.scrollPpq = next;
      if (!scrollRenderQueued && (next < visibleStart + viewportPpq * 0.25 || next + viewportPpq > visibleEnd - viewportPpq * 0.25)) {
        scrollRenderQueued = true;
        requestAnimationFrame(render); // layout virtualization only; native transport remains the musical clock
      }
    });
    container.querySelectorAll('[data-seek]').forEach((element) => element.addEventListener('click', () => controller.seek(Number(element.dataset.seek))));
    container.querySelectorAll('.seq-track').forEach(bindTrack);
    container.querySelectorAll('.seq-clip').forEach(bindClip);
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
    const status = container?.querySelector('.seq-record-status');
    if (!status) return;
    const blockReason = controller.recordBlockReason();
    status.classList.toggle('active', controller.recording);
    status.classList.toggle('blocked', !controller.recording && Boolean(blockReason));
    status.classList.toggle('ready', !controller.recording && !blockReason);
    status.textContent = event?.active === true
      ? 'Pre-count — recording starts after this measure. Press Stop to cancel.'
      : controller.recording
        ? 'Recording now — press Stop to finish and keep the take.'
        : (blockReason || 'Ready to record the armed and routed tracks.');
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
    element.querySelector('[data-track-control="input"]')?.addEventListener('change', (event) => controller.setTrack(trackId, { inputId: event.target.value }));
    element.querySelector('[data-track-control="output"]')?.addEventListener('change', (event) => controller.setTrack(trackId, { outputId: event.target.value }));
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
    lane?.addEventListener('click', (event) => {
      if (event.target.closest?.('.seq-clip')) return;
      controller.selectClip(null);
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
      element.setPointerCapture?.(event.pointerId);
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
      element.style.left = `${found.clip.startPpq * controller.model.state.zoom}px`;
      element.style.width = `${Math.max(12, found.clip.lengthPpq * controller.model.state.zoom)}px`;
      const currentTrackIndex = controller.model.state.tracks.indexOf(found.track);
      const trackDelta = currentTrackIndex - origin.trackIndex;
      element.style.transform = trackDelta ? `translateY(${trackDelta * TRACK_HEIGHT}px)` : '';
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

  function keyDown(event) {
    if (!container) return;
    if (event.target?.closest?.('input,select,textarea,[contenteditable="true"]')) return;
    if (event.key === 'Escape' && drag) {
      event.preventDefault(); pointerCancel(); return;
    }
    const command = event.ctrlKey || event.metaKey;
    if (command && String(event.key).toLowerCase() === 'c') {
      if (controller.copySelectedClips()) event.preventDefault();
      return;
    }
    if (command && String(event.key).toLowerCase() === 'v') {
      if (controller.pasteClips().length) event.preventDefault();
      return;
    }
    if (command && String(event.key).toLowerCase() === 'd') {
      if (controller.duplicateSelectedClips().length) event.preventDefault();
      return;
    }
    if (!controller.model.state.selectedClipIds.length) return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      controller.deleteSelectedClips();
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
      hub.events.on('sequencer:playhead', (ppq) => { const el = container?.querySelector('[data-playhead]'); if (el) el.style.left = `${TRACK_HEADER + ppq * controller.model.state.zoom}px`; }),
      hub.events.on('sequencer:export', (status) => { exportStatus = status; render(); }),
      hub.events.on('sequencer:export-capabilities', render)
    );
    document.addEventListener('keydown', keyDown); render();
  }

  function unmount() {
    unsubs.forEach((off) => off()); unsubs = [];
    document.removeEventListener('keydown', keyDown);
    pointerCancel();
    tempoBindingCleanup?.(); tempoBindingCleanup = null;
    globalThis.clearTimeout(metronomePulseTimer); metronomePulseTimer = null;
    resizeObserver?.disconnect(); resizeObserver = null;
    globalThis.window?.removeEventListener?.('resize', resizeRender);
    resizeRenderQueued = false;
    container?.classList.remove('sequencer-workspace');
    container = null; drag = null;
  }

  return {
    id: 'sequencer', name: 'Sequencer',
    navEntry: { label: 'Sequencer', icon: 'sequencer', group: 'system', fixed: true },
    mount, unmount
  };
}
