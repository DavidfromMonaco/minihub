import { parseMidiMessage } from './parseMidi.js';
import { isMiniLabName, miniLabScore } from './minilab.js';

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
    this._messageHandlers = new Map(); // inputId -> fn
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
    this.inputs.clear();
    this.outputs.clear();

    this.midiAccess.inputs.forEach((port) => {
      const info = this._portInfo(port);
      this.inputs.set(info.id, info);
      this._attachMessageHandler(port, info.id);
    });

    this.midiAccess.outputs.forEach((port) => {
      this.outputs.set(port.id, this._portInfo(port));
    });

    // If the selected input disappeared, clear the selection. Any note it was
    // holding will never get its Note Off, so tell everything downstream to
    // silence itself. The persisted preference is deliberately NOT cleared, so
    // the port can be re-armed when it comes back.
    if (this.selectedInputId && !this.inputs.has(this.selectedInputId)) {
      this.selectedInputId = null;
      this.events.emit('midi:panic', { reason: 'input-disconnected' });
    }

    // Hot-plug: the preferred port has (re)appeared while nothing is armed.
    // Without this, plugging the controller in after launch left the selection
    // empty, which silently routed EVERY input - including the MiniLab's
    // control-surface port - into the graph.
    if (!this.selectedInputId) {
      const preferred = this.settings.get('selectedInputId');
      if (preferred && this.inputs.has(preferred)) {
        this.selectedInputId = preferred;
        this.events.emit('midi:inputArmed', { inputId: preferred });
      }
    }
    if (this.selectedOutputId && !this.outputs.has(this.selectedOutputId)) {
      this.selectedOutputId = null;
    }
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
    const handler = (event) => this._onMessage(id, event.data, event.timeStamp);
    this._messageHandlers.set(id, handler);
    port.onmidimessage = handler;
  }

  _onMessage(inputId, data, webMidiTimestamp) {
    // Only route messages from the selected input.
    if (this.selectedInputId && inputId !== this.selectedInputId) return;

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

  selectInput(id) {
    if (id !== null && !this.inputs.has(id)) return false;
    const previous = this.selectedInputId;
    this.selectedInputId = id;
    // Switching away from a device that may be holding notes leaves them
    // stuck downstream, because its Note Offs are now filtered out.
    if (previous && previous !== id) {
      this.events.emit('midi:panic', { reason: 'input-changed' });
    }
    return true;
  }

  selectOutput(id) {
    if (id !== null && !this.outputs.has(id)) return false;
    this.selectedOutputId = id;
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
