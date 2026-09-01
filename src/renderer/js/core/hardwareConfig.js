const AUDIO_CONFIG_KEY = 'audioOutputConfig';

function boundedText(value, maxLength = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
    ? value : null;
}

/** Validate persisted/manual audio preferences before they reach native IPC. */
export function normalizeAudioOutputConfig(value) {
  if (!value || typeof value !== 'object') return null;
  const deviceName = boundedText(value.deviceName);
  const sampleRate = value.sampleRate;
  const bufferSize = value.bufferSize;
  if (!deviceName || typeof sampleRate !== 'number' || !Number.isFinite(sampleRate)
      || sampleRate < 8000 || sampleRate > 384000
      || !Number.isSafeInteger(bufferSize) || bufferSize < 16 || bufferSize > 8192) return null;
  return { deviceName, sampleRate, bufferSize };
}

function uniqueDevices(devices) {
  const byName = new Map();
  for (const device of devices || []) {
    if (!boundedText(device?.name)) continue;
    const existing = byName.get(device.name);
    if (!existing || (device.isWASAPI && !existing.isWASAPI)) byName.set(device.name, device);
  }
  return [...byName.values()];
}

function configKey(config) {
  return config ? `${config.deviceName}\u001f${config.sampleRate}\u001f${config.bufferSize}` : '';
}

function runtimeMatches(runtime, preferred) {
  return !!runtime && !!preferred && runtime.running === true
    && runtime.device === preferred.deviceName
    && Number(runtime.sampleRate) === preferred.sampleRate
    && Number(runtime.bufferSize) === preferred.bufferSize;
}

/**
 * Restores audio preferences only after this engine run has reported both its
 * device enumeration and actual runtime state. One configuration is attempted
 * at most once per engine run, preventing refresh/duplicate-event loops.
 */
export class HardwareConfigManager {
  constructor(hub) {
    this.hub = hub;
    this.preferredAudio = null;
    this.runtimeAudio = null;
    this.audioStatus = { state: 'idle', preferred: null, runtime: null, available: null };
    this._devicesGeneration = null;
    this._stateGeneration = null;
    this._attempts = new Set();
    this._unsubs = [
      hub.events.on('engine:devices', () => this._onDevices()),
      hub.events.on('engine:deviceState', (state) => this._onDeviceState(state)),
      hub.events.on('engine:state', (state) => this._onEngineState(state)),
      hub.events.on('engine:error', (error) => this._onEngineError(error))
    ];
  }

  dispose() {
    this._unsubs.forEach((off) => { if (typeof off === 'function') off(); });
    this._unsubs = [];
  }

  /** Persist an explicit user choice and apply it without waiting for another refresh. */
  async applyAudioPreference(value) {
    const config = normalizeAudioOutputConfig(value);
    if (!config) return { ok: false, reason: 'invalid-config' };
    this.preferredAudio = config;
    await this.hub.settings.set(AUDIO_CONFIG_KEY, config);
    if (this.hub.engine.state !== 'running') {
      this._publish('engine-unavailable', false, 'engine-not-running');
      return { ok: true, applied: false };
    }
    const available = uniqueDevices(this.hub.engine.devices)
      .some((device) => device.name === config.deviceName);
    if (!available) {
      this._publish('preferred-unavailable', false, 'device-not-found');
      return { ok: true, applied: false };
    }
    return this._issueSelection(config, true);
  }

  /** Re-enumerate and re-read runtime state as one restoration checkpoint. */
  refreshAudioDevices() {
    this.hub.engine.listDevices();
    this.hub.engine.getDeviceState();
  }

  _onDevices() {
    if (this.hub.engine.state !== 'running') return;
    this._devicesGeneration = this.hub.engine.runtimeGeneration;
    this._tryRestore();
  }

  _onDeviceState(state) {
    if (this.hub.engine.state !== 'running') return;
    this.runtimeAudio = state || null;
    this._stateGeneration = this.hub.engine.runtimeGeneration;
    this._tryRestore();
  }

  _onEngineState(state) {
    if (state?.state === 'running') {
      // EngineClient refreshes immediately for each run. Its devices/state
      // events will establish this generation's restoration checkpoint.
      this._tryRestore();
      return;
    }
    this._devicesGeneration = null;
    this._stateGeneration = null;
    this.runtimeAudio = null;
    this._publish('engine-unavailable', null, state?.error || `engine-${state?.state || 'stopped'}`);
  }

  _onEngineError(error) {
    if (!['device-open', 'device-not-found', 'device-invalid'].includes(error?.code)) return;
    this._publish('restore-failed', this._preferredAvailable(), error.message || error.code);
  }

  _tryRestore() {
    const generation = this.hub.engine.runtimeGeneration;
    if (this.hub.engine.state !== 'running'
        || this._devicesGeneration !== generation || this._stateGeneration !== generation) return;
    this.preferredAudio = normalizeAudioOutputConfig(this.hub.settings.get(AUDIO_CONFIG_KEY));
    if (!this.preferredAudio) {
      this._publish('no-preference', null, null);
      return;
    }
    const available = this._preferredAvailable();
    if (!available) {
      this._publish('preferred-unavailable', false, 'device-not-found');
      return;
    }
    if (runtimeMatches(this.runtimeAudio, this.preferredAudio)) {
      this._publish('restored', true, null);
      return;
    }
    this._issueSelection(this.preferredAudio, false);
  }

  _preferredAvailable() {
    return !!this.preferredAudio && uniqueDevices(this.hub.engine.devices)
      .some((device) => device.name === this.preferredAudio.deviceName);
  }

  _issueSelection(config, explicit) {
    const attemptKey = `${this.hub.engine.runtimeGeneration}\u001f${configKey(config)}`;
    if (!explicit && this._attempts.has(attemptKey)) {
      this._publish('restoring', true, null);
      return { ok: true, applied: false, reason: 'already-attempted' };
    }
    this._attempts.add(attemptKey);
    this._publish('restoring', true, null);
    Promise.resolve(this.hub.engine.selectDevice(
      { name: config.deviceName }, config.sampleRate, config.bufferSize
    )).then((result) => {
      if (!result?.ok) this._publish('restore-failed', true, result?.reason || 'engine-unavailable');
    }).catch(() => this._publish('restore-failed', true, 'ipc-write-failed'));
    return { ok: true, applied: true };
  }

  _publish(state, available, reason) {
    this.audioStatus = {
      state,
      preferred: this.preferredAudio,
      runtime: this.runtimeAudio,
      available,
      reason: reason || null
    };
    this.hub.events.emit('hardware:audio', this.audioStatus);
  }
}
