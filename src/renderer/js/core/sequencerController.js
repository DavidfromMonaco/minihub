import { SequencerModel, defaultSequencerState } from './sequencerModel.js';
import { normalizeTempo } from './tempoControl.js';
import { AUDIO_INPUT_NODE_ID, MINILAB_NODE_ID, SEQUENCER_NODE_ID } from './systemNodes.js';

const STATE_KEY = 'sequencerState';
const LEGACY_DEVICE_INPUT_ID = 'device-input';
const EXPORT_STALL_TIMEOUT_MS = 60000;

const isCanonicalMidiIngress = (connection) => connection?.from?.nodeId === MINILAB_NODE_ID
  && connection?.from?.portId === 'midi-out';

function baseName(filePath) {
  return String(filePath || '').split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') || 'Audio Clip';
}

export class SequencerController {
  constructor(hub) {
    this.hub = hub;
    this.model = new SequencerModel(defaultSequencerState());
    this.playing = false;
    this.recording = false;
    this.preCounting = false;
    this.exporting = false;
    this.exportCapabilities = hub.engine.exportCapabilities || {
      wavBitDepths: [16, 24, 32], mp3BitratesKbps: [128, 192, 256, 320],
      oggQualityOptions: [], mp3Available: false
    };
    this.playheadPpq = 0;
    this.tempo = 120;
    this.metronomeEnabled = false;
    this.metronomeVolume = 0.35;
    this._unsubs = [];
    this._syncQueued = false;
    this._activeInputNotes = new Map();
    this._clipClipboard = null;
    this._projectTransitionState = 'idle';
    this._projectTransitionEpoch = 0;
    this._projectTransitionEvents = [];
    this._editorTransportPending = null;
    this._editorTransportPublishing = false;
    this._disposed = false;
    this._exportWatchdog = null;
    this._exportWatchdogFrames = -1;
    this._exportWatchdogExpired = false;
    this._exportWatchdogTimeoutMs = Number.isFinite(hub.exportWatchdogTimeoutMs)
      ? Math.max(10, Number(hub.exportWatchdogTimeoutMs)) : EXPORT_STALL_TIMEOUT_MS;
  }

  load() {
    this.model = new SequencerModel(this.hub.settings.get(STATE_KEY));
    this.tempo = normalizeTempo(this.hub.settings.get('transportBpm'));
    this.metronomeEnabled = this.hub.settings.get('metronomeEnabled') === true;
    const storedMetronomeVolume = Number(this.hub.settings.get('metronomeVolume'));
    this.metronomeVolume = Number.isFinite(storedMetronomeVolume)
      ? Math.max(0, Math.min(1, storedMetronomeVolume)) : 0.35;
    // Older projects stored the physical device as a renderer-only sentinel.
    // Migrate the selection to the real Patch Bay node, but deliberately do
    // not create a cable: graphConnections remains the sole routing authority.
    let migratedInput = false;
    for (const track of this.model.state.tracks) {
      if (track.type === 'audio' && track.inputId === LEGACY_DEVICE_INPUT_ID) {
        track.inputId = AUDIO_INPUT_NODE_ID;
        migratedInput = true;
      }
    }
    if (migratedInput) this.hub.settings.set(STATE_KEY, this.model.snapshot());
    this._unsubs.push(
      this.hub.events.on('engine:transport', (state) => {
        this.playheadPpq = Number(state?.ppqPosition) || 0;
        if (Number.isFinite(Number(state?.bpm))) this._acceptTempo(state.bpm);
        const preCounting = state?.preCount === true;
        if (this.preCounting !== preCounting) {
          this.preCounting = preCounting;
          this.hub.events.emit('sequencer:count-in', {
            active: preCounting,
            beat: Number(state?.preCountBeat) || 0,
            beats: Number(state?.preCountBeats) || 4
          });
        }
        const logicalPlaying = preCounting || state?.playing === true;
        if (typeof state?.playing === 'boolean' && this.playing !== logicalPlaying) {
          this.playing = logicalPlaying;
          this.hub.events.emit('sequencer:transport', { playing: this.playing });
        }
        const logicalRecording = preCounting || state?.recording === true;
        if (typeof state?.recording === 'boolean' && this.recording !== logicalRecording) {
          this.recording = logicalRecording;
          this.hub.events.emit('sequencer:recording', this.recording);
        }
        this.hub.events.emit('sequencer:playhead', this.playheadPpq);
        this._queueEditorTransport();
      }),
      this.hub.events.on('engine:metronomeTick', (event) => {
        this.hub.events.emit('sequencer:metronome-tick', event);
      }),
      this.hub.events.on('engine:sequencerMidiRecorded', (message) => this._acceptMidiRecording(message)),
      this.hub.events.on('engine:sequencerAudioRecorded', (message) => this._acceptAudioRecording(message)),
      this.hub.events.on('engine:sequencerAudioInfo', (message) => this._acceptAudioInfo(message)),
      this.hub.events.on('engine:sequencerExport', (message) => {
        const active = ['preparing', 'started', 'progress', 'finalizing'].includes(message?.state);
        const freshStart = message?.state === 'preparing' && message?.stage === 'START';
        if (freshStart) this._exportWatchdogExpired = false;
        // Once the watchdog has issued Cancel, late telemetry from the retired
        // native transaction must not resurrect Rendering or trigger another
        // cancel. A terminal event is still accepted to close native state.
        if (active && this._exportWatchdogExpired && !freshStart) return;
        this.exporting = active;
        if (!active) {
          this._clearExportWatchdog();
          this._exportWatchdogFrames = -1;
          this._exportWatchdogExpired = false;
        } else if (message?.state === 'progress') {
          const frames = Number(message.frames);
          const stalledMs = Number(message.stalledMs);
          // Native telemetry is periodic even when its audio callback has
          // stopped. Only real frame advancement is activity; otherwise a
          // stream of identical progress packets would keep a dead export
          // alive forever and defeat the watchdog.
          if (Number.isFinite(frames) && frames > this._exportWatchdogFrames) {
            this._exportWatchdogFrames = frames;
            this._armExportWatchdog(message?.filePath);
          } else if (Number.isFinite(stalledMs) && stalledMs >= this._exportWatchdogTimeoutMs) {
            this._armExportWatchdog(message?.filePath, 0);
          } else if (this._exportWatchdog === null) {
            const remaining = Number.isFinite(stalledMs)
              ? Math.max(0, this._exportWatchdogTimeoutMs - stalledMs)
              : this._exportWatchdogTimeoutMs;
            this._armExportWatchdog(message?.filePath, remaining);
          }
        } else {
          if (message?.state === 'preparing' && message?.stage === 'START') this._exportWatchdogFrames = -1;
          this._armExportWatchdog(message?.filePath);
        }
        this.hub.events.emit('sequencer:export', message);
      }),
      this.hub.events.on('engine:sequencerExportCapabilities', (capabilities) => {
        this.exportCapabilities = { ...this.exportCapabilities, ...capabilities };
        this.hub.events.emit('sequencer:export-capabilities', this.exportCapabilities);
      }),
      this.hub.events.on('engine:state', (state) => {
        if (state?.state === 'running') {
          this.syncNative(); this._syncMidiOutput(); this._syncTransportControls();
        }
      }),
      this.hub.events.on('midi:output', () => this._syncMidiOutput()),
      this.hub.events.on('graph:change', (change) => {
        const removedInputCable = change?.type === 'disconnect'
          && change.to?.nodeId === 'sequencer' && change.to?.portId === 'midi-in';
        const removedOutputCable = change?.type === 'disconnect'
          && change.from?.nodeId === 'sequencer' && change.from?.portId === 'midi-out';
        const removedSequencer = change?.type === 'remove' && change.nodeId === 'sequencer';
        const removedDestination = change?.type === 'remove';
        if ((removedInputCable || removedOutputCable || removedSequencer || removedDestination)
            && this._activeInputNotes.size) {
          this._panicLiveDestinations();
          this.hub.engine.sequencerPanic();
        }
      }),
      this.hub.events.on('midi:panic', () => {
        this._panicLiveDestinations();
        this.hub.engine.sequencerPanic();
      })
    );
    const offEditorRequests = this.hub.api.onClipEditorRequest?.((request) => {
      let response;
      try { response = this.handleClipEditorRequest(request); }
      catch (_) { response = { ok: false, reason: 'invalid-request' }; }
      Promise.resolve(this.hub.api.clipEditorRespond?.({
        requestId: request?.requestId,
        ...response
      })).catch(() => {});
    });
    if (offEditorRequests) this._unsubs.push(offEditorRequests);
    Promise.resolve(this.hub.api.clipEditorReady?.()).catch(() => {});
    this._queueEditorTransport();
    this.syncNative();
    this._syncTransportControls();
    return this;
  }

  _acceptTempo(value) {
    const next = normalizeTempo(value, this.tempo);
    if (next === this.tempo) return false;
    this.tempo = next;
    this.hub.settings.set('transportBpm', next);
    this.hub.events.emit('sequencer:tempo', next);
    this._queueEditorTransport();
    return true;
  }

  _syncTransportControls() {
    this.hub.engine.setTransport({ bpm: this.tempo });
    this.hub.engine.setMetronome?.(this.metronomeEnabled, this.metronomeVolume);
  }

  setTempo(value) {
    const next = normalizeTempo(value, this.tempo);
    this._acceptTempo(next);
    // Publish even if the clamped value did not change: a restarted native
    // engine may not yet know the renderer's persisted authoritative tempo.
    this.hub.engine.setTransport({ bpm: next });
    return next;
  }

  setMetronome(enabled) {
    const next = enabled === true;
    if (next !== this.metronomeEnabled) {
      this.metronomeEnabled = next;
      this.hub.settings.set('metronomeEnabled', next);
      this.hub.events.emit('sequencer:metronome', next);
    }
    this.hub.engine.setMetronome?.(next, this.metronomeVolume);
    return next;
  }

  dispose() {
    this._disposed = true;
    this._clearExportWatchdog();
    for (const off of this._unsubs) off?.();
    this._unsubs = [];
    this._activeInputNotes.clear();
    this._projectTransitionState = 'committed';
    this._projectTransitionEvents = [];
    this._editorTransportPending = null;
  }

  _clearExportWatchdog() {
    if (this._exportWatchdog !== null) globalThis.clearTimeout(this._exportWatchdog);
    this._exportWatchdog = null;
  }

  _armExportWatchdog(filePath = '', delayMs = this._exportWatchdogTimeoutMs) {
    this._clearExportWatchdog();
    this._exportWatchdog = globalThis.setTimeout(async () => {
      this._exportWatchdog = null;
      if (!this.exporting || this._disposed) return;
      try { await this.hub.engine.sequencerCancelExport(); } catch (_) {}
      this.exporting = false;
      this._exportWatchdogExpired = true;
      this.hub.events.emit('sequencer:export', {
        state: 'error', stage: 'watchdog', filePath,
        message: 'Export stopped because the engine made no progress for 60 seconds.'
      });
    }, Math.max(0, Number(delayMs) || 0));
    this._exportWatchdog?.unref?.();
  }

  beginProjectTransition() {
    this._projectTransitionEpoch += 1;
    this._projectTransitionState = 'pending';
    this._projectTransitionEvents = [];
  }

  finishProjectTransition(committed) {
    if (committed) {
      this._projectTransitionState = 'committed';
      this._projectTransitionEvents = [];
      return;
    }
    const queued = this._projectTransitionEvents;
    this._projectTransitionEvents = [];
    this._projectTransitionState = 'idle';
    for (const item of queued) {
      const task = item.type === 'midi' ? this._acceptMidiRecording(item.message)
        : item.type === 'audio' ? this._acceptAudioRecording(item.message)
          : this._acceptAudioInfo(item.message);
      Promise.resolve(task).catch(() => {});
    }
  }

  _deferForProjectTransition(type, message) {
    if (this._projectTransitionState === 'idle') return false;
    if (this._projectTransitionState === 'pending') {
      this._projectTransitionEvents.push({ type, message: structuredClone(message) });
    }
    return true;
  }

  changed({ render = true, syncNative = true, invalidateEditors = true } = {}) {
    const snapshot = this.model.snapshot();
    this.hub.settings.set(STATE_KEY, snapshot);
    if (syncNative) this.syncNative();
    if (invalidateEditors) Promise.resolve(this.hub.api.clipEditorInvalidate?.()).catch(() => {});
    if (render) this.hub.events.emit('sequencer:changed', snapshot);
    return snapshot;
  }

  selectClip(clipId, { render = true, toggle = false, range = false, additive = false } = {}) {
    if (!this.model.selectClip(clipId, { toggle, range, additive })) return false;
    // Selection is canonical persisted UI state, but it is not musical data.
    // Never rebuild/panic the native playback plan merely for a click.
    this.changed({ render, syncNative: false, invalidateEditors: false });
    return true;
  }

  focusTrack(trackId, { preserveArmed = false } = {}) {
    const current = this.model.state.focusedTrackId;
    if (current !== trackId && this._activeInputNotes.size) this._panicLiveDestinations();
    const track = this.model.focusTrack(trackId, { preserveArmed });
    if (!track) return null;
    this.changed();
    return track;
  }

  setTrackArmed(trackId, armed, { additive = false } = {}) {
    const track = this.model._track(trackId);
    if (!track || track.armed === (armed === true) && (additive || !armed)) return track;
    if (this._activeInputNotes.size) this._panicLiveDestinations();
    const updated = this.model.setTrackArmed(trackId, armed, { additive });
    if (updated) this.changed();
    return updated;
  }

  setTrackMonitored(trackId, monitored) {
    const track = this.model._track(trackId);
    if (!track || track.monitored === (monitored === true)) return track;
    if (this._activeInputNotes.size) this._panicLiveDestinations();
    return this.setTrack(trackId, { monitored: monitored === true });
  }

  moveClip(clipId, startPpq, targetTrackId = null, { commit = true } = {}) {
    if (!this.model.moveClip(clipId, startPpq, targetTrackId)) return false;
    if (commit) this.changed();
    return true;
  }

  moveClips(clipIds, deltaPpq, targetTrackId = null, options = {}) {
    if (!this.model.moveClips(clipIds, deltaPpq, targetTrackId, options)) return false;
    if (options.commit !== false) this.changed();
    return true;
  }

  resizeClip(clipId, valuePpq, edge = 'end', { commit = true } = {}) {
    const bpm = this.tempo;
    if (!this.model.resizeClip(clipId, valuePpq, edge, { bpm })) return false;
    if (commit) this.changed();
    return true;
  }

  deleteClip(clipId) {
    if (!this.model.removeClip(clipId)) return false;
    this.changed();
    return true;
  }

  deleteSelectedClips() {
    const removed = this.model.removeClips();
    if (removed) this.changed();
    return removed;
  }

  copySelectedClips() {
    const copied = this.model.copyClips();
    if (!copied) return false;
    this._clipClipboard = structuredClone(copied);
    return true;
  }

  pasteClips(atPpq = this.playheadPpq) {
    if (!this._clipClipboard) return [];
    const copies = this.model.pasteClips(this._clipClipboard, atPpq);
    if (copies.length) this.changed();
    return copies;
  }

  duplicateSelectedClips() {
    const copies = this.model.duplicateClips();
    if (copies.length) this.changed();
    return copies;
  }

  clipEditorState(clipId) {
    const found = this.model._clip(clipId);
    if (!found) return null;
    return {
      projectId: this.hub.project?.projectId || '',
      snap: this.model.state.snap,
      track: { id: found.track.id, name: found.track.name, type: found.track.type },
      clip: structuredClone(found.clip),
      transport: this.editorTransportState()
    };
  }

  editorTransportState() {
    return {
      ppqPosition: Math.max(0, Number(this.playheadPpq) || 0),
      playing: this.playing === true,
      recording: this.recording === true,
      bpm: this.tempo
    };
  }

  _queueEditorTransport(state = this.editorTransportState()) {
    if (this._disposed || typeof this.hub.api.clipEditorPublishTransport !== 'function') return;
    this._editorTransportPending = state;
    if (this._editorTransportPublishing) return;
    this._editorTransportPublishing = true;
    const publish = async () => {
      while (!this._disposed && this._editorTransportPending) {
        const next = this._editorTransportPending;
        this._editorTransportPending = null;
        try { await this.hub.api.clipEditorPublishTransport(next); }
        catch (error) { console.error('[clip-editor] transport publication failed', error); }
      }
      this._editorTransportPublishing = false;
    };
    Promise.resolve().then(publish);
  }

  openClipEditor(clipId) {
    if (this.hub.project?._transitionPending || !this.model._clip(clipId) || typeof this.hub.api.clipEditorOpen !== 'function') return false;
    Promise.resolve(this.hub.api.clipEditorOpen(clipId)).catch(() => {});
    return true;
  }

  handleClipEditorRequest(request = {}) {
    const clipId = typeof request.clipId === 'string' ? request.clipId : '';
    if (request.kind === 'get') {
      const state = this.clipEditorState(clipId);
      return state ? { ok: true, state } : { ok: false, reason: 'clip-not-found' };
    }
    if (request.kind === 'transport') {
      if (this.hub.project?._transitionPending) return { ok: false, reason: 'project-transition' };
      if (request.expectedProjectId !== (this.hub.project?.projectId || '')) {
        return { ok: false, reason: 'stale-project' };
      }
      if (!this.model._clip(clipId)) return { ok: false, reason: 'clip-not-found' };
      if (request.operation === 'return-start') this.goToStart();
      else if (request.operation === 'play') this.playTransport();
      else if (request.operation === 'stop') this.stopTransport();
      else return { ok: false, reason: 'unsupported-request' };
      const transport = this.editorTransportState();
      this._queueEditorTransport(transport);
      return { ok: true, transport };
    }
    if (request.kind !== 'update') return { ok: false, reason: 'unsupported-request' };
    if (this.hub.project?._transitionPending) return { ok: false, reason: 'project-transition' };
    if (request.expectedProjectId !== (this.hub.project?.projectId || '')) {
      return { ok: false, reason: 'stale-project' };
    }
    const found = this.model._clip(clipId);
    if (!found) return { ok: false, reason: 'clip-not-found' };
    const payload = request.payload && typeof request.payload === 'object' ? request.payload : {};
    let applied = 0;
    if (request.operation === 'quantize' && found.track.type === 'midi') {
      applied = this.model.quantizeMidiClip(clipId, payload);
    } else if (request.operation === 'add-note' && found.track.type === 'midi') {
      applied = this.model.addMidiNote(clipId, payload) ? 1 : 0;
    } else if (request.operation === 'update-note' && found.track.type === 'midi') {
      applied = this.model.updateMidiNote(clipId, payload.noteId, payload.changes) ? 1 : 0;
    } else if (request.operation === 'delete-notes' && found.track.type === 'midi') {
      applied = this.model.removeMidiNotes(clipId, payload.noteIds);
    } else if (request.operation === 'update-audio' && found.track.type === 'audio') {
      const bpm = this.tempo;
      applied = this.model.updateAudioClip(clipId, payload, { bpm }) ? 1 : 0;
    } else {
      return { ok: false, reason: 'clip-type-mismatch' };
    }
    if (applied > 0) this.changed();
    return { ok: true, applied, state: this.clipEditorState(clipId) };
  }

  syncNative() {
    if (this._syncQueued) return;
    this._syncQueued = true;
    queueMicrotask(() => {
      this._syncQueued = false;
      const state = this.model.snapshot();
      const incomingMidi = this.hub.graph.connectionsTo('sequencer', 'midi-in')
        .filter(isCanonicalMidiIngress);
      const incomingAudio = new Set(this.hub.graph.connectionsTo('sequencer', 'audio-in')
        .map((connection) => connection.from.nodeId));
      const routedMidi = new Set(this.hub.graph.connectionsFrom('sequencer', 'midi-out').map((connection) => connection.to.nodeId));
      const routedAudio = new Set(this.hub.graph.connectionsFrom('sequencer', 'audio-out').map((connection) => connection.to.nodeId));
      const native = {
        ...state,
        tracks: state.tracks.map((track) => ({
          ...track,
          inputId: track.type === 'midi'
            ? (incomingMidi.length > 0 && track.inputId === this.hub.midi.selectedInputId ? track.inputId : '')
            : (incomingAudio.has(track.inputId) ? track.inputId : ''),
          outputKind: this.hub.graph.getNode(track.outputId)?.type || '',
          outputId: track.type === 'midi'
            ? (routedMidi.has(track.outputId) ? track.outputId : '')
            : (routedAudio.has(track.outputId) ? track.outputId : '')
        }))
      };
      this.hub.engine.syncSequencer(native);
      this.hub.engine.setTransport({ loop: state.loop });
    });
  }

  _liveDestinationIds() {
    if (!this.hub.graph.connectionsTo(SEQUENCER_NODE_ID, 'midi-in').some(isCanonicalMidiIngress)) return [];
    const selectedInputId = this.hub.midi.selectedInputId;
    const connected = new Set(this.hub.graph.connectionsFrom(SEQUENCER_NODE_ID, 'midi-out')
      .map((connection) => connection.to.nodeId));
    return [...new Set(this.model.state.tracks
      .filter((track) => track.type === 'midi'
        && (track.armed || track.monitored)
        && track.inputId === selectedInputId
        && track.outputId && connected.has(track.outputId))
      .map((track) => track.outputId))];
  }

  _sendLiveMidi(destinationId, message, raw) {
    const routed = this.hub.graph.emitDataTo?.(SEQUENCER_NODE_ID, 'midi-out', destinationId, {
      ...message, raw: [...raw]
    }) === true;
    if (routed) return true;
    // A disconnect event is emitted after its cable disappears. Held-note
    // cleanup must still reach the old native destination in that narrow
    // window, otherwise the missing cable also removes the only Note Off path.
    const node = this.hub.graph.getNode(destinationId);
    if (node?.type === 'vst') this.hub.engine.midi?.(destinationId, raw);
    else if (node?.type === 'arpeggiator') this.hub.engine.midiNode?.(destinationId, raw);
    else if (node?.type === 'midi-output') this.hub.midi.send?.(raw);
    else return false;
    return true;
  }

  _panicLiveDestinations() {
    const destinations = new Set(this._liveDestinationIds());
    for (const [key, held] of this._activeInputNotes) {
      const parts = key.split(':');
      const channel = Number(parts.at(-2)) & 0x0f;
      const note = Number(parts.at(-1)) & 0x7f;
      for (const press of held) for (const destination of press.destinations) {
        destinations.add(destination);
        this._sendLiveMidi(destination, { type: 'noteoff', channel: channel + 1, note, velocity: 0 }, [0x80 | channel, note, 0]);
      }
    }
    for (const destination of destinations) for (let channel = 0; channel < 16; channel += 1) {
      this._sendLiveMidi(destination, { type: 'cc', channel: channel + 1, controller: 123, value: 0 }, [0xb0 | channel, 123, 0]);
      this._sendLiveMidi(destination, { type: 'cc', channel: channel + 1, controller: 120, value: 0 }, [0xb0 | channel, 120, 0]);
    }
    this._activeInputNotes.clear();
  }

  /** Accept one message that has actually crossed Sequencer MIDI IN, then
   * route live performance only to armed/monitored track destinations. */
  receiveMidiInput(message) {
    if (!message || !Array.isArray(message.raw) || message.raw.length < 1) return false;
    const raw = message.raw;
    const status = Number(raw[0]) & 0xf0;
    const channel = Number(raw[0]) & 0x0f;
    const note = Number(raw[1]) & 0x7f;
    const key = `${message.sourceId || ''}:${channel}:${note}`;
    if (this.recording) {
      this.hub.engine.sequencerMidiInput(message.sourceId || '', raw, Number(message.offsetMs) || 0);
    }
    const isNoteOn = status === 0x90 && (Number(raw[2]) & 0x7f) > 0;
    const isNoteOff = status === 0x80 || (status === 0x90 && (Number(raw[2]) & 0x7f) === 0);
    if (isNoteOn) {
      const destinations = this._liveDestinationIds();
      for (const destination of destinations) this._sendLiveMidi(destination, message, raw);
      const held = this._activeInputNotes.get(key) || [];
      held.push({ destinations });
      this._activeInputNotes.set(key, held);
    } else if (isNoteOff) {
      const held = this._activeInputNotes.get(key) || [];
      const press = held.pop();
      for (const destination of press?.destinations || []) this._sendLiveMidi(destination, message, raw);
      if (held.length) this._activeInputNotes.set(key, held);
      else this._activeInputNotes.delete(key);
    } else {
      for (const destination of this._liveDestinationIds()) this._sendLiveMidi(destination, message, raw);
    }
    return true;
  }

  _syncMidiOutput() {
    const port = this.hub.midi.getOutput(this.hub.midi.selectedOutputId);
    this.hub.engine.selectMidiOutput(port ? { identifier: port.id, name: port.name } : null);
  }

  ensureRoute(track) {
    if (!track?.outputId) return false;
    const fromPort = track.type === 'midi' ? 'midi-out' : 'audio-out';
    const target = this.hub.graph.getNode(track.outputId);
    if (!target) return false;
    if (track.type === 'audio' && !this.canUseAudioOutput(track.outputId)) return false;
    let toPort = track.type === 'midi' ? 'midi-in' : 'audio-in';
    if (track.type === 'audio' && !target.inputs.some((port) => port.id === toPort)) {
      toPort = target.inputs.find((port) => port.type === 'audio')?.id || '';
    }
    if (!toPort) return false;
    const exists = this.hub.graph.connectionsFrom('sequencer', fromPort)
      .some((connection) => connection.to.nodeId === track.outputId);
    if (!exists) {
      try { return this.hub.graph.connect('sequencer', fromPort, track.outputId, toPort); }
      catch (_) { return false; }
    }
    return true;
  }

  ensureInputRoute(track) {
    if (track?.type !== 'audio' || !track.inputId) return false;
    if (!this.canUseAudioInput(track.inputId)) return false;
    const source = this.hub.graph.getNode(track.inputId);
    const target = this.hub.graph.getNode(SEQUENCER_NODE_ID);
    if (!source || !target) return false;
    const fromPort = source.outputs.find((port) => port.id === 'audio-out' && port.type === 'audio')
      || source.outputs.find((port) => port.type === 'audio');
    const toPort = target.inputs.find((port) => port.id === 'audio-in' && port.type === 'audio');
    if (!fromPort || !toPort) return false;
    const exists = this.hub.graph.connectionsFrom(source.id, fromPort.id)
      .some((connection) => connection.to.nodeId === SEQUENCER_NODE_ID && connection.to.portId === toPort.id);
    if (!exists) return this.hub.graph.connect(source.id, fromPort.id, SEQUENCER_NODE_ID, toPort.id);
    return true;
  }

  _audioReachableFrom(startNodeId) {
    const reachable = new Set();
    const pending = [startNodeId];
    while (pending.length) {
      const nodeId = pending.pop();
      for (const connection of this.hub.graph.connectionsFrom(nodeId)) {
        const source = this.hub.graph.getNode(connection.from.nodeId);
        const target = this.hub.graph.getNode(connection.to.nodeId);
        const fromPort = source?.outputs.find((port) => port.id === connection.from.portId);
        const toPort = target?.inputs.find((port) => port.id === connection.to.portId);
        if (fromPort?.type !== 'audio' || toPort?.type !== 'audio' || reachable.has(connection.to.nodeId)) continue;
        reachable.add(connection.to.nodeId);
        pending.push(connection.to.nodeId);
      }
    }
    return reachable;
  }

  canUseAudioInput(sourceNodeId) {
    const source = this.hub.graph.getNode(sourceNodeId);
    const sequencer = this.hub.graph.getNode(SEQUENCER_NODE_ID);
    if (!source || !sequencer || source.id === sequencer.id
        || !source.outputs.some((port) => port.type === 'audio')) return false;
    return !this._audioReachableFrom(SEQUENCER_NODE_ID).has(source.id);
  }

  canUseAudioOutput(targetNodeId) {
    const target = this.hub.graph.getNode(targetNodeId);
    const sequencer = this.hub.graph.getNode(SEQUENCER_NODE_ID);
    if (!target || !sequencer || target.id === sequencer.id
        || !target.inputs.some((port) => port.type === 'audio')) return false;
    return !this._audioReachableFrom(target.id).has(SEQUENCER_NODE_ID);
  }

  hasInputRoute(track) {
    if (!track?.inputId || !this.hub.graph.getNode(SEQUENCER_NODE_ID)) return false;
    if (track.type === 'midi') {
      return track.inputId === this.hub.midi.selectedInputId
        && this.hub.graph.connectionsTo(SEQUENCER_NODE_ID, 'midi-in')
          .some(isCanonicalMidiIngress);
    }
    return this.hub.graph.connectionsTo(SEQUENCER_NODE_ID, 'audio-in')
      .some((connection) => connection.from.nodeId === track.inputId);
  }

  /** Human-readable reason why a take cannot start, or an empty string when ready. */
  recordBlockReason() {
    if (this.hub.project?._transitionPending) {
      return 'Cannot start recording while changing project. Wait for the project change to finish.';
    }
    if (!this.hub.graph.getNode(SEQUENCER_NODE_ID)) {
      return 'Add the Sequencer node in Patch Bay before recording.';
    }
    if (this.hub.engine.state && this.hub.engine.state !== 'running') {
      return 'The audio engine is not running. Check Audio Output before recording.';
    }
    const tracks = this.model.state.tracks;
    if (!tracks.length) return 'Add at least one MIDI or audio track before recording.';
    const armed = tracks.filter((track) => track.armed);
    if (!armed.length) return 'Arm at least one track with its R button.';
    if (armed.some((track) => this.hasInputRoute(track))) return '';

    const armedMidi = armed.filter((track) => track.type === 'midi');
    if (armedMidi.length) {
      if (!this.hub.midi.selectedInputId) {
        return 'No MIDI input is detected or selected. Connect MiniLab 3, then choose it in the track Input field.';
      }
      if (armedMidi.every((track) => !track.inputId)) {
        return 'Choose the detected MIDI port in the armed track Input field.';
      }
      if (!this.hub.graph.connectionsTo(SEQUENCER_NODE_ID, 'midi-in').some(isCanonicalMidiIngress)) {
        return 'Connect MiniLab 3 MIDI OUT to Sequencer MIDI IN in Patch Bay.';
      }
      return 'The armed MIDI track Input must match the selected MiniLab MIDI port.';
    }

    if (armed.every((track) => !track.inputId)) {
      return 'Choose an audio source in the armed track Input field.';
    }
    return 'Connect the selected audio source to Sequencer AUDIO IN in Patch Bay.';
  }

  setTrack(trackId, changes) {
    const keys = Object.keys(changes || {});
    if (keys.length > 0 && keys.every((key) => key === 'volume' || key === 'muted')) {
      return this.setTrackControl(trackId, changes);
    }
    const previous = this.model.state.tracks.find((item) => item.id === trackId);
    const previousOutput = previous?.outputId || '';
    const previousInput = previous?.inputId || '';
    if (this._activeInputNotes.size && ['armed', 'monitored', 'inputId', 'outputId'].some((key) => key in changes)) {
      this._panicLiveDestinations();
    }
    const track = this.model.updateTrack(trackId, changes);
    if (track?.type === 'audio' && 'inputId' in changes) {
      if (previousInput && previousInput !== track.inputId
          && !this.model.state.tracks.some((item) => item.id !== trackId && item.type === 'audio' && item.inputId === previousInput)) {
        for (const connection of this.hub.graph.connectionsTo(SEQUENCER_NODE_ID, 'audio-in')
          .filter((item) => item.from.nodeId === previousInput)) {
          this.hub.graph.disconnect(connection.from.nodeId, connection.from.portId, SEQUENCER_NODE_ID, 'audio-in');
        }
      }
      this.ensureInputRoute(track);
    }
    if (track && 'outputId' in changes) {
      const port = track.type === 'midi' ? 'midi-out' : 'audio-out';
      const routeReady = !track.outputId || this.ensureRoute(track);
      if (!routeReady) {
        this.model.updateTrack(trackId, { outputId: previousOutput });
        this.changed();
        return this.model.state.tracks.find((item) => item.id === trackId) || null;
      }
      if (previousOutput && previousOutput !== track.outputId
          && !this.model.state.tracks.some((item) => item.id !== trackId && item.type === track.type && item.outputId === previousOutput)) {
        for (const connection of this.hub.graph.connectionsFrom('sequencer', port)
          .filter((item) => item.to.nodeId === previousOutput)) {
          this.hub.graph.disconnect('sequencer', port, connection.to.nodeId, connection.to.portId);
        }
      }
    }
    this.changed();
    return track;
  }

  setTrackControl(trackId, changes, { render = true } = {}) {
    const track = this.model.updateTrack(trackId, changes);
    if (!track) return null;
    const snapshot = this.model.snapshot();
    this.hub.settings.set(STATE_KEY, snapshot);
    this.hub.engine.setSequencerTrackControl?.(track.id, track.volume, track.muted);
    if (render) this.hub.events.emit('sequencer:changed', snapshot);
    return track;
  }

  removeTrack(trackId) {
    const track = this.model.state.tracks.find((item) => item.id === trackId);
    if (track && this._activeInputNotes.size) this._panicLiveDestinations();
    if (!track || !this.model.removeTrack(trackId)) return false;
    if (track.type === 'audio' && track.inputId
        && !this.model.state.tracks.some((item) => item.type === 'audio' && item.inputId === track.inputId)) {
      for (const connection of this.hub.graph.connectionsTo(SEQUENCER_NODE_ID, 'audio-in')
        .filter((item) => item.from.nodeId === track.inputId)) {
        this.hub.graph.disconnect(connection.from.nodeId, connection.from.portId, SEQUENCER_NODE_ID, 'audio-in');
      }
    }
    const port = track.type === 'midi' ? 'midi-out' : 'audio-out';
    if (track.outputId && !this.model.state.tracks.some((item) => item.type === track.type && item.outputId === track.outputId)) {
      for (const connection of this.hub.graph.connectionsFrom('sequencer', port)
        .filter((item) => item.to.nodeId === track.outputId)) {
        this.hub.graph.disconnect('sequencer', port, connection.to.nodeId, connection.to.portId);
      }
    }
    this.changed();
    return true;
  }

  startRecording({ notify = false } = {}) {
    const reason = this.recordBlockReason();
    if (reason) {
      this.hub.events.emit('sequencer:record-blocked', { message: reason });
      if (notify) globalThis.alert?.(reason);
      return false;
    }
    this.preCounting = this.metronomeEnabled && !this.playing;
    this.recording = true;
    this.playing = true;
    this.hub.engine.sequencerRecord(true);
    this.hub.events.emit('sequencer:recording', true);
    this.hub.events.emit('sequencer:transport', { playing: true });
    if (this.preCounting) this.hub.events.emit('sequencer:count-in', { active: true, beat: 0, beats: 4 });
    this._queueEditorTransport();
    return true;
  }

  stopRecording({ awaitEngine = false } = {}) {
    if (!this.recording) return false;
    if (this.preCounting) {
      this.preCounting = false;
      this.hub.events.emit('sequencer:count-in', { active: false, beat: 0, beats: 4 });
    }
    this.recording = false;
    const command = this.hub.engine.sequencerRecord(false);
    this.hub.events.emit('sequencer:recording', false);
    // UI callers keep the historical synchronous boolean contract. Project
    // replacement can opt into the command Promise so the native stop has at
    // least crossed the main-process IPC boundary before staging a reload.
    return awaitEngine ? Promise.resolve(command).then(() => true) : true;
  }

  playTransport() {
    if (this.preCounting) return true;
    if (!this.playing) {
      this.playing = true;
      this.hub.events.emit('sequencer:transport', { playing: true });
    }
    this.hub.engine.setTransport({ playing: true });
    this._queueEditorTransport();
    return true;
  }

  stopTransport() {
    this.stopRecording();
    if (this.playing) {
      this.playing = false;
      this.hub.events.emit('sequencer:transport', { playing: false });
    }
    this.hub.engine.setTransport({ playing: false });
    this._queueEditorTransport();
    return true;
  }

  seek(ppq) {
    this.playheadPpq = Math.max(0, Number(ppq) || 0);
    this.hub.events.emit('sequencer:playhead', this.playheadPpq);
    this.hub.engine.setTransport({ seekPpq: this.playheadPpq });
    this._queueEditorTransport();
    return true;
  }

  goToStart() {
    return this.seek(0);
  }

  goToEnd() {
    return this.seek(this.model.arrangementEndPpq());
  }

  async importAudio(trackId, startPpq = this.playheadPpq) {
    const filePath = await this.hub.api.audioPickOpen();
    if (!filePath) return null;
    const clip = this.model.addAudioClip(trackId, {
      name: baseName(filePath), filePath, startPpq,
      durationSeconds: 1, trimStartSeconds: 0, trimEndSeconds: 1,
      lengthPpq: 4, gain: 1
    });
    if (clip) this.changed();
    return clip;
  }

  async exportMaster(range = 'full', options = {}) {
    if (this.exporting) return false;
    const format = ['wav', 'mp3', 'ogg'].includes(String(options.format).toLowerCase())
      ? String(options.format).toLowerCase() : 'wav';
    const filePath = await this.hub.api.audioPickSave(`${this.hub.project.currentProjectName} Mix`, format);
    if (!filePath) return false;
    const loop = this.model.state.loop;
    const startPpq = range === 'loop' ? loop.startPpq : 0;
    const arrangementEnd = this.model.arrangementEndPpq();
    const endPpq = range === 'loop' ? loop.endPpq : (arrangementEnd > 0 ? arrangementEnd : 4);
    this.exporting = true;
    this._exportWatchdogFrames = -1;
    this._exportWatchdogExpired = false;
    this.hub.events.emit('sequencer:export', {
      state: 'preparing', stage: 'START', filePath, startPpq, endPpq
    });
    this._armExportWatchdog(filePath);
    try {
      const accepted = await this.hub.engine.sequencerExport({
        filePath, startPpq, endPpq,
        tailSeconds: Math.max(0, Math.min(30, Number(options.tailSeconds ?? 2))),
        format,
        bits: [16, 24, 32].includes(Number(options.bits)) ? Number(options.bits) : 24,
        bitrateKbps: [128, 192, 256, 320].includes(Number(options.bitrateKbps))
          ? Number(options.bitrateKbps) : 320,
        qualityIndex: Number.isInteger(Number(options.qualityIndex))
          ? Number(options.qualityIndex) : -1
      });
      if (accepted?.ok === false) throw new Error(accepted.reason || 'Audio engine rejected export');
    } catch (error) {
      this.exporting = false;
      this._clearExportWatchdog();
      this.hub.events.emit('sequencer:export', {
        state: 'error', filePath,
        message: error?.message || 'Could not start export'
      });
      return false;
    }
    return true;
  }

  async cancelExport() {
    if (!this.exporting) return false;
    const accepted = await this.hub.engine.sequencerCancelExport();
    return accepted?.ok !== false;
  }

  _acceptMidiRecording(message) {
    if (this._deferForProjectTransition('midi', message)) return;
    const track = this.model.state.tracks.find((item) => item.id === message?.trackId && item.type === 'midi');
    if (!track || !Array.isArray(message.events) || !message.events.length) return;
    const startPpq = Math.max(0, Number(message.startPpq) || 0);
    const endPpq = Math.max(startPpq + 0.125, Number(message.endPpq) || startPpq + 4);
    this.model.addMidiClip(track.id, startPpq, endPpq - startPpq,
      message.events.map((event) => ({
        pitch: event.pitch,
        startPpq: Math.max(0, Number(event.startPpq) - startPpq),
        durationPpq: event.durationPpq,
        velocity: event.velocity,
        channel: event.channel
      })));
    this.changed();
  }

  async _acceptAudioRecording(message) {
    if (this._deferForProjectTransition('audio', message)) return;
    const transitionEpoch = this._projectTransitionEpoch;
    const projectId = this.hub.project?.projectId || '';
    let track = this.model.state.tracks.find((item) => item.id === message?.trackId && item.type === 'audio');
    if (!track || !message.filePath || !(Number(message.durationSeconds) > 0)) return;
    const committed = await this.hub.api.audioCommitTake(message.filePath, `${track.name} Take`);
    if (this._projectTransitionState !== 'idle') return;
    if (transitionEpoch !== this._projectTransitionEpoch && projectId !== (this.hub.project?.projectId || '')) return;
    if (projectId !== (this.hub.project?.projectId || '')) return;
    track = this.model.state.tracks.find((item) => item.id === message?.trackId && item.type === 'audio');
    if (!track) return;
    const filePath = committed?.ok ? committed.filePath : message.filePath;
    const bpm = Math.max(20, Number(message.bpm) || 120);
    const durationSeconds = Number(message.durationSeconds);
    this.model.addAudioClip(track.id, {
      name: `${track.name} Take`, filePath,
      startPpq: Math.max(0, Number(message.startPpq) || 0),
      durationSeconds, trimStartSeconds: 0, trimEndSeconds: durationSeconds,
      lengthPpq: Math.max(0.125, durationSeconds * bpm / 60), gain: 1
    });
    this.changed();
  }

  _acceptAudioInfo(message) {
    if (this._deferForProjectTransition('audio-info', message)) return;
    const found = this.model._clip(message?.clipId);
    if (!found || found.track.type !== 'audio') return;
    const statusBefore = JSON.stringify([found.clip.mediaAvailable, found.clip.mediaError]);
    found.clip.mediaAvailable = message?.available !== false;
    found.clip.mediaError = message?.available === false
      ? String(message?.message || 'Audio media is unavailable')
      : '';
    const duration = Number(message.durationSeconds);
    if (!(duration > 0)) {
      if (statusBefore !== JSON.stringify([found.clip.mediaAvailable, found.clip.mediaError])) {
        this.hub.events.emit('sequencer:changed', this.model.snapshot());
      }
      return;
    }
    const before = JSON.stringify([found.clip.durationSeconds, found.clip.trimEndSeconds, found.clip.lengthPpq, found.clip.peaks]);
    found.clip.durationSeconds = duration;
    if (found.clip.trimEndSeconds <= 1 || found.clip.trimEndSeconds > duration) found.clip.trimEndSeconds = duration;
    if (Array.isArray(message.peaks)) found.clip.peaks = message.peaks;
    const bpm = this.tempo;
    found.clip.lengthPpq = Math.max(0.125, (found.clip.trimEndSeconds - found.clip.trimStartSeconds) * bpm / 60);
    const after = JSON.stringify([found.clip.durationSeconds, found.clip.trimEndSeconds, found.clip.lengthPpq, found.clip.peaks]);
    if (before !== after) this.changed();
    else if (statusBefore !== JSON.stringify([found.clip.mediaAvailable, found.clip.mediaError])) {
      this.hub.events.emit('sequencer:changed', this.model.snapshot());
    }
  }
}

export { STATE_KEY as SEQUENCER_STATE_KEY };
