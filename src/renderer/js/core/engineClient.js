/**
 * Renderer-side client for the native audio engine.
 *
 * Talks to the engine through the main process (preload `hubAPI`). Holds the
 * engine lifecycle state, the real audio device list, and the real VST3 plugin
 * registry, and emits typed events on the Hub bus. Audio samples never cross
 * this boundary — only CONTROL and MIDI messages.
 */

const PROTOCOL_VERSION = 1;
const PARAMETER_REQUEST_TIMEOUT_MS = 15000;
const SEQUENCER_QUIESCE_TIMEOUT_MS = 5000;

export class EngineClient {
  constructor(api, events, settings) {
    this.api = api;
    this.events = events;
    this.settings = settings;
    this.state = 'stopped'; // stopped | starting | running | error
    this.error = null;
    this.devices = []; // real WASAPI output devices from the engine
    this.audioInputs = [];
    this.midiOutputs = [];
    this.midiOutputState = null;
    this.plugins = []; // real VST3 registry
    this._userScanPending = false; // next plugins event answers a user rescan
    this.scanning = false; // a VST3 scan is running in the engine right now
    this.deviceState = null; // last known { running, device, sampleRate, bufferSize, error }
    this.masterMeter = null; // throttled post-gain meter + Audio Output boundary telemetry
    this.exportCapabilities = {
      wavBitDepths: [16, 24, 32], mp3BitratesKbps: [128, 192, 256, 320],
      oggQualityOptions: [], mp3Available: false, mp3Encoder: ''
    };
    // Runtime chain state as the ENGINE sees it: chainId -> Map(instanceId -> status).
    // A module opened later must be able to ask what is actually loaded rather
    // than infer it from events it happened to witness.
    this.chains = new Map();
    this._registry = new Map(); // pluginId -> record
    this._unsubs = [];
    this._ready = null;
    this._refreshed = false;
    this._requestSeq = 0;
    this._engineGeneration = 0;
    this._stateEventSeq = 0;
    this._parameterRequestTimeoutMs = Number.isFinite(api.parameterRequestTimeoutMs)
      ? Math.max(1, api.parameterRequestTimeoutMs)
      : PARAMETER_REQUEST_TIMEOUT_MS;
    this._requestNonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    // Pending requests are keyed ONLY by their opaque requestId. Chain/plugin
    // identity is response validation metadata, never correlation identity.
    this._pendingParams = new Map();
    this._pendingQuiesce = null;
    // Native generations distinguish successive runtime objects that happen to
    // use the same persistent instanceId. This is defense in depth: native also
    // drops queued touches from an object after it has been replaced.
    this._instanceGenerations = new Map(); // chainId -> Map(instanceId -> generation)
    this._editorStatuses = new Map(); // chainId -> Map(instanceId -> last native editorStatus)
    this._instanceErrors = new Map();
    // Master export owns cloned processors and immutable graph/arrangement
    // plans. Live edits therefore remain immediate. Only an audio-device
    // restart is deferred because it would remove the callback driving both
    // contexts before the private writer reaches its terminal block.
    this._exportTransactionActive = false;
    this._deferredExportCommands = [];
    this.diag = (line) => { try { api.diagnosticsLog(line); } catch (e) {} };
  }

  /**
   * Subscribe to the main process and pick up the current engine state.
   *
   * Idempotent: calling it twice used to register a second pair of listeners
   * and double every engine event. Returns a promise that resolves once the
   * initial state query has landed, so callers can await a known state.
   */
  init() {
    if (this._ready) return this._ready;
    this.diag('renderer: engineClient.init');
    this._unsubs.push(
      this.api.onEngineState((s) => this._onState(s)),
      this.api.onEngineEvent((msg) => this._onEvent(msg))
    );
    const stateEventSeq = this._stateEventSeq;
    this._ready = this.api.engineState().then((s) => {
      // Do not let an IPC query issued during startup overwrite a newer
      // running/error event that arrived while its response was in flight.
      if (s && this._stateEventSeq === stateEventSeq) {
        this.state = s.state;
        this.error = s.error;
      }
      // A renderer that starts (or reloads) after the engine is already up
      // never sees a `running` transition, so ask here rather than relying on
      // having witnessed a past event.
      if (this.state === 'running') this.refresh();
      return this.state;
    });
    return this._ready;
  }

  _onState(s) {
    this._stateEventSeq += 1;
    const previousState = this.state;
    this.state = s.state;
    this.error = s.error;
    this.diag(`renderer: engine:state ${s.state}`);
    if (this.state === 'running') {
      this.refresh();
    } else {
      if (previousState === 'running' || this._pendingParams.size > 0) {
        this._engineGeneration += 1;
        this._rejectPendingParams(`engine-${this.state}`);
      }
      this._settleQuiesce(new Error(`engine-${this.state}`));
      this._invalidate();
    }
    this.events.emit('engine:state', s);
  }

  /**
   * Pull everything the renderer needs to describe the engine. Runs once per
   * engine run: modules read the cached values instead of each issuing their
   * own listDevices/getDeviceState when they happen to be opened.
   */
  refresh() {
    if (this._refreshed) return;
    this._refreshed = true;
    // The native process may have survived a renderer reload, so its startup
    // hello was sent before this WebContents subscribed. Re-request it to
    // recover codec/export capabilities (notably bundled MP3 availability).
    this.command({ type: 'hello' });
    this.listDevices();
    this.getDeviceState();
    const cachedCatalog = this.settings.get('vstCatalog') || [];
    this._setPlugins(cachedCatalog);
    this.events.emit('engine:plugins', this.plugins);
    if (cachedCatalog.length === 0 || this._engineGeneration > 0) this.scanVst3();
  }

  /**
   * Runtime status of one plugin instance as the engine last reported it:
   * 'loading' | 'ready' | 'error', or null when the engine has never mentioned
   * it (which is NOT the same as ready).
   */
  getInstanceStatus(chainId, instanceId) {
    const chain = this.chains.get(chainId);
    return (chain && chain.get(instanceId)) || null;
  }

  getInstanceError(chainId, instanceId) {
    return this._instanceErrors.get(chainId)?.get(instanceId) || null;
  }

  /** Opaque native lifetime generation for one currently loaded instance. */
  getInstanceGeneration(chainId, instanceId) {
    return this._instanceGenerations.get(chainId)?.get(instanceId) ?? null;
  }

  /** Monotonic token for the current native-engine run (renderer-local). */
  get runtimeGeneration() {
    return this._engineGeneration;
  }

  getEditorStatus(chainId, instanceId) {
    return this._editorStatuses.get(chainId)?.get(instanceId) || null;
  }

  /** Exact, currently-visible editor records for one chain. */
  getOpenEditors(chainId) {
    return [...(this._editorStatuses.get(chainId)?.values() || [])]
      .filter((status) => status.open === true);
  }

  /** The engine went away: everything cached about it is now meaningless. */
  _invalidate() {
    this._finishExportTransaction(true);
    this._refreshed = false;
    this.devices = [];
    this.audioInputs = [];
    this.midiOutputs = [];
    this.midiOutputState = null;
    this.deviceState = null;
    this.masterMeter = null;
    this.chains.clear(); // a dead engine holds no instances
    this._instanceGenerations.clear();
    this._editorStatuses.clear();
    this._instanceErrors.clear();
    this._setPlugins([]);
    this._setScanning(false);
    this.events.emit('engine:devices', this.devices);
    this.events.emit('engine:plugins', this.plugins);
  }

  /** Drop every main-process subscription (teardown / tests). */
  dispose() {
    this._engineGeneration += 1;
    this._rejectPendingParams('client-disposed');
    this._settleQuiesce(new Error('client-disposed'));
    this._unsubs.forEach((off) => { if (typeof off === 'function') off(); });
    this._unsubs = [];
    this._ready = null;
    this._refreshed = false;
  }

  _onEvent(msg) {
    console.log(`[engineClient:event] ${msg.type}${msg.count !== undefined ? ' count=' + msg.count : ''}`);
    switch (msg.type) {
      case 'hello':
        if (msg.sequencerExportCapabilities && typeof msg.sequencerExportCapabilities === 'object') {
          this.exportCapabilities = { ...this.exportCapabilities, ...msg.sequencerExportCapabilities };
          this.events.emit('engine:sequencerExportCapabilities', this.exportCapabilities);
        }
        this.events.emit('engine:hello', msg);
        break;
      case 'devices':
        this.devices = msg.outputs || [];
        this.audioInputs = msg.inputs || [];
        this.midiOutputs = msg.midiOutputs || [];
        this.diag(`renderer: devices event received count=${this.devices.length}`);
        this.events.emit('engine:devices', this.devices);
        break;
      case 'midiOutputState':
        this.midiOutputState = msg;
        this.events.emit('engine:midiOutputState', msg);
        break;
      case 'deviceState':
        this.deviceState = msg;
        this.events.emit('engine:deviceState', msg);
        break;
      case 'masterMeter':
        this.masterMeter = msg;
        this.events.emit('engine:masterMeter', msg);
        break;
      case 'plugins': {
        this.diag(`startup:vst-catalog-event rendererMs=${Math.round(performance.now())}`);
        const incoming = msg.plugins || [];
        const userScan = this._userScanPending;
        this._userScanPending = false;
        this._setScanning(false);
        if (this._acceptsCatalog(incoming, userScan)) {
          this._setPlugins(incoming);
          this.settings.set('vstCatalog', incoming);
        } else if (incoming.length > 0) {
          this.diag(`renderer: kept catalog of ${this.plugins.length}, ignored automatic scan of ${incoming.length}`);
        }
        this.diag(`renderer: plugins event received count=${this.plugins.length}`);
        this.events.emit('engine:plugins', this.plugins);
        break;
      }
      case 'presetApplied':
        this.events.emit('engine:presetApplied', msg);
        break;
      case 'chainChanged': {
        const statuses = new Map();
        const generations = new Map();
        for (const inst of msg.instances || []) {
          statuses.set(inst.instanceId, inst.status);
          if (Number.isSafeInteger(inst.generation)) generations.set(inst.instanceId, inst.generation);
        }
        this.chains.set(msg.chainId, statuses);
        this._instanceGenerations.set(msg.chainId, generations);
        const editors = this._editorStatuses.get(msg.chainId);
        if (editors) {
          for (const [instanceId, editor] of editors) {
            if (!generations.has(instanceId) || generations.get(instanceId) !== editor.generation) {
              editors.delete(instanceId);
            }
          }
          if (editors.size === 0) this._editorStatuses.delete(msg.chainId);
        }
        this.events.emit('engine:chainChanged', msg);
        break;
      }
      case 'instanceStatus': {
        if (!this.chains.has(msg.chainId)) this.chains.set(msg.chainId, new Map());
        this.chains.get(msg.chainId).set(msg.instanceId, msg.status);
        if (!this._instanceErrors.has(msg.chainId)) this._instanceErrors.set(msg.chainId, new Map());
        if (msg.status === 'error') this._instanceErrors.get(msg.chainId).set(msg.instanceId, msg.error || 'Plugin failed to load');
        else this._instanceErrors.get(msg.chainId).delete(msg.instanceId);
        if (Number.isSafeInteger(msg.generation)) {
          if (!this._instanceGenerations.has(msg.chainId)) {
            this._instanceGenerations.set(msg.chainId, new Map());
          }
          this._instanceGenerations.get(msg.chainId).set(msg.instanceId, msg.generation);
          const editor = this._editorStatuses.get(msg.chainId)?.get(msg.instanceId);
          if (editor && editor.generation !== msg.generation) {
            this._editorStatuses.get(msg.chainId).delete(msg.instanceId);
          }
        }
        this.events.emit('engine:instanceStatus', msg);
        break;
      }
      case 'editorStatus': {
        if (!this._editorStatuses.has(msg.chainId)) this._editorStatuses.set(msg.chainId, new Map());
        const editors = this._editorStatuses.get(msg.chainId);
        const knownGeneration = this.getInstanceGeneration(msg.chainId, msg.instanceId);
        if (msg.open === true && Number.isSafeInteger(msg.generation)
            && msg.generation === knownGeneration) {
          editors.set(msg.instanceId, { ...msg });
        } else if (msg.open !== true) {
          editors.delete(msg.instanceId);
        }
        this.events.emit('engine:editorStatus', msg);
        break;
      }
      case 'vstParameterLearnState': {
        const knownGeneration = this.getInstanceGeneration(msg.chainId, msg.instanceId);
        if (msg.armed === true
            && (this.getInstanceStatus(msg.chainId, msg.instanceId) !== 'ready'
              || !Number.isSafeInteger(knownGeneration)
              || msg.generation !== knownGeneration)) break;
        this.events.emit('engine:vstParameterLearnState', msg);
        break;
      }
      case 'vstParameters': {
        this.events.emit('engine:vstParameters', msg);
        const pending = this._pendingParams.get(msg.requestId);
        if (!pending) break; // stale/unknown response, including old generations
        if (pending.generation !== this._engineGeneration
            || msg.chainId !== pending.chainId
            || msg.instanceId !== pending.instanceId) break;
        this._pendingParams.delete(msg.requestId);
        clearTimeout(pending.timer);
        pending.resolve(msg);
        break;
      }
      case 'vstParameterTouched': {
        const statuses = this.chains.get(msg.chainId);
        if (!statuses || statuses.get(msg.instanceId) !== 'ready') break;
        const knownGeneration = this._instanceGenerations.get(msg.chainId)?.get(msg.instanceId);
        if (!Number.isSafeInteger(knownGeneration) || msg.generation !== knownGeneration) break;
        this.events.emit('engine:vstParameterTouched', msg);
        break;
      }
      case 'pluginState': {
        const knownGeneration=this.getInstanceGeneration(msg.chainId,msg.instanceId);
        if(Number.isSafeInteger(knownGeneration)&&msg.generation===knownGeneration)
          this.events.emit('engine:pluginState',msg);
        break;
      }
      case 'status':
        // `scanning` is the only progress signal a VST3 scan produces: it runs
        // for a minute or more on a worker thread and reports nothing until it
        // is done. Without it the UI looked frozen and the button looked dead.
        if (typeof msg.scanning === 'boolean') this._setScanning(msg.scanning);
        this.events.emit('engine:status', msg);
        break;
      case 'transport':
        this.events.emit('engine:transport', msg);
        break;
      case 'metronomeTick':
        this.events.emit('engine:metronomeTick', msg);
        break;
      case 'sequencerMidiRecorded':
        this.events.emit('engine:sequencerMidiRecorded', msg);
        break;
      case 'sequencerAudioRecorded':
        this.events.emit('engine:sequencerAudioRecorded', msg);
        break;
      case 'sequencerAudioInfo':
        this.events.emit('engine:sequencerAudioInfo', msg);
        break;
      case 'sequencerExport':
        if (['preparing', 'started', 'progress', 'finalizing'].includes(msg.state)) {
          this._exportTransactionActive = true;
        } else this._finishExportTransaction(false);
        this.events.emit('engine:sequencerExport', msg);
        break;
      case 'sequencerQuiesced':
        this._finishExportTransaction(true);
        if (this._pendingQuiesce?.requestId === msg.requestId) this._settleQuiesce(null, msg);
        this.events.emit('engine:sequencerQuiesced', msg);
        break;
      case 'hostTiming':
        this.events.emit('engine:hostTiming',msg);
        break;
      case 'audioPathTelemetry':
        this.events.emit('engine:audioPathTelemetry',msg);
        break;
      case 'audioRuntimeTelemetry':
        this.events.emit('engine:audioRuntimeTelemetry',msg);
        break;
      case 'error':
        this.events.emit('engine:error', msg);
        break;
      default:
        break;
    }
  }

  _setPlugins(plugins) {
    this.plugins = plugins;
    this._registry.clear();
    for (const p of plugins) this._registry.set(p.pluginId, p);
  }

  getPlugin(pluginId) {
    return this._registry.get(pluginId) || null;
  }

  // ---- commands (all go through the main process to the engine) ----

  command(msg) {
    // MIDI and CONTROL can arrive at hardware rate. Logging every value would
    // turn normal knob movement into unbounded renderer/main-process work.
    if (msg.type !== 'midi' && msg.type !== 'sequencerMidiInput' && msg.type !== 'setVstParameter') {
      console.log(`[engineClient:command] ${msg.type}`);
    }
    return this.api.engineCommand({ v: PROTOCOL_VERSION, ...msg });
  }

  _renderCommand(msg) {
    if (!this._exportTransactionActive || msg.type !== 'selectDevice') return this.command(msg);
    this._deferredExportCommands.push(msg);
    return Promise.resolve({ ok: true, deferredDuringExport: true });
  }

  _liveInputCommand(msg) {
    // The export owns cloned processors and its own clock. Live Note Offs must
    // therefore continue to the live graph immediately; dropping them here
    // was the direct cause of notes held after a bounce. These messages are
    // never replayed or copied into the offline render.
    return this.command(msg);
  }

  _finishExportTransaction(discard) {
    const deferred = discard ? [] : this._deferredExportCommands.splice(0);
    this._deferredExportCommands.length = 0;
    this._exportTransactionActive = false;
    for (const command of deferred) {
      Promise.resolve(this.command(command)).catch((error) => {
        this.events.emit('engine:error', {
          type: 'error', code: 'export-deferred-command',
          message: error?.message || String(error)
        });
      });
    }
  }

  _nextRequestId(kind) {
    this._requestSeq += 1;
    return `${kind}-${this._requestNonce}-${this._engineGeneration}-${this._requestSeq}`;
  }

  _rejectPendingParams(reason) {
    for (const [requestId, pending] of this._pendingParams) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`${reason}: ${requestId}`));
    }
    this._pendingParams.clear();
  }

  listDevices() {
    return this.command({ type: 'listDevices' });
  }

  selectDevice(device, sampleRate, bufferSize) {
    return this._renderCommand({ type: 'selectDevice', device, sampleRate, bufferSize });
  }

  selectMidiOutput(device) {
    return this._renderCommand({ type: 'selectMidiOutput', identifier: device?.identifier || '', name: device?.name || '' });
  }

  getDeviceState() {
    return this.command({ type: 'getDeviceState' });
  }

  /**
   * `userInitiated` marks a scan the user explicitly asked for, which is the
   * only kind allowed to shrink the catalog (see `_acceptsCatalog`).
   */
  scanVst3(userInitiated = false) {
    if (this.scanning) return Promise.resolve({ ok: false, reason: 'scan-busy' });
    if (userInitiated) this._userScanPending = true;
    // Optimistic: the button must react to the click, not to the round trip.
    this._setScanning(true);
    const rollback = () => {
      this._userScanPending = false;
      this._setScanning(false);
    };
    let request;
    try {
      request = this.command({ type: 'scanVst3' });
    } catch (error) {
      rollback();
      throw error;
    }
    return Promise.resolve(request).then((result) => {
      if (result?.ok === false) rollback();
      return result;
    }, (error) => {
      rollback();
      throw error;
    });
  }

  _setScanning(scanning) {
    if (this.scanning === scanning) return;
    this.scanning = scanning;
    this.events.emit('engine:scanning', scanning);
  }

  /**
   * A catalog never shrinks by itself.
   *
   * An interrupted or degraded scan reports a handful of plugins - or one -
   * and the old code cached that as the whole catalog. It happened: a 48-plugin
   * catalog was overwritten by a 1-plugin scan result, and since a non-empty
   * cache suppresses the automatic rescan, the list stayed at one plugin
   * across every later launch. Automatic results may only grow the catalog;
   * removals go through an explicit rescan, which always wins.
   */
  _acceptsCatalog(incoming, userInitiated) {
    if (incoming.length === 0) return false; // an empty scan proves nothing
    return userInitiated || incoming.length >= this.plugins.length;
  }

  createInstance(chainId, pluginId, instanceId, index) {
    return this.createInstanceTracked(chainId, pluginId, instanceId, index).accepted;
  }

  /** Start a native plugin creation and expose its opaque operation identity. */
  createInstanceTracked(chainId, pluginId, instanceId, index) {
    const requestId = this._nextRequestId('create');
    return {
      requestId,
      accepted: this._renderCommand({ type: 'createInstance', requestId, chainId, pluginId, instanceId, index })
    };
  }

  removeInstance(chainId, instanceId) {
    return this._renderCommand({ type: 'removeInstance', chainId, instanceId });
  }

  reorderChain(chainId, instanceId, toIndex) {
    return this._renderCommand({ type: 'reorderChain', chainId, instanceId, toIndex });
  }

  setBypass(chainId, instanceId, bypassed) {
    return this._renderCommand({ type: 'setBypass', chainId, instanceId, bypassed });
  }

  midi(chainId, data) {
    return this._liveInputCommand({ type: 'midi', chainId, data });
  }

  midiNode(nodeId, data) { return this._liveInputCommand({ type: 'midiNode', nodeId, data }); }
  syncMidiGraph(nodes) { return this._renderCommand({ type: 'syncMidiGraph', nodes }); }

  setChainMidiEnabled(chainId, enabled) {
    return this._renderCommand({ type: 'setChainMidiEnabled', chainId, enabled });
  }

  setChainOutputEnabled(chainId, enabled) {
    return this._renderCommand({ type: 'setChainOutputEnabled', chainId, enabled });
  }

  setTransport({ bpm, playing, seekPpq, loop } = {}) {
    const command = { type: 'setTransport' };
    if (Number.isFinite(bpm)) command.bpm = Math.max(20, Math.min(300, bpm));
    if (typeof playing === 'boolean') command.playing = playing;
    if (Number.isFinite(seekPpq)) command.seekPpq = Math.max(0, seekPpq);
    if (loop && typeof loop === 'object') command.loop = {
      enabled: loop.enabled === true,
      startPpq: Math.max(0, Number(loop.startPpq) || 0),
      endPpq: Math.max(0.125, Number(loop.endPpq) || 16)
    };
    // The native bounce owns a different Transport. Live Play/Stop/seek/loop
    // therefore remain immediate and are never replayed after an export.
    return this.command(command);
  }

  getTransport() { return this.command({ type: 'getTransport' }); }
  syncAudioGraph(nodes) { return this._renderCommand({ type: 'syncAudioGraph', nodes }); }
  /** Values-only update of the published plan: levels, mutes, master level and
   *  Morpher steps. Deliberately not a syncAudioGraph, which recompiles the
   *  graph and rebuilds every PDC delay line. */
  setAudioNodeValues(nodes) { return this._renderCommand({ type: 'setAudioNodeValues', nodes }); }
  syncSequencer(project) { return this._renderCommand({ type: 'syncSequencer', project }); }
  setSequencerTrackControl(trackId, gain, muted) {
    return this.command({
      type: 'setSequencerTrackControl', trackId,
      gain: Math.max(0, Math.min(2, Number(gain) || 0)), muted: muted === true
    });
  }
  sequencerMidiInput(sourceId, data, offsetMs = 0) { return this._liveInputCommand({ type: 'sequencerMidiInput', sourceId, data, offsetMs }); }
  sequencerRecord(enabled) { return this._liveInputCommand({ type: 'sequencerRecord', enabled }); }
  sequencerExport(options) {
    if (!this._exportTransactionActive) this._exportTransactionActive = true;
    try {
      return Promise.resolve(this.command({ type: 'sequencerExport', ...options })).catch((error) => {
        this._finishExportTransaction(false);
        throw error;
      });
    } catch (error) {
      this._finishExportTransaction(false);
      throw error;
    }
  }
  sequencerCancelExport() { return this.command({ type: 'sequencerCancelExport' }); }
  sequencerQuiesce() {
    this._finishExportTransaction(true);
    if (this._pendingQuiesce) return this._pendingQuiesce.promise;
    const requestId = `quiesce-${this._requestNonce}-${++this._requestSeq}`;
    let resolve;
    let reject;
    const acknowledgement = new Promise((res, rej) => { resolve = res; reject = rej; });
    const timer = globalThis.setTimeout(() => {
      if (this._pendingQuiesce?.requestId === requestId) this._settleQuiesce(new Error('sequencer-quiesce-timeout'));
    }, SEQUENCER_QUIESCE_TIMEOUT_MS);
    this._pendingQuiesce = { requestId, resolve, reject, timer, promise: acknowledgement };
    Promise.resolve(this.command({ type: 'sequencerQuiesce', requestId })).then((accepted) => {
      if (accepted?.ok === false && this._pendingQuiesce?.requestId === requestId) {
        this._settleQuiesce(new Error(accepted.reason || 'sequencer-quiesce-rejected'));
      }
    }).catch((error) => {
      if (this._pendingQuiesce?.requestId === requestId) this._settleQuiesce(error);
    });
    return acknowledgement;
  }

  _settleQuiesce(error, message = null) {
    const pending = this._pendingQuiesce;
    if (!pending) return;
    this._pendingQuiesce = null;
    globalThis.clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve(message);
  }
  // Hardware safety stays immediate during an offline bounce. The native
  // handler silences only the physical MIDI port while exporting, leaving the
  // frozen render state untouched.
  sequencerPanic() { return this.command({ type: 'sequencerPanic' }); }
  setMetronome(enabled, volume) { return this.command({ type: 'setMetronome', enabled, volume }); }
  setMasterOutput({ gainDb } = {}) {
    const command = { type: 'setMasterOutput' };
    if (Number.isFinite(gainDb)) command.gainDb = Math.max(-60, Math.min(12, gainDb));
    return this._renderCommand(command);
  }
  resetMasterClip() { return this.command({ type: 'resetMasterClip' }); }

  openEditor(chainId, instanceId, pluginId = null, generation = null) {
    const command = { type: 'openEditor', chainId, instanceId };
    if (pluginId) command.pluginId = pluginId;
    if (Number.isSafeInteger(generation)) command.generation = generation;
    return this._renderCommand(command);
  }

  closeEditor(chainId, instanceId) {
    return this.command({ type: 'closeEditor', chainId, instanceId });
  }

  getState(chainId, instanceId) {
    return this.command({ type: 'getState', chainId, instanceId });
  }

  /**
   * Load a `.vstpreset` into a live plugin as its raw component/controller
   * chunks, base64-encoded.
   *
   * Separate from `setState` on purpose: that path carries the JUCE binary-XML
   * envelope `getState()` produced, while these chunks come straight out of a
   * container file. Rebuilding that envelope here would mean reimplementing a
   * JUCE internal (see `plugin_host.cpp`, `setStateChunks`).
   *
   * `classId` travels with the request so the engine can refuse a preset meant
   * for another plugin. The checks below are for a useful answer, not for
   * safety: the engine validates identity, generation and class again.
   */
  loadPresetChunks(chainId, instanceId, pluginId, classId, component, controller = null) {
    if (this.state !== 'running') return Promise.resolve({ ok: false, reason: 'engine-not-running' });
    if (this.getInstanceStatus(chainId, instanceId) !== 'ready') {
      return Promise.resolve({ ok: false, reason: 'instance-not-ready' });
    }
    const generation = this.getInstanceGeneration(chainId, instanceId);
    if (!Number.isSafeInteger(generation)) return Promise.resolve({ ok: false, reason: 'generation-unknown' });
    const command = {
      type: 'loadPresetChunks', chainId, instanceId, pluginId, generation, classId, component
    };
    if (typeof controller === 'string' && controller.length > 0) command.controller = controller;
    return Promise.resolve(this.command(command));
  }

  setState(chainId, instanceId, state, pluginId = null, generation = null) {
    const command={ type: 'setState', chainId, instanceId, state };
    if(pluginId)command.pluginId=pluginId;if(Number.isSafeInteger(generation))command.generation=generation;
    return this._renderCommand(command);
  }

  /**
   * Set one live VST3 parameter from normalized CONTROL data.
   *
   * Persistent identities and the current native generation are included in
   * every write. The native engine independently validates them again before
   * resolving the live object, so a queued update cannot land on a replacement
   * that happens to reuse the same per-chain instance id.
   */
  setVstParameter(chainId, instanceId, pluginId, parameterId, normalizedValue) {
    if (this.state !== 'running') return { ok: false, reason: 'engine-not-running' };
    if (this.getInstanceStatus(chainId, instanceId) !== 'ready') {
      return { ok: false, reason: 'instance-not-ready' };
    }
    const generation = this.getInstanceGeneration(chainId, instanceId);
    if (!Number.isSafeInteger(generation)) return { ok: false, reason: 'generation-unknown' };
    try {
      // Fire-and-forget by design: each hardware value must not allocate a
      // request-correlation entry. Still consume an IPC rejection so an engine
      // exit between the state check and the write cannot create an unhandled
      // Promise rejection in the renderer.
      Promise.resolve(this._renderCommand({
        type: 'setVstParameter',
        chainId,
        instanceId,
        pluginId,
        generation,
        parameterId,
        normalizedValue
      })).catch(() => {});
    } catch (err) {
      return { ok: false, reason: 'ipc-write-failed' };
    }
    return { ok: true };
  }

  /** Arm/cancel the single native gesture-aware Learn operation. */
  setVstParameterLearn(chainId, instanceId, pluginId, generation, learnId, armed) {
    if (this.state !== 'running') return Promise.resolve({ ok: false, reason: 'engine-not-running' });
    return Promise.resolve(this.command({
      type: 'setVstParameterLearn',
      chainId,
      instanceId,
      pluginId,
      generation,
      learnId,
      armed: armed === true
    }));
  }

  /**
   * Request the parameters of one plugin instance inside a VST chain.
   *
   * Demand-driven: sends a `getVstParameters` command and resolves with the
   * engine's `vstParameters` response (which always arrives, even on error,
   * carrying a controlled `status`). The resolved object groups nothing here —
   * it is the per-plugin record; node-level grouping is done by the
   * discovery helper so future Patch Bay code can ask for a whole node.
   */
  getVstParameters(chainId, instanceId) {
    const requestId = this._nextRequestId('vst-params');
    const generation = this._engineGeneration;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this._pendingParams.get(requestId);
        if (!pending) return;
        this._pendingParams.delete(requestId);
        reject(new Error(`getVstParameters timed out: ${chainId}/${instanceId}`));
      }, this._parameterRequestTimeoutMs);
      this._pendingParams.set(requestId, {
        resolve, reject, timer, generation, chainId, instanceId
      });

      Promise.resolve(this.command({ type: 'getVstParameters', requestId, chainId, instanceId }))
        .then((res) => {
          if (res && res.ok) return;
          const pending = this._pendingParams.get(requestId);
          if (!pending) return;
          this._pendingParams.delete(requestId);
          clearTimeout(timer);
          reject(new Error((res && res.reason) || 'engine-unavailable'));
        })
        .catch((err) => {
          const pending = this._pendingParams.get(requestId);
          if (!pending) return;
          this._pendingParams.delete(requestId);
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });
  }
}
