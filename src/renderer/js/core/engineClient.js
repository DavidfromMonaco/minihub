/**
 * Renderer-side client for the native audio engine.
 *
 * Talks to the engine through the main process (preload `hubAPI`). Holds the
 * engine lifecycle state, the real audio device list, and the real VST3 plugin
 * registry, and emits typed events on the Hub bus. Audio samples never cross
 * this boundary — only CONTROL and MIDI messages.
 */

const PROTOCOL_VERSION = 1;

export class EngineClient {
  constructor(api, events, settings) {
    this.api = api;
    this.events = events;
    this.settings = settings;
    this.state = 'stopped'; // stopped | starting | running | error
    this.error = null;
    this.devices = []; // real WASAPI output devices from the engine
    this.plugins = []; // real VST3 registry
    this._registry = new Map(); // pluginId -> record
    this._unsubs = [];
    this._ready = null;
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
      this.api.onEngineState((s) => {
        this.state = s.state;
        this.error = s.error;
        this.diag(`renderer: engine:state ${s.state}`);
        this.events.emit('engine:state', s);
      }),
      this.api.onEngineEvent((msg) => this._onEvent(msg))
    );
    this._ready = this.api.engineState().then((s) => {
      if (s) {
        this.state = s.state;
        this.error = s.error;
      }
      return this.state;
    });
    return this._ready;
  }

  /** Drop every main-process subscription (teardown / tests). */
  dispose() {
    this._unsubs.forEach((off) => { if (typeof off === 'function') off(); });
    this._unsubs = [];
    this._ready = null;
  }

  _onEvent(msg) {
    console.log(`[engineClient:event] ${msg.type}${msg.count !== undefined ? ' count=' + msg.count : ''}`);
    switch (msg.type) {
      case 'devices':
        this.devices = msg.outputs || [];
        this.diag(`renderer: devices event received count=${this.devices.length}`);
        this.events.emit('engine:devices', this.devices);
        break;
      case 'deviceState':
        this.events.emit('engine:deviceState', msg);
        break;
      case 'plugins':
        this._setPlugins(msg.plugins || []);
        this.diag(`renderer: plugins event received count=${this.plugins.length}`);
        this.events.emit('engine:plugins', this.plugins);
        break;
      case 'chainChanged':
        this.events.emit('engine:chainChanged', msg);
        break;
      case 'instanceStatus':
        this.events.emit('engine:instanceStatus', msg);
        break;
      case 'editorStatus':
        this.events.emit('engine:editorStatus', msg);
        break;
      case 'status':
        this.events.emit('engine:status', msg);
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
    console.log(`[engineClient:command] ${msg.type}`);
    return this.api.engineCommand({ v: PROTOCOL_VERSION, ...msg });
  }

  listDevices() {
    return this.command({ type: 'listDevices' });
  }

  selectDevice(device, sampleRate, bufferSize) {
    return this.command({ type: 'selectDevice', device, sampleRate, bufferSize });
  }

  getDeviceState() {
    return this.command({ type: 'getDeviceState' });
  }

  scanVst3() {
    return this.command({ type: 'scanVst3' });
  }

  createInstance(chainId, pluginId, instanceId, index) {
    return this.command({ type: 'createInstance', chainId, pluginId, instanceId, index });
  }

  removeInstance(chainId, instanceId) {
    return this.command({ type: 'removeInstance', chainId, instanceId });
  }

  reorderChain(chainId, instanceId, toIndex) {
    return this.command({ type: 'reorderChain', chainId, instanceId, toIndex });
  }

  setBypass(chainId, instanceId, bypassed) {
    return this.command({ type: 'setBypass', chainId, instanceId, bypassed });
  }

  midi(chainId, data) {
    return this.command({ type: 'midi', chainId, data });
  }

  setChainMidiEnabled(chainId, enabled) {
    return this.command({ type: 'setChainMidiEnabled', chainId, enabled });
  }

  setChainOutputEnabled(chainId, enabled) {
    return this.command({ type: 'setChainOutputEnabled', chainId, enabled });
  }

  openEditor(chainId, instanceId) {
    return this.command({ type: 'openEditor', chainId, instanceId });
  }

  closeEditor(chainId, instanceId) {
    return this.command({ type: 'closeEditor', chainId, instanceId });
  }

  getState(chainId, instanceId) {
    return this.command({ type: 'getState', chainId, instanceId });
  }

  setState(chainId, instanceId, state) {
    return this.command({ type: 'setState', chainId, instanceId, state });
  }
}
