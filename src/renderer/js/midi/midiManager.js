import { parseMidiMessage } from './parseMidi.js';
import { isMiniLabName, isPerformanceInputName, miniLabScore } from './minilab.js';

const MIDI_INPUT_PREFERENCE_KEY = 'midiInputPreference';

function normalizedIdentityText(value) {
  return String(value || '').trim().toLocaleLowerCase();
}

export function normalizeMidiInputPreference(value) {
  if (!value || typeof value !== 'object') return null;
  const field = (name, max) => typeof value[name] === 'string' && value[name].length <= max
    ? value[name] : '';
  const id = field('id', 256);
  const name = field('name', 256);
  const manufacturer = field('manufacturer', 256);
  const type = field('type', 32) || 'input';
  if (!id && !name) return null;
  return { id, name, manufacturer, type };
}

function preferenceForPort(port) {
  return {
    id: port.id,
    name: port.name || '',
    manufacturer: port.manufacturer || '',
    type: port.type || 'input'
  };
}

function samePhysicalPort(port, preference) {
  return normalizedIdentityText(port?.name) === normalizedIdentityText(preference?.name)
    && normalizedIdentityText(port?.manufacturer) === normalizedIdentityText(preference?.manufacturer)
    && normalizedIdentityText(port?.type || 'input') === normalizedIdentityText(preference?.type || 'input');
}

/**
 * MIDI device layer built on the Web MIDI API.
 *
 * Responsibilities:
 *   - enumerate input/output ports
 *   - detect MiniLab devices
 *   - select input/output ports
 *   - route incoming messages from the selected input onto the event bus
 *   - survive device connect/disconnect without crashing
 *
 * Emits events:
 *   midi:state     { state: 'unavailable'|'ready'|'error', error? }
 *   midi:ports     { inputs: [...], outputs: [...] }
 *   midi:inputMessage normalized message from every physical input (recording)
 *   midi:message   normalized message (only from the selected input)
 *   midi:panic     the selected input went away or changed while it may have
 *                  held notes down - everything downstream must be silenced
 *   midi:noteon / midi:noteoff / midi:cc / midi:pitchbend / ...
 */
export class MidiManager {
  constructor(events, settings) {
    this.events = events;
    this.settings = settings;
    this.midiAccess = null;
    this.state = 'unavailable';
    this.inputs = new Map(); // id -> { id, name, manufacturer }
    this.outputs = new Map(); // id -> { id, name, manufacturer }
    this.selectedInputId = null;
    this.selectedOutputId = null;
    this._messageHandlers = new Map(); // inputId -> { port, handler }
  }

  /** Initialise Web MIDI. Safe to call once. */
  async init() {
    if (this.midiAccess) return;
    if (typeof navigator.requestMIDIAccess !== 'function') {
      this.state = 'unavailable';
      this.events.emit('midi:state', { state: 'unavailable' });
      return;
    }
    try {
      this.midiAccess = await navigator.requestMIDIAccess({ sysex: false });
      this.state = 'ready';
      this._bindStateChanges();
      this._refreshPorts();
      this.events.emit('midi:state', { state: 'ready' });
    } catch (err) {
      this.state = 'error';
      this.events.emit('midi:state', { state: 'error', error: err.message });
    }
  }

  _bindStateChanges() {
    this.midiAccess.onstatechange = () => {
      this._refreshPorts();
      this.events.emit('midi:ports', {
        inputs: this.listInputs(),
        outputs: this.listOutputs()
      });
    };
  }

  _refreshPorts() {
    const previousSelected = this.selectedInputId ? this.inputs.get(this.selectedInputId) : null;
    const nextInputs = new Map();
    const nextOutputs = new Map();

    this.midiAccess.inputs.forEach((port) => {
      const info = this._portInfo(port);
      nextInputs.set(info.id, info);
      this._attachMessageHandler(port, info.id);
    });

    this.midiAccess.outputs.forEach((port) => {
      nextOutputs.set(port.id, this._portInfo(port));
    });

    for (const [id, record] of this._messageHandlers) {
      if (nextInputs.has(id)) continue;
      if (record.port.onmidimessage === record.handler) record.port.onmidimessage = null;
      this._messageHandlers.delete(id);
    }
    this.inputs = nextInputs;
    this.outputs = nextOutputs;

    // If the selected input disappeared, clear the selection. Any note it was
    // holding will never get its Note Off, so tell everything downstream to
    // silence itself. The persisted preference is deliberately NOT cleared, so
    // the port can be re-armed when it comes back.
    const selectedNow = this.selectedInputId ? this.inputs.get(this.selectedInputId) : null;
    if (this.selectedInputId && (!selectedNow
        || (previousSelected && !samePhysicalPort(selectedNow, previousSelected)))) {
      this.selectedInputId = null;
      this.events.emit('midi:panic', { reason: 'input-disconnected' });
    }

    // Hot-plug: the preferred port has (re)appeared while nothing is armed.
    // Without this, plugging the controller in after launch left the selection
    // empty, which silently routed EVERY input - including the MiniLab's
    // control-surface port - into the graph.
    if (!this.selectedInputId) {
      const preferred = this._inputPreference();
      let match = this._resolveInputPreference(preferred);
      if (match && isMiniLabName(match.name) && !isPerformanceInputName(match.name)) {
        const better = this.findMiniLabInputId();
        if (better) match = this.inputs.get(better) || match;
      }
      if (match) {
        this.selectedInputId = match.id;
        this.events.emit('midi:inputArmed', { inputId: match.id });
        const currentPreference = normalizeMidiInputPreference(
          this.settings.get(MIDI_INPUT_PREFERENCE_KEY)
        );
        if (!currentPreference || JSON.stringify(currentPreference) !== JSON.stringify(preferenceForPort(match))) {
          this._persistInputPreference(match);
        }
      }
    }
    if (this.selectedOutputId && !this.outputs.has(this.selectedOutputId)) {
      this.selectedOutputId = null;
      this.events.emit('midi:output', { id: null, name: '', reason: 'output-disconnected' });
    }
    this.events.emit('midi:preference', this.inputPreferenceStatus());
  }

  _portInfo(port) {
    return {
      id: port.id,
      name: port.name || 'Unknown device',
      manufacturer: port.manufacturer || '',
      type: port.type
    };
  }

  _attachMessageHandler(port, id) {
    const previous = this._messageHandlers.get(id);
    if (previous?.port === port && port.onmidimessage === previous.handler) return;
    if (previous && previous.port.onmidimessage === previous.handler) {
      previous.port.onmidimessage = null;
    }
    const handler = (event) => this._onMessage(id, event.data, event.timeStamp);
    this._messageHandlers.set(id, { port, handler });
    port.onmidimessage = handler;
  }

  _inputPreference() {
    const stored = normalizeMidiInputPreference(this.settings.get(MIDI_INPUT_PREFERENCE_KEY));
    if (stored) return stored;
    const legacyId = this.settings.get('selectedInputId');
    return typeof legacyId === 'string' && legacyId ? { id: legacyId, name: '', manufacturer: '', type: 'input' } : null;
  }

  _resolveInputPreference(preference) {
    if (!preference) return null;
    const exact = preference.id ? this.inputs.get(preference.id) : null;
    // Legacy ID-only settings have no fingerprint yet. Once resolved, they are
    // immediately migrated to the stable descriptor form.
    if (exact && (!preference.name || samePhysicalPort(exact, preference))) return exact;
    if (!preference.name) return null;
    return this.listInputs().find((port) => samePhysicalPort(port, preference)) || null;
  }

  _persistInputPreference(port) {
    const preference = port ? preferenceForPort(port) : null;
    const values = { [MIDI_INPUT_PREFERENCE_KEY]: preference, selectedInputId: port?.id || null };
    if (typeof this.settings.setMany === 'function') this.settings.setMany(values);
    else {
      this.settings.set(MIDI_INPUT_PREFERENCE_KEY, preference);
      this.settings.set('selectedInputId', port?.id || null);
    }
  }

  _onMessage(inputId, data, webMidiTimestamp) {
    const msg = parseMidiMessage(data);
    if (!msg) return;

    const input = this.inputs.get(inputId);
    msg.sourceId = inputId;
    msg.sourceName = input ? input.name : '';

    // --- Timing model (canonical value for future timing-sensitive modules) ---
    // Compensation is a pure annotation: live processing is never delayed.
    msg.webMidiTimestamp = webMidiTimestamp;
    msg.hubTimestamp = performance.now();
    msg.offsetMs = this.getInputOffset(inputId);
    msg.compensatedTimestamp = msg.webMidiTimestamp + msg.offsetMs;
    msg.processingDelayMs = msg.hubTimestamp - msg.webMidiTimestamp; // diagnostics

    // Keep the all-input observation event for diagnostics/legacy listeners,
    // but only the explicitly selected port may enter live Patch Bay routing.
    // With no selected input, every physical port is isolated rather than
    // being mislabeled as MiniLab 3 MIDI OUT.
    this.events.emit('midi:inputMessage', msg);
    if (!this.selectedInputId || inputId !== this.selectedInputId) return;

    this.events.emit('midi:message', msg);
    this.events.emit(`midi:${msg.type}`, msg);
  }

  // --- Public API -----------------------------------------------------------

  listInputs() {
    return [...this.inputs.values()];
  }

  listOutputs() {
    return [...this.outputs.values()];
  }

  getInput(id) {
    return this.inputs.get(id);
  }

  getOutput(id) {
    return this.outputs.get(id);
  }

  selectInput(id, { remember = false } = {}) {
    if (id !== null && !this.inputs.has(id)) return false;
    const previous = this.selectedInputId;
    this.selectedInputId = id;
    // Switching away from a device that may be holding notes leaves them
    // stuck downstream, because its Note Offs are now filtered out.
    if (previous && previous !== id) {
      this.events.emit('midi:panic', { reason: 'input-changed' });
    }
    if (remember) this._persistInputPreference(id ? this.inputs.get(id) : null);
    this.events.emit('midi:preference', this.inputPreferenceStatus());
    return true;
  }

  /** Select and persist the best MiniLab performance port on first run. */
  autoSelectMiniLabInput() {
    if (this.selectedInputId || this._inputPreference()) return this.selectedInputId;
    const id = this.findMiniLabInputId();
    if (id) this.selectInput(id, { remember: true });
    return this.selectedInputId;
  }

  inputPreferenceStatus() {
    const preference = this._inputPreference();
    const selected = this.selectedInputId ? this.inputs.get(this.selectedInputId) || null : null;
    return {
      preference,
      selected,
      available: !!this._resolveInputPreference(preference)
    };
  }

  selectOutput(id) {
    if (id !== null && !this.outputs.has(id)) return false;
    this.selectedOutputId = id;
    const output = id ? this.outputs.get(id) : null;
    this.events.emit('midi:output', output || { id: null, name: '' });
    return true;
  }

  /** True if any connected port looks like a MiniLab. */
  isMiniLabConnected() {
    return [...this.inputs.values(), ...this.outputs.values()].some((p) =>
      isMiniLabName(p.name)
    );
  }

  // --- Timing compensation --------------------------------------------------

  /**
   * Configured timing offset (ms) for an input device. Defaults to 0.
   * Negative = treat events as earlier; positive = treat events as later.
   */
  getInputOffset(inputId) {
    const offsets = this.settings.get('inputOffsets') || {};
    return offsets[inputId] ?? 0;
  }

  /** Set (and persist) the timing offset for an input device. */
  async setInputOffset(inputId, ms) {
    const value = Math.round(Number(ms) || 0);
    const offsets = { ...(this.settings.get('inputOffsets') || {}) };
    if (value === 0) {
      delete offsets[inputId]; // keep stored state minimal
    } else {
      offsets[inputId] = value;
    }
    await this.settings.set('inputOffsets', offsets);
    this.events.emit('midi:offset', { inputId, offsetMs: value });
    return value;
  }

  /** Best-candidate MiniLab input port id, if any. */
  findMiniLabInputId() {
    const inputs = this.listInputs()
      .filter((p) => isMiniLabName(p.name))
      .sort((a, b) => miniLabScore(b.name) - miniLabScore(a.name));
    return inputs.length ? inputs[0].id : null;
  }

  /** Send a raw message to the selected output (future modules). */
  send(data) {
    if (!this.selectedOutputId) return false;
    const port = this.midiAccess.outputs.get(this.selectedOutputId);
    if (!port) return false;
    try {
      port.send(data);
      return true;
    } catch (err) {
      console.error('[midi] send failed:', err);
      return false;
    }
  }
}
