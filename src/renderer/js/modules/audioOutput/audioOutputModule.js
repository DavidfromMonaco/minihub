/**
 * Audio Output — native/system Patch Bay node + editor.
 *
 * This is NOT a user-created node. It is a system node that represents the
 * physical audio output owned by the native engine. It appears in the Patch Bay
 * with a single `AUDIO IN` input, is non-deletable and non-copyable, and its
 * editor exposes the real native-engine audio settings (WASAPI output devices,
 * sample rate, buffer size, engine state).
 *
 * The engine only sends audio to the physical output for VST chains that are
 * connected here in `hub.graph` (VST AUDIO OUT -> Audio Output AUDIO IN).
 */
import { icon } from '../../ui/icons.js';

const NODE_ID = 'audio-output';

const SAMPLE_RATES = [44100, 48000, 88200, 96000];
const BUFFER_SIZES = [128, 256, 512, 1024];

const CONFIG_KEY = 'audioOutputConfig';

/** Deduplicate engine output devices by name, preferring WASAPI low latency. */
function dedupeDevices(devices) {
  const byName = new Map();
  for (const d of devices || []) {
    const existing = byName.get(d.name);
    if (!existing || (d.isWASAPI && !existing.isWASAPI)) {
      byName.set(d.name, d);
    }
  }
  return [...byName.values()];
}

export function createAudioOutputModule(hub) {
  let container = null;
  let subs = [];
  let els = {};

  function engineStateText() {
    const s = hub.engine.state;
    if (s === 'running') return { text: 'Engine ready', cls: 'ok' };
    if (s === 'error') return { text: 'Engine error', cls: 'off' };
    if (s === 'starting') return { text: 'Engine starting…', cls: 'idle' };
    return { text: 'Engine stopped', cls: 'idle' };
  }

  function render() {
    const devices = dedupeDevices(hub.engine.devices);
    const st = engineStateText();
    const cfg = hub.settings.get(CONFIG_KEY) || {};

    container.innerHTML = `
      <div class="panel">
        <div class="row">
          <h1 class="page-title">Audio Output</h1>
          <span class="spacer"></span>
          <span id="ao-status" class="pill ${st.cls}">${st.text}</span>
        </div>
        <p class="muted m-0">Physical audio output owned by the native engine (WASAPI Shared Low Latency).</p>
      </div>

      <div class="grid grid-2 mt-16">
        <div class="panel">
          <h2 class="panel-title">Device</h2>
          <div class="field">
            <label for="ao-device">Output device</label>
            <select id="ao-device" class="select"></select>
          </div>
          <div class="field mt-12">
            <label for="ao-sample-rate">Sample rate</label>
            <select id="ao-sample-rate" class="select">
              ${SAMPLE_RATES.map((r) => `<option value="${r}" ${cfg.sampleRate === r ? 'selected' : ''}>${r} Hz</option>`).join('')}
            </select>
          </div>
          <div class="field mt-12">
            <label for="ao-buffer">Buffer size</label>
            <select id="ao-buffer" class="select">
              ${BUFFER_SIZES.map((b) => `<option value="${b}" ${cfg.bufferSize === b ? 'selected' : ''}>${b} samples</option>`).join('')}
            </select>
          </div>
          <div class="row mt-14">
            <button id="ao-apply" class="btn primary">Apply</button>
            <button id="ao-refresh" class="btn">Refresh devices</button>
          </div>
        </div>

        <div class="panel">
          <h2 class="panel-title">Engine</h2>
          <div class="stat">
            <span class="stat-label">State</span>
            <span id="ao-engine-state" class="stat-value">—</span>
          </div>
          <div class="stat mt-10">
            <span class="stat-label">Device</span>
            <span id="ao-current-device" class="stat-value">—</span>
          </div>
          <div class="row mt-10">
            <div class="stat">
              <span class="stat-label">Sample rate</span>
              <span id="ao-current-sr" class="stat-value mono">—</span>
            </div>
            <div class="stat">
              <span class="stat-label">Buffer</span>
              <span id="ao-current-buf" class="stat-value mono">—</span>
            </div>
          </div>
          <div id="ao-error" class="ao-error"></div>
        </div>
      </div>`;

    els = {
      status: container.querySelector('#ao-status'),
      device: container.querySelector('#ao-device'),
      sampleRate: container.querySelector('#ao-sample-rate'),
      buffer: container.querySelector('#ao-buffer'),
      apply: container.querySelector('#ao-apply'),
      refresh: container.querySelector('#ao-refresh'),
      engineState: container.querySelector('#ao-engine-state'),
      currentDevice: container.querySelector('#ao-current-device'),
      currentSr: container.querySelector('#ao-current-sr'),
      currentBuf: container.querySelector('#ao-current-buf'),
      error: container.querySelector('#ao-error')
    };

    fillDeviceSelect(devices, cfg.deviceName);

    els.apply.addEventListener('click', applyConfig);
    els.refresh.addEventListener('click', () => hub.engine.listDevices());

    // Subscribe to engine events for live status.
    subs.push(
      hub.events.on('engine:devices', () => {
        hub.diagnostics.log(`audioOutput: devices event -> render ${dedupeDevices(hub.engine.devices).length} options`);
        fillDeviceSelect(dedupeDevices(hub.engine.devices), hub.settings.get(CONFIG_KEY)?.deviceName);
      }),
      hub.events.on('engine:deviceState', (msg) => updateDeviceState(msg)),
      hub.events.on('engine:state', () => {
        updateEngineState();
        // If the module was opened before the engine was ready, re-request the
        // real device list once the engine handshake completes.
        if (hub.engine.state === 'running') {
          hub.engine.listDevices();
          hub.engine.getDeviceState();
        }
      })
    );

    updateEngineState();
    hub.engine.listDevices();
    hub.engine.getDeviceState();
  }

  function fillDeviceSelect(devices, selectedName) {
    if (!els.device) return;
    els.device.innerHTML = '';
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = '— Select device —';
    els.device.appendChild(empty);
    for (const d of devices) {
      const opt = document.createElement('option');
      opt.value = d.name;
      opt.textContent = d.isWASAPI ? `${d.name} (WASAPI)` : `${d.name} (${d.type})`;
      els.device.appendChild(opt);
    }
    els.device.value = selectedName || '';
  }

  function applyConfig() {
    const deviceName = els.device.value;
    if (!deviceName) return;
    const sampleRate = Number(els.sampleRate.value);
    const bufferSize = Number(els.buffer.value);
    hub.settings.set(CONFIG_KEY, { deviceName, sampleRate, bufferSize });
    hub.engine.selectDevice({ name: deviceName }, sampleRate, bufferSize);
  }

  function updateDeviceState(msg) {
    if (!els.currentDevice) return;
    els.currentDevice.textContent = msg.device || '—';
    els.currentSr.textContent = msg.sampleRate ? `${Math.round(msg.sampleRate)} Hz` : '—';
    els.currentBuf.textContent = msg.bufferSize ? `${msg.bufferSize}` : '—';
    els.error.textContent = msg.error || '';
    els.status.textContent = msg.running ? 'Engine ready' : 'Engine stopped';
    els.status.className = 'pill ' + (msg.running ? 'ok' : 'idle');
  }

  function updateEngineState() {
    const st = engineStateText();
    if (els.status) {
      els.status.textContent = st.text;
      els.status.className = 'pill ' + st.cls;
    }
    if (els.engineState) els.engineState.textContent = hub.engine.state;
    if (els.error) els.error.textContent = hub.engine.error || '';
  }

  function mount(el) {
    container = el;
    hub.diagnostics.log(`audioOutput: mount devices=${hub.engine.devices.length} engine=${hub.engine.state}`);
    render();
  }

  function unmount() {
    subs.forEach((u) => u());
    subs = [];
    container = null;
    els = {};
  }

  return {
    id: 'audio-output',
    name: 'Audio Output',
    navEntry: { label: 'Audio Output', icon: 'speaker' },
    routingNode: {
      id: NODE_ID,
      name: 'Audio Output',
      type: 'system',
      inputs: [{ id: 'audio-in', type: 'audio', label: 'AUDIO IN' }],
      outputs: []
    },
    mount,
    unmount
  };
}
