import { SEQUENCER_LIMITS, SequencerModel, defaultSequencerState, initialSequencerState, trackSilenced } from './sequencerModel.js';
import { normalizeTempo } from './tempoControl.js';
import { AUDIO_INPUT_NODE_ID, SEQUENCER_NODE_ID } from './systemNodes.js';
import { isControllerNode, controllerName } from './controllerNode.js';
import { preferenceForPort, resolvePortPreference } from '../midi/portIdentity.js';
import { midiThruReach } from './midiThru.js';
import { createInstrument } from './instrumentTrack.js';
import { barStep, meterBarAt, meterRegionAt, normalizeSignature } from './musicalTime.js';

const STATE_KEY = 'sequencerState';
/** What Play plays -- `setPlayScope`. The first is the default. */
export const PLAY_SCOPES = Object.freeze(['all', 'sequencer', 'players']);
const LEGACY_DEVICE_INPUT_ID = 'device-input';
const EXPORT_STALL_TIMEOUT_MS = 60000;

/**
 * How many transport frames the renderer holds its own Record intent before
 * believing the engine's "not recording".
 *
 * `sequencerRecord(true)` and the transport telemetry are two different
 * directions of the same 60 Hz conversation, so between the click and the
 * engine's first confirmation there is always at least one frame that still
 * reports `recording: false`. Taking that frame at face value flipped
 * `this.recording` back off, and `receiveMidiInput` forwards nothing while it
 * is off -- which is exactly how the opening notes of a take disappeared with
 * no error anywhere. Twenty frames is a third of a second: long enough to cover
 * the round trip, short enough that a genuine refusal still surfaces.
 */
const RECORD_CONFIRM_GRACE_FRAMES = 20;

/**
 * The upper bound on an auditioned note's length, and the source name it
 * travels under.
 *
 * The bound is not politeness: the note-off is a scheduled callback, so an
 * unbounded duration is a note held inside a VST for as long as the window
 * lives. `clipEditorWindows.js` refuses anything longer on the way in; this
 * is the same number on the renderer side, because a payload that arrived
 * from anywhere else must land on the same ceiling.
 */
const AUDITION_MAX_MS = 4000;
const AUDITION_SOURCE_ID = 'clip-editor-audition';

/**
 * A cable carrying what is PLAYED into the sequencer.
 *
 * It used to be `from.nodeId === MINILAB_NODE_ID`, which is the sequencer
 * holding an opinion about which keyboard is plugged in. What actually decides
 * is the kind of node the cable leaves -- `isControllerNode` in
 * `core/controllerNode.js` is that shape, and a controller under any profile id
 * satisfies it.
 *
 * The port check on this side is not tidiness either: it says the cable leaves
 * the node by the side that carries what the hardware plays, so a cable drawn
 * from any other output of the same node is not an ingress.
 *
 * Exported because `modules/sequencer/sequencerModule.js` asked the same
 * question with its own copy of the id comparison, and two answers to "is this
 * the controller's cable" disagree the day a profile changes.
 */
export const isCanonicalMidiIngress = (network, connection) =>
  connection?.from?.portId === 'midi-out'
  && isControllerNode(network?.getNode(connection.from.nodeId));

function baseName(filePath) {
  return String(filePath || '').split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') || 'Audio Clip';
}

/** The metronome's modes; anything else is the one it always had. */
export const METRONOME_MODES = Object.freeze(['play-rec', 'rec']);

/**
 * What a take does to the clips already on its track (D-063): `overdub` adds
 * to them, `replace` clears what it went over. Overdub first, because it is
 * what the author asked for and the one that never takes a note away.
 */
export const RECORD_MODES = Object.freeze(['overdub', 'replace']);

export function normalizeRecordMode(value) {
  return RECORD_MODES.includes(value) ? value : 'overdub';
}

export function normalizeMetronomeMode(value) {
  return METRONOME_MODES.includes(value) ? value : 'play-rec';
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
    // The export panel's choices, kept here rather than in the panel: the
    // panel is built and dropped with each opening, and a format chosen once
    // is the format of the next export.
    this.exportOptions = { range: 'full', format: 'wav', bits: 24, bitrateKbps: 320, qualityIndex: -1, tailSeconds: 2 };
    this.playheadPpq = 0;
    this.tempo = 120;
    this.metronomeEnabled = false;
    this.metronomeMode = 'play-rec';
    this.recordMode = 'overdub';
    // The mode the take in progress was started in: switching it while a take
    // runs is for the next one.
    this._takeRecordMode = 'overdub';
    this.playScope = 'all';
    this.metronomeVolume = 0.35;
    this._unsubs = [];
    this._syncQueued = false;
    this._activeInputNotes = new Map();
    this._recordConfirmPending = false;
    this._recordConfirmFrames = 0;
    this._clipClipboard = null;
    this._auditionNotes = [];
    this._projectTransitionState = 'idle';
    this._projectTransitionEpoch = 0;
    this._projectTransitionEvents = [];
    this._editorTransportPending = null;
    this._editorTransportPublishing = false;
    // The signature the engine was last told, as "n/d": `changed()` runs on
    // every edit, and the engine is told again only when it moved.
    this._signatureSent = '';
    this._disposed = false;
    this._exportWatchdog = null;
    this._exportWatchdogFrames = -1;
    this._exportWatchdogExpired = false;
    this._exportWatchdogTimeoutMs = Number.isFinite(hub.exportWatchdogTimeoutMs)
      ? Math.max(10, Number(hub.exportWatchdogTimeoutMs)) : EXPORT_STALL_TIMEOUT_MS;
  }

  load() {
    // An absent key means no sequencer state was ever authored -- a fresh
    // launch or a brand new project -- and that opens on one MIDI track. A
    // stored state whose track list is empty was emptied on purpose and is
    // left alone, which is why the test is on the key and not on the length.
    const stored = this.hub.settings.get(STATE_KEY);
    const seeded = stored === null || stored === undefined;
    this.model = new SequencerModel(seeded ? initialSequencerState() : stored);
    this.tempo = normalizeTempo(this.hub.settings.get('transportBpm'));
    this.metronomeEnabled = this.hub.settings.get('metronomeEnabled') === true;
    this.metronomeMode = normalizeMetronomeMode(this.hub.settings.get('metronomeMode'));
    this.recordMode = normalizeRecordMode(this.hub.settings.get('recordMode'));
    this.playScope = PLAY_SCOPES.includes(this.hub.settings.get('playScope')) ? this.hub.settings.get('playScope') : 'all';
    const storedMetronomeVolume = Number(this.hub.settings.get('metronomeVolume'));
    this.metronomeVolume = Number.isFinite(storedMetronomeVolume)
      ? Math.max(0, Math.min(1, storedMetronomeVolume)) : 0.35;
    // Older projects stored the physical device as a renderer-only sentinel.
    // Migrate the selection to the real Patch Bay node, but deliberately do
    // not create a cable: networkConnections remains the sole routing authority.
    let migratedInput = false;
    for (const track of this.model.state.tracks) {
      if (track.type === 'audio' && track.inputId === LEGACY_DEVICE_INPUT_ID) {
        track.inputId = AUDIO_INPUT_NODE_ID;
        migratedInput = true;
      }
    }
    // MIDI ports are usually not enumerated yet at this point -- `midi.init()`
    // runs later in app.js -- so this pass is for the case where they are, and
    // `midi:preference` below is what answers on a normal launch.
    if (this._resolveMidiTrackInputs()) migratedInput = true;
    if (migratedInput || seeded) this.hub.settings.set(STATE_KEY, this.model.snapshot());
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
        if (typeof state?.recording === 'boolean') {
          const accepted = this._acceptEngineRecording(logicalRecording);
          if (this.recording !== accepted) {
            this.recording = accepted;
            if (this.metronomeMode === 'rec') this._publishMetronome();
            this.hub.events.emit('sequencer:recording', this.recording);
          }
        }
        this.hub.events.emit('sequencer:playhead', this.playheadPpq);
        this._queueEditorTransport();
      }),
      this.hub.events.on('engine:metronomeTick', (event) => {
        this.hub.events.emit('sequencer:metronome-tick', event);
      }),
      // Emitted once the port list has settled AND the preferred port has been
      // re-armed, which is later than 'midi:ports' and is the moment a track's
      // stored port can be matched against something real.
      this.hub.events.on('midi:preference', () => {
        if (this._resolveMidiTrackInputs()) this.changed();
      }),
      this.hub.events.on('engine:sequencerMidiRecorded', (message) => this._acceptMidiRecording(message)),
      this.hub.events.on('engine:sequencerAudioRecorded', (message) => this._acceptAudioRecording(message)),
      this.hub.events.on('engine:sequencerAutomationRecorded', (message) => this._acceptAutomationRecording(message)),
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
      this.hub.events.on('network:change', (change) => {
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
    this._publishSignature({ force: true });
    this._publishMetronome();
    this.hub.engine.setPlayScope?.(this.playScope);
  }

  setTempo(value) {
    const next = normalizeTempo(value, this.tempo);
    this._acceptTempo(next);
    // Publish even if the clamped value did not change: a restarted native
    // engine may not yet know the renderer's persisted authoritative tempo.
    this.hub.engine.setTransport({ bpm: next });
    return next;
  }

  /** The project's time signature at bar one, `{ numerator, denominator }` (D-059). */
  get signature() {
    return normalizeSignature(this.model?.state?.signature);
  }

  /** The project's bars, its changes included (D-061). */
  projectRegions() {
    return this.model.projectRegions();
  }

  /** The project's signature where `ppq` is -- the playhead by default. */
  signatureAt(ppq = this.playheadPpq) {
    return meterRegionAt(this.projectRegions(), ppq).signature;
  }

  /**
   * The header's gesture: change the signature in force at the playhead, from
   * where it began -- bar one's, or the change the playhead is under. What
   * Ableton's and Reaper's transport field do once a song has changes.
   */
  setSignatureAt(ppq, signature) {
    const before = JSON.stringify(this.projectRegions());
    this.model.setSignatureAt(ppq, normalizeSignature(signature, this.signatureAt(ppq)));
    if (JSON.stringify(this.projectRegions()) !== before) this.changed();
    return this.signatureAt(ppq);
  }

  /** A change of the project's signature at its bar `bar`; `null` takes it off (D-061). */
  setProjectMeterChange(bar, signature) {
    const before = JSON.stringify(this.projectRegions());
    const meter = this.model.setProjectMeterChange(bar, signature);
    if (meter && JSON.stringify(this.projectRegions()) !== before) this.changed();
    return meter;
  }

  /**
   * Change the project's time signature. The notes keep their positions in
   * quarters and the bar lines move over them, which is what a workstation
   * does when a whole song's signature changes: nothing moves under you, and
   * an undo puts the old bars back.
   */
  setSignature(signature) {
    if (this.model.setSignature(signature)) this.changed();
    return this.signature;
  }

  /**
   * Change part of an audio clip's fade -- its length, shape, curve or low-pass
   * sweep -- and publish it (D-062). `direction` is `in` or `out`.
   */
  setClipFade(clipId, direction, changes) {
    const key = direction === 'out' ? 'fadeOut' : 'fadeIn';
    const clip = this.model.updateAudioClip(clipId, { [key]: changes }, { bpm: this.tempo });
    if (clip) this.changed();
    return clip ? clip[key] : null;
  }

  /**
   * A signature change on one track, at one of its own bars; `null` takes it
   * off (D-060). The engine is not told: notes are in quarters and play the
   * same, and plugins keep the project's signature -- one transport, and an
   * instrument two tracks may feed.
   */
  setTrackMeterChange(trackId, bar, signature) {
    const meter = this.model.setTrackMeterChange(trackId, bar, signature);
    if (meter) this.changed();
    return meter;
  }

  /**
   * Tell the engine, the shell and the open Clip Editors when the signature
   * moved. It rides on `changed()` rather than on `setSignature` because an
   * undo, a project switch and an agent's edit all replace the state without
   * passing through the setter.
   */
  _publishSignature({ force = false } = {}) {
    const regions = this.projectRegions();
    const key = JSON.stringify(regions);
    if (!force && key === this._signatureSent) return;
    const moved = key !== this._signatureSent;
    this._signatureSent = key;
    // The whole map: the engine's metronome, count-in and plugins read the
    // signature at the position they are at (D-061).
    this.hub.engine.setTransport({ meter: regions });
    if (moved) this.hub.events.emit('sequencer:signature', regions);
  }

  setMetronome(enabled) {
    const next = enabled === true;
    if (next !== this.metronomeEnabled) {
      this.metronomeEnabled = next;
      this.hub.settings.set('metronomeEnabled', next);
      this.hub.events.emit('sequencer:metronome', next);
    }
    this._publishMetronome();
    return next;
  }

  /**
   * When the metronome clicks: 'play-rec', whenever the transport runs, or
   * 'rec', during a take and its count-in only.
   *
   * Asked by the author on 2026-09-26: he switched it on to record and off to
   * listen back, every take. The engine keeps one switch; in 'rec' the
   * renderer turns it on for the take and off after it, so the count-in and
   * the clicks stay the engine's, sample-accurate, as they were.
   */
  setMetronomeMode(mode) {
    const next = normalizeMetronomeMode(mode);
    if (next !== this.metronomeMode) {
      this.metronomeMode = next;
      this.hub.settings.set('metronomeMode', next);
      this.hub.events.emit('sequencer:metronome-mode', next);
    }
    this._publishMetronome();
    return next;
  }

  setRecordMode(mode) {
    const next = normalizeRecordMode(mode);
    if (next !== this.recordMode) {
      this.recordMode = next;
      this.hub.settings.set('recordMode', next);
      this.hub.events.emit('sequencer:record-mode', next);
    }
    return next;
  }

  /** Is the engine's click on right now? */
  metronomeHeard() {
    return this.metronomeEnabled && (this.metronomeMode === 'play-rec' || this.recording);
  }

  _publishMetronome() {
    this.hub.engine.setMetronome?.(this.metronomeHeard(), this.metronomeVolume);
  }

  /**
   * What Play plays: everything, the Sequencer's clips alone, or the Audio
   * Players alone. Asked 2026-09-24: listening back to a take also played the
   * files in the Patch Bay. Nothing is stopped, only left out -- a track's
   * input and monitoring, and a player's own buttons, still sound -- and an
   * export prints what Play plays.
   *
   * Changed while the transport runs, it takes effect at once: players left
   * out pause, players brought back start from where they are.
   */
  setPlayScope(scope) {
    const next = PLAY_SCOPES.includes(scope) ? scope : 'all';
    const before = this.playScope;
    if (next !== before) {
      this.playScope = next;
      this.hub.settings.set('playScope', next);
      this.hub.events.emit('sequencer:playScope', next);
    }
    this.hub.engine.setPlayScope?.(next);
    const players = this.hub.audioPlayers;
    if (this.playing && players && (before === 'sequencer') !== (next === 'sequencer')) {
      for (const node of players.list()) {
        const playing = players.statusOf(node.id)?.state === 'playing';
        if (next === 'sequencer' && playing) players.pause(node.id);
        else if (next !== 'sequencer' && !playing && players.fileOf(node.id)) players.play(node.id);
      }
    }
    return next;
  }

  dispose() {
    this.releaseAuditionNotes();
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
    this.releaseAuditionNotes();
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
          : item.type === 'automation' ? this._acceptAutomationRecording(item.message)
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

  /**
   * Adopt an authored state wholesale -- the edit history putting the music
   * back.
   *
   * Goes through `changed()` rather than writing `sequencerState` directly,
   * because that is what republishes the native plan and invalidates the open
   * Clip Editors. A window still showing a clip this state does not have is the
   * failure mode that would otherwise be found by clicking it.
   *
   * The view fields in `state` are the LIVE ones: `EditHistory.forApply` put
   * them there, so an undo does not scroll the timeline out from under you.
   */
  restoreState(state) {
    if (!state || typeof state !== 'object') return false;
    if (this._activeInputNotes.size) this._panicLiveDestinations();
    this.model = new SequencerModel(state);
    this.changed();
    return true;
  }

  changed({ render = true, syncNative = true, invalidateEditors = true } = {}) {
    const snapshot = this.model.snapshot();
    this.hub.settings.set(STATE_KEY, snapshot);
    this._publishSignature();
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

  focusTrack(trackId) {
    const track = this.model.focusTrack(trackId);
    if (!track) return null;
    // What is played goes where it went: focus no longer arms, so neither the
    // live destinations nor the native plan change, and a held note rings on.
    this.changed({ syncNative: false, invalidateEditors: false });
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

  selectAllClips() {
    const count = this.model.selectAllClips();
    // Selection is persisted UI state and no more: never rebuild the native
    // playback plan for it. Same reasoning as `selectClip`.
    if (count) this.changed({ syncNative: false, invalidateEditors: false });
    return count;
  }

  copySelectedClips() {
    const copied = this.model.copyClips();
    if (!copied) return false;
    this._clipClipboard = structuredClone(copied);
    return true;
  }

  /** Whether Paste has anything to paste. The context menu greys its entry on
   *  this rather than offering an action that silently does nothing. */
  hasClipboard() {
    return Boolean(this._clipClipboard?.clips?.length);
  }

  /** Copy, then remove. One gesture, so a failed copy never deletes. */
  cutSelectedClips() {
    if (!this.copySelectedClips()) return 0;
    return this.deleteSelectedClips();
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

  /**
   * The scissor. Cuts every clip in the list that the point actually crosses.
   *
   * The playhead is the default point because it is the one place on the
   * timeline that is already exact -- and because Split is the operation you
   * reach for after listening to where the cut should be.
   */
  splitClips(clipIds = this.model.selectedClipIds(), atPpq = this.playheadPpq) {
    const parts = [];
    for (const id of [...(Array.isArray(clipIds) ? clipIds : [])]) {
      const halves = this.model.splitClip(id, atPpq, { bpm: this.tempo });
      if (halves) parts.push(...halves);
    }
    if (!parts.length) return [];
    // Both halves of every cut end up selected: whatever you were about to do
    // to the clip, you are usually about to do to one of its halves.
    this.model.state.selectedClipIds = [...new Set(parts.map((clip) => clip.id))];
    this.model.state.selectedClipId = this.model.state.selectedClipIds.at(-1) || null;
    this.model.state.selectionAnchorClipId = this.model.state.selectedClipIds[0] || null;
    this.changed();
    return parts;
  }

  quantizeClips(clipIds = this.model.selectedClipIds(), options = {}) {
    let applied = 0;
    for (const id of [...(Array.isArray(clipIds) ? clipIds : [])]) {
      applied += this.model.quantizeMidiClip(id, { scope: 'entire', ...options });
    }
    if (applied) this.changed();
    return applied;
  }

  clipEditorState(clipId) {
    const found = this.model._clip(clipId);
    if (!found) return null;
    return {
      projectId: this.hub.project?.projectId || '',
      snap: this.model.state.snap,
      track: { id: found.track.id, name: found.track.name, type: found.track.type },
      // The track's bars, in arrangement quarters (D-061): the editor snaps
      // and draws its grid in them, where its clip sits in the song.
      meter: this.model.trackRegions(found.track),
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

  /**
   * Sound one note, now, through the clip's own track.
   *
   * The Clip Editor could be edited but not played: clicking a key or a note
   * was silent, which is what makes a piano roll a spreadsheet. This is the
   * one thing it does that is a **performance** and not an edit -- it changes
   * no model state -- so it does not travel as an `update`, and it is not
   * queued behind edits.
   *
   * It goes out through `emitDataTo` exactly as live input does, so invariant
   * 2 still holds: no Patch Bay cable to the track's Destination, no sound,
   * and the renderer does not invent a route to make one.
   *
   * **The note-off is scheduled here, never sent by the editor.** A note-off
   * that rides on a `pointerup` is one that a lost pointer capture, a closed
   * window or a project change can swallow -- and a note left on inside a VST
   * outlives all three.
   */
  auditionNote(clipId, { pitch, velocity = 100, durationMs = 300 } = {}) {
    if (this._disposed || this.hub.project?._transitionPending) return false;
    const found = this.model._clip(clipId);
    if (!found || found.track.type !== 'midi') return false;
    const destination = found.track.outputId;
    if (!destination) return false;
    const note = Number(pitch);
    if (!Number.isFinite(note)) return false;
    const key = Math.round(Math.max(0, Math.min(127, note)));
    const level = Math.round(Math.max(1, Math.min(127, Number(velocity) || 100)));
    const ms = Math.max(10, Math.min(AUDITION_MAX_MS, Number(durationMs) || 300));

    // A second tap on the same key retriggers instead of stacking: the first
    // note's pending off would otherwise land in the middle of the second.
    this._releaseAudition(destination, key);
    if (!this._sendLiveMidi(destination, { sourceId: AUDITION_SOURCE_ID }, [0x90, key, level])) return false;
    const entry = { destination, note: key, timer: null };
    entry.timer = globalThis.setTimeout(() => this._releaseAudition(destination, key), ms);
    this._auditionNotes.push(entry);
    return true;
  }

  /** Send the note-off for one auditioned note, and forget it. */
  _releaseAudition(destination, note) {
    const index = this._auditionNotes.findIndex((entry) => entry.destination === destination && entry.note === note);
    if (index < 0) return false;
    const [entry] = this._auditionNotes.splice(index, 1);
    globalThis.clearTimeout(entry.timer);
    this._sendLiveMidi(destination, { sourceId: AUDITION_SOURCE_ID }, [0x80, note, 0]);
    return true;
  }

  /** Silence every auditioned note. Called before a project leaves, and on
   *  dispose: a scheduled note-off cannot be relied on across either. */
  releaseAuditionNotes() {
    for (const entry of [...this._auditionNotes]) this._releaseAudition(entry.destination, entry.note);
    this._auditionNotes.length = 0;
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
    if (request.kind === 'audition') {
      if (this.hub.project?._transitionPending) return { ok: false, reason: 'project-transition' };
      if (request.expectedProjectId !== (this.hub.project?.projectId || '')) {
        return { ok: false, reason: 'stale-project' };
      }
      if (!this.model._clip(clipId)) return { ok: false, reason: 'clip-not-found' };
      const payload = request.payload && typeof request.payload === 'object' ? request.payload : {};
      // `false` is not an error: it is "this track has no Destination, or no
      // cable behind it". The editor says so rather than pretending to play.
      return { ok: true, sounded: this.auditionNote(clipId, payload) };
    }
    if (request.kind === 'history') {
      // Deliberately not gated on the clip or on the project id: the editor is
      // where the key was pressed, not what is being undone. A stale window
      // asking to step the history is still asking for the same one step.
      const history = this.hub.history;
      if (!history) return { ok: false, reason: 'unsupported-request' };
      if (request.operation !== 'undo' && request.operation !== 'redo') {
        return { ok: false, reason: 'unsupported-request' };
      }
      // The answer says whether there was anything to do, so the window can
      // stay silent rather than flash something that did not happen.
      return Promise.resolve(history[request.operation]())
        .then((moved) => ({ ok: true, moved: moved === true }));
    }
    if (request.kind === 'transport') {
      if (this.hub.project?._transitionPending) return { ok: false, reason: 'project-transition' };
      if (request.expectedProjectId !== (this.hub.project?.projectId || '')) {
        return { ok: false, reason: 'stale-project' };
      }
      if (!this.model._clip(clipId)) return { ok: false, reason: 'clip-not-found' };
      if (request.operation === 'return-start') this.goToStart();
      else if (request.operation === 'seek' && Number.isFinite(request.payload?.ppq)) {
        // A seek ends a take, and a slip of the hand on a ruler must not
        // (the arrangement's own rulers refuse it for the same reason).
        if (this.recording || this.preCounting) return { ok: false, reason: 'recording' };
        this.seek(request.payload.ppq);
      } else if (request.operation === 'play') this.playTransport();
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
    } else if (request.operation === 'move-notes' && found.track.type === 'midi') {
      applied = this.model.moveMidiNotes(clipId, payload.noteIds, payload);
    } else if (request.operation === 'set-notes' && found.track.type === 'midi') {
      applied = this.model.setMidiNotes(clipId, payload.noteIds, payload);
    } else if (request.operation === 'duplicate-notes' && found.track.type === 'midi') {
      applied = this.model.duplicateMidiNotes(clipId, payload.noteIds).length;
    } else if (request.operation === 'replace-notes' && found.track.type === 'midi') {
      const before = found.clip.notes;
      this.model.replaceMidiNotes(clipId, payload.notes);
      applied = found.clip.notes === before ? 0 : 1;
    } else if (request.operation === 'add-notes' && found.track.type === 'midi') {
      applied = Math.max(0, this.model.addMidiNotes(clipId, payload.notes));
    } else if (request.operation === 'set-snap') {
      // Snap belongs to the project, not to a window. Editing it from the
      // Clip Editor moves the arrangement's grid too, which is the point:
      // one Snap with one meaning, reachable from wherever you are working.
      applied = this.model.state.snap === payload.snap ? 0 : 1;
      this.model.state.snap = payload.snap;
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
      const incomingMidi = this.hub.network.connectionsTo('sequencer', 'midi-in')
        .filter((connection) => isCanonicalMidiIngress(this.hub.network, connection));
      const incomingAudio = new Set(this.hub.network.connectionsTo('sequencer', 'audio-in')
        .map((connection) => connection.from.nodeId));
      const routedMidi = new Set(this.hub.network.connectionsFrom('sequencer', 'midi-out').map((connection) => connection.to.nodeId));
      const routedAudio = new Set(this.hub.network.connectionsFrom('sequencer', 'audio-out').map((connection) => connection.to.nodeId));
      const native = {
        ...state,
        // `inputPort` is renderer bookkeeping about which cable the id came
        // from; the engine is handed the resolved id or nothing.
        tracks: state.tracks.map(({ inputPort, soloed, ...track }) => ({
          ...track,
          // Solo reaches the engine as the silence it makes (trackSilenced).
          muted: trackSilenced(state.tracks, { ...track, soloed }),
          inputId: track.type === 'midi'
            ? (incomingMidi.length > 0 && track.inputId === this.hub.midi.selectedInputId ? track.inputId : '')
            : (incomingAudio.has(track.inputId) ? track.inputId : ''),
          outputKind: this.hub.network.getNode(track.outputId)?.type || '',
          outputId: track.type === 'midi'
            ? (routedMidi.has(track.outputId) ? track.outputId : '')
            : (routedAudio.has(track.outputId) ? track.outputId : ''),
          // The instruments the destination's MIDI OUT carries this track on to
          // (D-039). The engine follows the list; the cables are walked here,
          // by the same function live playing uses, so playback, export and the
          // keyboard can never disagree about the series.
          thru: track.type === 'midi' && routedMidi.has(track.outputId)
            ? midiThruReach(this.hub.network, track.outputId).map(({ id, kind }) => ({ id, kind }))
            : []
        }))
      };
      this.hub.engine.syncSequencer(native);
      this.hub.engine.setTransport({ loop: state.loop });
    });
  }

  _liveDestinationIds() {
    if (!this.hub.network.connectionsTo(SEQUENCER_NODE_ID, 'midi-in')
      .some((connection) => isCanonicalMidiIngress(this.hub.network, connection))) return [];
    const selectedInputId = this.hub.midi.selectedInputId;
    const connected = new Set(this.hub.network.connectionsFrom(SEQUENCER_NODE_ID, 'midi-out')
      .map((connection) => connection.to.nodeId));
    return [...new Set(this.model.state.tracks
      .filter((track) => track.type === 'midi'
        && (track.armed || track.monitored)
        && track.inputId === selectedInputId
        && track.outputId && connected.has(track.outputId))
      .map((track) => track.outputId))];
  }

  _sendLiveMidi(destinationId, message, raw) {
    const routed = this.hub.network.emitDataTo?.(SEQUENCER_NODE_ID, 'midi-out', destinationId, {
      ...message, raw: [...raw]
    }) === true;
    if (routed) return true;
    // A disconnect event is emitted after its cable disappears. Held-note
    // cleanup must still reach the old native destination in that narrow
    // window, otherwise the missing cable also removes the only Note Off path.
    const node = this.hub.network.getNode(destinationId);
    if (node?.type === 'vst') this.hub.engine.midi?.(destinationId, raw);
    else if (node?.type === 'arpeggiator' || node?.type === 'one-ring') this.hub.engine.midiNode?.(destinationId, raw);
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

  /** Reconcile the engine's recording flag with the intent this renderer has
   *  already acted on. See RECORD_CONFIRM_GRACE_FRAMES. */
  _acceptEngineRecording(engineRecording) {
    if (!this._recordConfirmPending) return engineRecording;
    if (engineRecording) {
      this._recordConfirmPending = false;
      this._recordConfirmFrames = 0;
      return true;
    }
    this._recordConfirmFrames += 1;
    if (this._recordConfirmFrames > RECORD_CONFIRM_GRACE_FRAMES) {
      // The engine refused the take -- an armed track the native plan did not
      // have yet, for one. Stop claiming to record.
      this._recordConfirmPending = false;
      this._recordConfirmFrames = 0;
      return false;
    }
    return true;
  }

  /** Re-send the notes already under the fingers when Record was pressed.
   *
   *  A player hits the downbeat with the key, not after it, so the Note On that
   *  belongs at the top of the take is typically already down when the take
   *  opens. Its Note Off will arrive normally and close a note of the right
   *  length; without this, the same Note Off closes nothing and the note is
   *  lost outright.
   *
   *  Ordering carries this: `sequencerRecord` and `sequencerMidiInput` share one
   *  channel, so these reach the engine after `beginRecording` has opened the
   *  takes, and land on `std::max(take.startPpq, q)` -- pinned to the start the
   *  user chose. Nothing is announced, and nothing is offered to configure.
   */
  _captureHeldNotes() {
    for (const held of this._activeInputNotes.values()) {
      for (const press of held) {
        if (!Array.isArray(press?.raw) || !press.raw.length) continue;
        this.hub.engine.sequencerMidiInput(press.sourceId || '', press.raw, press.offsetMs || 0);
      }
    }
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
      held.push({
        destinations,
        sourceId: message.sourceId || '',
        raw: [...raw],
        offsetMs: Number(message.offsetMs) || 0
      });
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
    const target = this.hub.network.getNode(track.outputId);
    if (!target) return false;
    if (track.type === 'audio' && !this.canUseAudioOutput(track.outputId)) return false;
    let toPort = track.type === 'midi' ? 'midi-in' : 'audio-in';
    if (track.type === 'audio' && !target.inputs.some((port) => port.id === toPort)) {
      toPort = target.inputs.find((port) => port.type === 'audio')?.id || '';
    }
    if (!toPort) return false;
    const exists = this.hub.network.connectionsFrom('sequencer', fromPort)
      .some((connection) => connection.to.nodeId === track.outputId);
    if (!exists) {
      try { return this.hub.network.connect('sequencer', fromPort, track.outputId, toPort); }
      catch (_) { return false; }
    }
    return true;
  }

  ensureInputRoute(track) {
    if (track?.type !== 'audio' || !track.inputId) return false;
    if (!this.canUseAudioInput(track.inputId)) return false;
    const source = this.hub.network.getNode(track.inputId);
    const target = this.hub.network.getNode(SEQUENCER_NODE_ID);
    if (!source || !target) return false;
    const fromPort = source.outputs.find((port) => port.id === 'audio-out' && port.type === 'audio')
      || source.outputs.find((port) => port.type === 'audio');
    const toPort = target.inputs.find((port) => port.id === 'audio-in' && port.type === 'audio');
    if (!fromPort || !toPort) return false;
    const exists = this.hub.network.connectionsFrom(source.id, fromPort.id)
      .some((connection) => connection.to.nodeId === SEQUENCER_NODE_ID && connection.to.portId === toPort.id);
    if (!exists) return this.hub.network.connect(source.id, fromPort.id, SEQUENCER_NODE_ID, toPort.id);
    return true;
  }

  _audioReachableFrom(startNodeId) {
    const reachable = new Set();
    const pending = [startNodeId];
    while (pending.length) {
      const nodeId = pending.pop();
      for (const connection of this.hub.network.connectionsFrom(nodeId)) {
        const source = this.hub.network.getNode(connection.from.nodeId);
        const target = this.hub.network.getNode(connection.to.nodeId);
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
    const source = this.hub.network.getNode(sourceNodeId);
    const sequencer = this.hub.network.getNode(SEQUENCER_NODE_ID);
    if (!source || !sequencer || source.id === sequencer.id
        || !source.outputs.some((port) => port.type === 'audio')) return false;
    return !this._audioReachableFrom(SEQUENCER_NODE_ID).has(source.id);
  }

  canUseAudioOutput(targetNodeId) {
    const target = this.hub.network.getNode(targetNodeId);
    const sequencer = this.hub.network.getNode(SEQUENCER_NODE_ID);
    if (!target || !sequencer || target.id === sequencer.id
        || !target.inputs.some((port) => port.type === 'audio')) return false;
    return !this._audioReachableFrom(target.id).has(SEQUENCER_NODE_ID);
  }

  _midiInputs() {
    return this.hub.midi?.listInputs?.() ?? [];
  }

  /**
   * Point every MIDI track at the port it was chosen against, not at the id
   * that port happened to carry the day it was chosen.
   *
   * A Web MIDI id is assigned per session: the same MiniLab 3 was `input-2`,
   * then `input-0`, then `input-2` again over three launches on the author's
   * machine (2026-09-07). A track holding the stale id no longer equals
   * `midi.selectedInputId`, so `hasInputRoute` says no and recording is refused
   * with "The armed MIDI track Input must match the MIDI port selected for ...".
   * Re-picking the port in the Input field fixed it until the next launch.
   *
   * `track.inputPort` is the same descriptor `midiInputPreference` has always
   * used for the global selection, and `midi/portIdentity.js` is the single
   * answer to "is this the same physical port" -- two answers to that disagree
   * the day a port is renamed.
   *
   * Returns whether anything moved, so the caller decides about persisting.
   */
  _resolveMidiTrackInputs() {
    const inputs = this._midiInputs();
    let changed = false;
    for (const track of this.model.state.tracks) {
      if (track.type !== 'midi') continue;

      if (!track.inputPort) {
        // A project written before the descriptor existed holds a bare id and
        // nothing else. It is believed exactly once -- while it still resolves
        // -- and the fingerprint is written back on the spot, the way
        // `_inputPreference` already migrates an id-only setting.
        const port = track.inputId ? inputs.find((item) => item.id === track.inputId) : null;
        if (!port) continue;
        this.model.updateTrack(track.id, { inputPort: preferenceForPort(port) });
        changed = true;
        continue;
      }

      const port = resolvePortPreference(track.inputPort, inputs);
      if (!port) {
        // The device is not on this desk. Clearing the id is the point rather
        // than a side effect: a project file travels, and a stale `input-2`
        // over there belongs to whatever that machine enumerated second. The
        // track has to be visibly unrouted instead of quietly armed on a
        // stranger's keyboard -- the same rule D-029 applies to an absent node.
        // The descriptor stays, so the track re-arms itself when the device
        // comes back.
        if (track.inputId) {
          this.model.updateTrack(track.id, { inputId: '' });
          changed = true;
        }
        continue;
      }

      if (track.inputId !== port.id || track.inputPort.id !== port.id) {
        this.model.updateTrack(track.id, { inputId: port.id, inputPort: preferenceForPort(port) });
        changed = true;
      }
    }
    return changed;
  }

  hasInputRoute(track) {
    if (!track?.inputId || !this.hub.network.getNode(SEQUENCER_NODE_ID)) return false;
    if (track.type === 'midi') {
      return track.inputId === this.hub.midi.selectedInputId
        && this.hub.network.connectionsTo(SEQUENCER_NODE_ID, 'midi-in')
          .some((connection) => isCanonicalMidiIngress(this.hub.network, connection));
    }
    return this.hub.network.connectionsTo(SEQUENCER_NODE_ID, 'audio-in')
      .some((connection) => connection.from.nodeId === track.inputId);
  }

  /**
   * What to call the hardware MIDI source in a message the user has to act on.
   *
   * These messages spelled "MiniLab 3", which is the sequencer telling someone
   * with another keyboard to connect one he does not own. The node's own name is
   * what he sees in the Patch Bay, so it is what the message says -- and the
   * header now says the same string, from the same place. The phrase is this
   * caller's own: `controllerName` answers null rather than guessing between two
   * controllers, and "your controller" is what reads as English inside these
   * sentences.
   */
  _midiSourceLabel() {
    return controllerName(this.hub.network) ?? 'your controller';
  }

  /** Human-readable reason why a take cannot start, or an empty string when ready. */
  recordBlockReason() {
    if (this.hub.project?._transitionPending) {
      return 'Cannot start recording while changing project. Wait for the project change to finish.';
    }
    if (!this.hub.network.getNode(SEQUENCER_NODE_ID)) {
      return 'Add the Sequencer node in Patch Bay before recording.';
    }
    if (this.hub.engine.state && this.hub.engine.state !== 'running') {
      return 'The audio engine is not running. Check Audio Output before recording.';
    }
    const tracks = this.model.state.tracks;
    if (!tracks.length) return 'Add at least one MIDI or audio track before recording.';
    const armed = tracks.filter((track) => track.armed);
    if (!armed.length) return 'Arm at least one track with its R button.';
    return this._inputRouteBlockReason(armed);
  }

  /**
   * Why none of `tracks` has a usable input route, or '' as soon as one has.
   *
   * Extracted because two neighbouring questions need the same diagnosis over
   * the same sentences: whether a take can start (the armed tracks) and
   * whether what is played is heard (the armed OR monitored ones). Two copies
   * of these strings drift the day one of them is reworded, and the user then
   * reads two different explanations of a single missing cable.
   *
   * The sentences say "armed" because arming is the gesture that puts a MIDI
   * track live -- its R button does it. A track that is monitored
   * and not armed reads the word as slightly off, and points at the right
   * field anyway.
   */
  _inputRouteBlockReason(tracks) {
    if (tracks.some((track) => this.hasInputRoute(track))) return '';

    const midi = tracks.filter((track) => track.type === 'midi');
    if (midi.length) {
      const source = this._midiSourceLabel();
      if (!this.hub.midi.selectedInputId) {
        return `No MIDI input is detected or selected. Connect ${source}, then choose it in the track Input field.`;
      }
      if (midi.every((track) => !track.inputId)) {
        return 'Choose the detected MIDI port in the armed track Input field.';
      }
      if (!this.hub.network.connectionsTo(SEQUENCER_NODE_ID, 'midi-in')
        .some((connection) => isCanonicalMidiIngress(this.hub.network, connection))) {
        return `Connect ${source}'s MIDI OUT to Sequencer MIDI IN in Patch Bay.`;
      }
      return `The armed MIDI track Input must match the MIDI port selected for ${source}.`;
    }

    if (tracks.every((track) => !track.inputId)) {
      return 'Choose an audio source in the armed track Input field.';
    }
    return 'Connect the selected audio source to Sequencer AUDIO IN in Patch Bay.';
  }

  /**
   * Why what is played into the sequencer reaches nothing, or '' when it does.
   *
   * `recordBlockReason` answers a neighbouring question and stops one
   * condition short of this one: `_liveDestinationIds()` also demands a
   * Destination and the cable that carries it, so a track that is armed and
   * routed on its input side alone passes the record check and still plays
   * into silence. That is the case found in real use on 2026-09-07 -- the
   * transport read "Ready to record the armed and routed tracks" while the
   * keyboard was mute, and nothing on screen said why.
   *
   * It stays silent where `recordBlockReason` already speaks (no Sequencer
   * node, a project transition) and where there is nothing to say (no MIDI
   * track at all): two sentences about one problem is the failure this
   * method exists to fix, not a second copy of it.
   */
  liveBlockReason() {
    if (this.hub.project?._transitionPending) return '';
    if (!this.hub.network.getNode(SEQUENCER_NODE_ID)) return '';
    const midi = this.model.state.tracks.filter((track) => track.type === 'midi');
    if (!midi.length) return '';
    const live = midi.filter((track) => track.armed || track.monitored);
    if (!live.length) {
      return 'No MIDI track is live. Arm one with its R button, or monitor it with I, to hear what you play.';
    }
    if (this._liveDestinationIds().length) return '';
    const inputReason = this._inputRouteBlockReason(live);
    if (inputReason) return inputReason;
    const orphans = live.filter((track) => !track.outputId);
    if (orphans.length === live.length) {
      return orphans.length > 1
        ? 'The live MIDI tracks have no Destination. What you play is routed nowhere.'
        : `“${orphans[0].name}” has no Destination. What you play is routed nowhere.`;
    }
    return 'The live track Destination has no Patch Bay cable. Choose it again, or draw Sequencer MIDI OUT to it.';
  }

  setTrack(trackId, changes) {
    const keys = Object.keys(changes || {});
    if (keys.length > 0 && keys.every((key) => ['volume', 'muted', 'soloed', 'pan'].includes(key))) {
      return this.setTrackControl(trackId, changes);
    }
    const previous = this.model.state.tracks.find((item) => item.id === trackId);
    const previousOutput = previous?.outputId || '';
    const previousInput = previous?.inputId || '';
    // The Input field hands over an id, which is all the DOM has. Storing the
    // port's fingerprint next to it here is what lets `_resolveMidiTrackInputs`
    // find the same hardware again next launch.
    if (previous?.type === 'midi' && 'inputId' in changes && !('inputPort' in changes)) {
      const id = String(changes.inputId || '');
      const port = id ? this._midiInputs().find((item) => item.id === id) : null;
      changes = { ...changes, inputPort: port ? preferenceForPort(port) : null };
    }
    if (this._activeInputNotes.size && ['armed', 'monitored', 'inputId', 'outputId'].some((key) => key in changes)) {
      this._panicLiveDestinations();
    }
    const track = this.model.updateTrack(trackId, changes);
    if (track?.type === 'audio' && 'inputId' in changes) {
      if (previousInput && previousInput !== track.inputId
          && !this.model.state.tracks.some((item) => item.id !== trackId && item.type === 'audio' && item.inputId === previousInput)) {
        for (const connection of this.hub.network.connectionsTo(SEQUENCER_NODE_ID, 'audio-in')
          .filter((item) => item.from.nodeId === previousInput)) {
          this.hub.network.disconnect(connection.from.nodeId, connection.from.portId, SEQUENCER_NODE_ID, 'audio-in');
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
        for (const connection of this.hub.network.connectionsFrom('sequencer', port)
          .filter((item) => item.to.nodeId === previousOutput)) {
          this.hub.network.disconnect('sequencer', port, connection.to.nodeId, connection.to.portId);
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
    // A solo silences or frees every other track: each is told what it now is.
    const told = 'soloed' in (changes || {}) ? this.model.state.tracks : [track];
    for (const item of told) {
      this.hub.engine.setSequencerTrackControl?.(item.id, item.volume, trackSilenced(this.model.state.tracks, item), item.pan);
    }
    if (render) this.hub.events.emit('sequencer:changed', snapshot);
    return track;
  }

  /**
   * Add a track, and publish it.
   *
   * WHY THIS IS A METHOD AND NOT TWO LINES AT THE CALL SITE
   * -------------------------------------------------------
   * It was `model.addTrack(type); controller.changed();` inside two click
   * handlers, which is fine until something other than a click needs a track.
   * The agent channel does (INTENT §8 sexies), and `changed()` is the half a
   * second caller forgets: without it the track exists in the model, the native
   * plan does not know about it, and the open Clip Editors still believe in the
   * arrangement before it.
   */
  addTrack(type = 'midi') {
    // A new MIDI track listens to the keyboard the last one listens to. The
    // author chose his MiniLab again on every track (2026-09-26); with two
    // controllers on the desk, the field is still there to pick the other.
    const previous = type === 'midi'
      ? [...this.model.state.tracks].reverse().find((item) => item.type === 'midi' && item.inputId)
      : null;
    const track = this.model.addTrack(type);
    if (track && previous) {
      this.model.updateTrack(track.id, { inputId: previous.inputId, inputPort: previous.inputPort ?? null });
    }
    if (track) this.changed();
    return track;
  }

  /**
   * Add a MIDI clip to a track, and publish it. Same reasoning as `addTrack`.
   * Without a length it is one of the track's own bars.
   */
  addMidiClip(trackId, startPpq = 0, lengthPpq = null, notes = []) {
    const clip = this.model.addMidiClip(trackId, startPpq, lengthPpq, notes);
    if (clip) this.changed();
    return clip;
  }

  /**
   * A generation a One Ring node wrote (plans/done/one-ring-native.md, part
   * two), written where its writer says.
   *
   * `mode` 'new-track' makes a MIDI track of its own, named `name`, with the
   * generation as its one clip at `startPpq` -- where it was heard; at the
   * playhead when none is given -- and `destination` as its Destination when
   * one is named and can be cabled. `instrument`, a plugin id, gives the track
   * a VST node of that plugin of its own instead, made the way an instrument
   * dropped in the arrangement is (`createInstrument`) -- once the track limit
   * has let the track through, so a refused generation leaves no node behind.
   * A plugin no longer installed leaves the track without one, and says so in
   * `instrument: 'missing'`: the notes are written all the same.
   * 'replace' and 'add' write into the clip
   * `clipId` names, and nowhere else. `notes` are in quarter notes from the
   * generation's start, `lengthPpq` its window.
   *
   * WHY IT IS AN EDIT
   * -----------------
   * What the music wrote becomes authored the way a take does (D-032): one
   * `changed()`, so the project is modified and the history takes one step --
   * with whatever the node wrote in the same turn. Answers where it went, or
   * why it could not: a project changing, the track limit, a clip gone or not
   * MIDI.
   */
  writeGeneration({ mode, name = '', destination = '', instrument = '', clipId = '', startPpq = null, lengthPpq = 4, notes = [] } = {}) {
    if (this.hub.project?._transitionPending || this._projectTransitionState !== 'idle') {
      return { ok: false, reason: 'project-transition', message: 'the project is changing' };
    }
    if (!Array.isArray(notes)) return { ok: false, reason: 'invalid-generation', message: 'a generation is a list of notes' };
    if (mode === 'new-track') {
      if (this.model.state.tracks.length >= SEQUENCER_LIMITS.tracks) {
        return { ok: false, reason: 'track-limit', message: `the Sequencer already has ${SEQUENCER_LIMITS.tracks} tracks` };
      }
      const at = Number.isFinite(startPpq) ? Math.max(0, startPpq) : this.playheadPpq;
      const track = this.model.addTrack('midi', { name, focus: false });
      const clip = this.model.addMidiClip(track.id, at, lengthPpq, notes, { name, snap: false, select: false });
      let routed = false;
      let made = null;
      if (instrument) {
        made = createInstrument(this.hub, instrument);
        destination = made?.nodeId || '';
      }
      if (destination && this.hub.network.getNode(destination)) {
        this.model.updateTrack(track.id, { outputId: destination });
        routed = this.ensureRoute(track);
        if (!routed) this.model.updateTrack(track.id, { outputId: '' });
      }
      this.changed();
      const answer = { ok: true, trackId: track.id, clipId: clip.id, notes: clip.notes.length, routed };
      if (instrument) answer.instrument = made ? made.nodeId : 'missing';
      return answer;
    }
    if (mode !== 'replace' && mode !== 'add') return { ok: false, reason: 'invalid-generation', message: `no write mode ${mode}` };
    if (!clipId) return { ok: false, reason: 'no-clip', message: 'the writer names no clip' };
    const found = this.model._clip(clipId);
    if (!found) return { ok: false, reason: 'clip-not-found', message: 'the clip the writer names is gone' };
    if (found.track.type !== 'midi') return { ok: false, reason: 'clip-type-mismatch', message: 'the clip the writer names is not MIDI' };
    const before = found.clip.notes;
    const written = mode === 'replace' ? this.model.replaceMidiNotes(clipId, notes) : this.model.addMidiNotes(clipId, notes);
    const changed = mode === 'replace' ? found.clip.notes !== before : written > 0;
    if (changed) this.changed();
    return { ok: true, trackId: found.track.id, clipId, notes: written, changed };
  }

  removeTrack(trackId) {
    const track = this.model.state.tracks.find((item) => item.id === trackId);
    if (track && this._activeInputNotes.size) this._panicLiveDestinations();
    if (!track || !this.model.removeTrack(trackId)) return false;
    if (track.type === 'audio' && track.inputId
        && !this.model.state.tracks.some((item) => item.type === 'audio' && item.inputId === track.inputId)) {
      for (const connection of this.hub.network.connectionsTo(SEQUENCER_NODE_ID, 'audio-in')
        .filter((item) => item.from.nodeId === track.inputId)) {
        this.hub.network.disconnect(connection.from.nodeId, connection.from.portId, SEQUENCER_NODE_ID, 'audio-in');
      }
    }
    const port = track.type === 'midi' ? 'midi-out' : 'audio-out';
    if (track.outputId && !this.model.state.tracks.some((item) => item.type === track.type && item.outputId === track.outputId)) {
      for (const connection of this.hub.network.connectionsFrom('sequencer', port)
        .filter((item) => item.to.nodeId === track.outputId)) {
        this.hub.network.disconnect('sequencer', port, connection.to.nodeId, connection.to.portId);
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
    this._takeRecordMode = this.recordMode;
    this.recording = true;
    this.playing = true;
    this._recordConfirmPending = true;
    this._recordConfirmFrames = 0;
    // Before the record command: the engine decides on the count-in when the
    // take starts, from the switch it holds at that moment.
    if (this.metronomeMode === 'rec') this._publishMetronome();
    this.hub.engine.sequencerRecord(true);
    this._captureHeldNotes();
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
    this._recordConfirmPending = false;
    this._recordConfirmFrames = 0;
    const command = this.hub.engine.sequencerRecord(false);
    if (this.metronomeMode === 'rec') this._publishMetronome();
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

  /**
   * A Stop somebody gives -- a button, the clip editor, an agent -- also stops
   * the One Ring nodes. `bySequence` is the Stop a sequence sends over a cable
   * (sequencerCommands.js): One Ring plays on after it, since stopping the
   * arrangement is one of the things its sequences are written to do.
   */
  stopTransport({ bySequence = false } = {}) {
    return this._halt(bySequence !== true);
  }

  /**
   * Pause: hold the arrangement where it is, and leave a One Ring running.
   *
   * There is no rewind to undo, whatever stops the transport --
   * `Transport::setPlaying(false)` does not touch `ppq_` -- so Play afterwards
   * always resumes from here, and that is NOT what separates a pause from a
   * stop. The One Rings are: a stop stops them, and a pause is about the
   * arrangement and leaves a generator that runs on its own clock alone. It is
   * the behaviour a Stop over a cable already asked for, given its own name so
   * that a button can mean it.
   */
  pauseTransport() {
    return this._halt(false);
  }

  /** Stop playing. `stopOneRings` is the whole difference between the two. */
  _halt(stopOneRings) {
    this.stopRecording();
    if (this.playing) {
      this.playing = false;
      this.hub.events.emit('sequencer:transport', { playing: false });
    }
    this.hub.engine.setTransport({ playing: false, stopOneRings: stopOneRings === true });
    this._queueEditorTransport();
    return true;
  }

  /**
   * Move the playhead by whole bars, backwards or forwards.
   *
   * A seek and not a scrub: it moves while stopped and while playing, and the
   * engine releases the notes it was holding either way (`releaseAllMidi` on a
   * seek), so stepping through an arrangement cannot leave a note hanging.
   */
  nudgeBars(bars) {
    return this.seek(barStep(this.playheadPpq, bars, this.projectRegions()));
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

  /**
   * What an export covers, in quarters: the loop, or the whole of what Play
   * plays (D-056).
   *
   * The whole used to be the arrangement's last clip. An export renders the
   * Audio Output, which the Audio Players reach without the Sequencer, so a
   * file processed in the Patch Bay alone came out one bar long. It is now the
   * later of the arrangement's end and the longest player's file, each counted
   * only when Play plays it; one bar when neither holds anything.
   */
  exportSpan(range = 'full') {
    const loop = this.model.state.loop;
    if (range === 'loop') return { startPpq: loop.startPpq, endPpq: loop.endPpq, source: 'loop' };
    const arrangementEnd = this.playScope === 'players' ? 0 : this.model.arrangementEndPpq();
    const playerSeconds = this.playScope === 'sequencer' ? 0 : (this.hub.audioPlayers?.longestHeardSeconds?.() || 0);
    const playersEnd = playerSeconds * this.tempo / 60;
    if (arrangementEnd <= 0 && playersEnd <= 0) return { startPpq: 0, endPpq: meterBarAt(this.projectRegions(), 0).lengthPpq, source: 'empty' };
    return playersEnd > arrangementEnd
      ? { startPpq: 0, endPpq: playersEnd, source: 'players' }
      : { startPpq: 0, endPpq: arrangementEnd, source: 'arrangement' };
  }

  async exportMaster(range = 'full', options = {}) {
    if (this.exporting) return false;
    const format = ['wav', 'mp3', 'ogg'].includes(String(options.format).toLowerCase())
      ? String(options.format).toLowerCase() : 'wav';
    // Named by the caller, or chosen in the picker. The agent channel takes the
    // first branch for the reason `ProjectManager._save` does: a modal opened by
    // a request is a modal nobody was asked to answer.
    const filePath = options.filePath
      || await this.hub.api.audioPickSave(`${this.hub.project.currentProjectName} Mix`, format);
    if (!filePath) return false;
    const { startPpq, endPpq } = this.exportSpan(range);
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
    const events = Array.isArray(message?.events) ? message.events : [];
    const controls = Array.isArray(message?.controls) ? message.controls : [];
    if (!track || (!events.length && !controls.length)) return;
    const startPpq = Math.max(0, Number(message.startPpq) || 0);
    const endPpq = Math.max(startPpq + 0.125, Number(message.endPpq) || startPpq + 4);
    // Into the clips already there (D-063), in the mode the take began in,
    // with the wheels, knobs and pedal moved during it (D-064).
    this.model.recordMidiTake(track.id, { startPpq, endPpq, events, controls }, { mode: this._takeRecordMode });
    this.changed();
  }

  /**
   * A plugin parameter a bound knob moved during the take, for the track the
   * engine gave it to (D-065). Named from the knob's binding, which knows the
   * parameter's words; the plugin's own name otherwise.
   */
  _acceptAutomationRecording(message) {
    if (this._deferForProjectTransition('automation', message)) return;
    const track = this.model.state.tracks.find((item) => item.id === message?.trackId);
    if (!track || !Array.isArray(message.points) || !message.points.length) return;
    const nodeId = String(message.nodeId || '');
    const binding = (this.hub.nodes?.getControlBindings?.(nodeId) || []).find((item) =>
      item.pluginInstanceId === message.pluginInstanceId && item.parameterId === message.parameterId);
    const plugin = this.hub.nodes?.get?.(nodeId)?.content?.plugins?.find?.((item) => item.id === message.pluginInstanceId);
    const lane = this.model.recordAutomationTake(track.id, message, {
      mode: this._takeRecordMode,
      name: binding?.parameterName || '',
      pluginName: binding?.pluginName || plugin?.name || ''
    });
    if (lane) this.changed();
  }

  /** A track's selected height (D-068): the view's, so no undo step, no engine. */
  setTrackHeight(trackId, height) {
    const next = this.model.setTrackHeight(trackId, height);
    if (next !== null) this.changed({ syncNative: false, invalidateEditors: false });
    return next;
  }

  /** Make clips active or inactive (D-067): one undo step, republished. */
  setClipsMuted(clipIds, muted) {
    if (!this.model.setClipsMuted(clipIds, muted)) return false;
    this.changed();
    return true;
  }

  /** Take one parameter's automation off a track. */
  removeAutomationLane(trackId, laneId) {
    if (!this.model.removeAutomationLane(trackId, laneId)) return false;
    this.changed();
    return true;
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
    const take = this.model.addAudioClip(track.id, {
      name: `${track.name} Take`, filePath,
      startPpq: Math.max(0, Number(message.startPpq) || 0),
      durationSeconds, trimStartSeconds: 0, trimEndSeconds: durationSeconds,
      lengthPpq: Math.max(0.125, durationSeconds * bpm / 60), gain: 1
    });
    // Overdub lays the take over what is there, and both sound; Replace cuts
    // out what it covers (D-063).
    if (take && this._takeRecordMode === 'replace') {
      this.model.clearAudioRange(track.id, take.startPpq, take.startPpq + take.lengthPpq, { bpm: this.tempo, keep: take.id });
    }
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
