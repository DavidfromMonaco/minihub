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
import {
  MASTER_OUTPUT_KEY,
  normalizeMasterOutput,
  updateMasterOutput
} from '../../core/masterOutput.js';

const NODE_ID = 'audio-output';

const SAMPLE_RATES = [44100, 48000, 88200, 96000];
const BUFFER_SIZES = [128, 256, 512, 1024];

const CONFIG_KEY = 'audioOutputConfig';

const meterPercent = (db) => Math.max(0, Math.min(100, ((Number(db) || -100) + 60) / 60 * 100));
const formatDb = (db, floor = -100) => Number.isFinite(Number(db)) && Number(db) > floor
  ? `${Number(db).toFixed(1)} dBFS` : '−∞ dBFS';

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
  const pathTelemetry = new Map();

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
    const master = normalizeMasterOutput(hub.settings.get(MASTER_OUTPUT_KEY));

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
      </div>

      <div class="panel mt-16 master-output-panel">
        <div class="row">
          <div>
            <h2 class="panel-title">Master Output</h2>
            <p class="muted m-0">Final signal shared by monitoring and Master export.</p>
          </div>
          <span class="spacer"></span>
          <span id="float-mix-badge" class="pill ok">Linear float sum · no auto gain</span>
        </div>
        <div class="master-output-grid mt-14">
          <div class="master-gain-control">
            <div class="row">
              <label for="master-gain">Master Gain</label>
              <output id="master-gain-value" class="mono">${master.gainDb.toFixed(1)} dB</output>
            </div>
            <input id="master-gain" class="range" type="range" min="-60" max="12" step="0.1" value="${master.gainDb}">
            <div class="master-scale"><span>−60</span><span>0</span><span>+12 dB</span></div>
          </div>
          <div class="master-meters" aria-label="Master output meters">
            <div class="master-meter-row">
              <span class="master-channel">L</span>
              <span class="master-meter-track"><i id="master-meter-l"></i></span>
              <output id="master-peak-l" class="mono">−∞ dBFS</output>
            </div>
            <div class="master-meter-row">
              <span class="master-channel">R</span>
              <span class="master-meter-track"><i id="master-meter-r"></i></span>
              <output id="master-peak-r" class="mono">−∞ dBFS</output>
            </div>
          </div>
          <div class="master-safety">
            <button id="master-clip" class="master-clip" type="button" title="Reset persistent clip indicator">CLIP</button>
            <div class="stat">
              <span class="stat-label">Master pre-gain peak</span>
              <span id="master-pre-gain-peak" class="stat-value mono">−∞ dBFS</span>
            </div>
            <div class="stat">
              <span class="stat-label">Automatic gain reduction</span>
              <span id="automatic-gain-reduction" class="stat-value mono">OFF</span>
            </div>
          </div>
        </div>
      </div>

      <div class="panel mt-16">
        <div class="row">
          <div>
            <h2 class="panel-title">Gain staging diagnostics</h2>
            <p class="muted m-0">Temporary per-node telemetry sampled off the audio callback.</p>
          </div>
          <span class="spacer"></span>
          <span id="audio-runtime-summary" class="mono muted">Waiting for callback telemetry…</span>
        </div>
        <div id="audio-path-diagnostics" class="node-safety-diagnostics mt-14"></div>
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
      error: container.querySelector('#ao-error'),
      masterGain: container.querySelector('#master-gain'),
      masterGainValue: container.querySelector('#master-gain-value'),
      floatMixBadge: container.querySelector('#float-mix-badge'),
      meterLeft: container.querySelector('#master-meter-l'),
      meterRight: container.querySelector('#master-meter-r'),
      peakLeft: container.querySelector('#master-peak-l'),
      peakRight: container.querySelector('#master-peak-r'),
      clip: container.querySelector('#master-clip'),
      preGainPeak: container.querySelector('#master-pre-gain-peak'),
      automaticGainReduction: container.querySelector('#automatic-gain-reduction'),
      runtimeSummary: container.querySelector('#audio-runtime-summary'),
      pathDiagnostics: container.querySelector('#audio-path-diagnostics')
    };

    fillDeviceSelect(devices, cfg.deviceName);

    els.apply.addEventListener('click', applyConfig);
    els.refresh.addEventListener('click', () => hub.hardware.refreshAudioDevices());
    els.masterGain?.addEventListener('input', () => {
      const gainDb = Number(els.masterGain.value);
      els.masterGainValue.textContent = `${gainDb.toFixed(1)} dB`;
      updateMasterOutput(hub, { gainDb });
    });
    els.clip?.addEventListener('click', () => {
      hub.engine.resetMasterClip();
    });

    // Subscribe to engine events for live status.
    subs.push(
      hub.events.on('engine:devices', () => {
        hub.diagnostics.log(`audioOutput: devices event -> render ${dedupeDevices(hub.engine.devices).length} options`);
        fillDeviceSelect(dedupeDevices(hub.engine.devices), hub.settings.get(CONFIG_KEY)?.deviceName);
      }),
      hub.events.on('engine:deviceState', (msg) => updateDeviceState(msg)),
      hub.events.on('engine:state', updateEngineState),
      hub.events.on('hardware:audio', (status) => updateHardwareStatus(status)),
      hub.events.on('engine:masterMeter', updateMasterMeter),
      hub.events.on('engine:audioPathTelemetry', updateAudioPathTelemetry),
      hub.events.on('engine:audioRuntimeTelemetry', updateAudioRuntimeTelemetry),
      hub.events.on('master:changed', updateMasterState)
    );

    updateEngineState();
    // The engine client refreshes devices/device state once per engine run, so
    // opening this panel renders from that cache instead of issuing its own
    // round trip every time.
    if (hub.engine.deviceState) updateDeviceState(hub.engine.deviceState);
    if (hub.engine.masterMeter) updateMasterMeter(hub.engine.masterMeter);
    updateHardwareStatus(hub.hardware.audioStatus);
  }

  function updateMasterState(state) {
    if (!els.masterGain) return;
    const master = normalizeMasterOutput(state);
    els.masterGain.value = String(master.gainDb);
    els.masterGainValue.textContent = `${master.gainDb.toFixed(1)} dB`;
  }

  function updateMasterMeter(meter) {
    if (!els.meterLeft || !meter) return;
    const leftDb = Number.isFinite(Number(meter.peakLeftDb)) ? Number(meter.peakLeftDb) : -100;
    const rightDb = Number.isFinite(Number(meter.peakRightDb)) ? Number(meter.peakRightDb) : -100;
    const observation = meter.audioOutputObservation || {};
    els.meterLeft.style.width = `${meterPercent(leftDb)}%`;
    els.meterRight.style.width = `${meterPercent(rightDb)}%`;
    els.peakLeft.textContent = formatDb(leftDb);
    els.peakRight.textContent = formatDb(rightDb);
    els.clip.classList.toggle('active', meter.clip === true);
    els.clip.setAttribute('aria-pressed', meter.clip === true ? 'true' : 'false');
    els.preGainPeak.textContent = formatDb(Number(meter.preGainPeakDb));
    els.automaticGainReduction.textContent = meter.automaticGainReduction === true ? 'ON' : 'OFF';
    pathTelemetry.set('graph:audio-output', {
      ...observation, scope: 'graph', nodeId: 'audio-output', role: 'output',
      gainCoefficient: Number(meter.gainCoefficient) || 0,
      name: 'Audio Output', receivedAt: Date.now()
    });
    renderPathDiagnostics();
  }

  function updateAudioPathTelemetry(message) {
    if (!message?.nodeId) return;
    const key = `${message.scope || 'node'}:${message.nodeId}:${message.instanceId || ''}`;
    pathTelemetry.set(key, { ...message, receivedAt: Date.now() });
    renderPathDiagnostics();
  }

  function updateAudioRuntimeTelemetry(message) {
    if (!els.runtimeSummary || !message) return;
    const duration = Math.max(0, Number(message.callbackMilliseconds) || 0);
    const deadline = Math.max(0, Number(message.deadlineMilliseconds) || 0);
    const cpu = Math.max(0, Number(message.audioCpuPercent) || 0);
    const misses = Math.max(0, Number(message.totalDeadlineMisses) || 0);
    const underruns = Math.max(0, Number(message.totalEstimatedSchedulingUnderruns) || 0);
    els.runtimeSummary.textContent = `Callback ${duration.toFixed(2)} / ${deadline.toFixed(2)} ms · CPU ${cpu.toFixed(0)}% · deadline ${misses} · underrun est. ${underruns}`;
  }

  function renderPathDiagnostics() {
    if (!els.pathDiagnostics) return;
    const now = Date.now();
    const records = [...pathTelemetry.values()]
      .filter((record) => now - (record.receivedAt || now) < 5000)
      .sort((a, b) => String(a.nodeId).localeCompare(String(b.nodeId))
        || String(a.instanceId || '').localeCompare(String(b.instanceId || '')));
    els.pathDiagnostics.innerHTML = '';
    const append = (text, className = '') => {
      const cell = document.createElement('span');
      cell.textContent = text;
      if (className) cell.className = className;
      els.pathDiagnostics.appendChild(cell);
    };
    for (const label of ['Node / VST', 'Input', 'Output', 'Static gain', 'Auto GR', 'Maximum', 'Inputs'])
      append(label, 'node-safety-heading');
    if (!records.length) {
      const empty = document.createElement('span');
      empty.className = 'muted node-safety-empty';
      empty.textContent = 'No active audio node telemetry yet.';
      els.pathDiagnostics.appendChild(empty);
      return;
    }
    const peakDb = (gain) => formatDb(gain > 0 ? 20 * Math.log10(gain) : -100);
    for (const record of records) {
      const identity = record.instanceId
        ? `${record.name || record.nodeId} · ${record.instanceId}`
        : (record.name || record.nodeId);
      append(identity, 'node-safety-name');
      append(peakDb(Number(record.inputPeak) || 0), 'mono');
      append(peakDb(Number(record.outputPeak) || 0), 'mono');
      append((Number(record.gainCoefficient) || 0).toFixed(3), 'mono');
      append(record.automaticGainReduction === true ? 'ON' : 'OFF', 'mono');
      append(peakDb(Number(record.maximumObservedPeak) || 0), 'mono');
      append(Array.isArray(record.inputGainCoefficients)
        ? record.inputGainCoefficients.map((gain) => Number(gain).toFixed(3)).join(', ')
        : '—', 'mono');
    }
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
    if (selectedName && !devices.some((device) => device.name === selectedName)) {
      const unavailable = document.createElement('option');
      unavailable.value = selectedName;
      unavailable.textContent = `${selectedName} (preferred — unavailable)`;
      els.device.appendChild(unavailable);
    }
    els.device.value = selectedName || '';
  }

  async function applyConfig() {
    const deviceName = els.device.value;
    if (!deviceName) return;
    const sampleRate = Number(els.sampleRate.value);
    const bufferSize = Number(els.buffer.value);
    await hub.hardware.applyAudioPreference({ deviceName, sampleRate, bufferSize });
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

  function updateHardwareStatus(status) {
    if (!els.error || !status) return;
    if (status.state === 'preferred-unavailable') {
      els.error.textContent = 'Preferred output is unavailable; the current runtime device is unchanged.';
    } else if (status.state === 'restore-failed') {
      els.error.textContent = status.reason || 'Could not restore the preferred output.';
    } else if (status.state === 'restoring') {
      els.error.textContent = 'Restoring preferred audio output…';
    } else if (!hub.engine.deviceState?.error) {
      els.error.textContent = '';
    }
  }

  function mount(el) {
    container = el;
    hub.diagnostics.log(`audioOutput: mount devices=${hub.engine.devices.length} engine=${hub.engine.state}`);
    render();
  }

  function unmount() {
    subs.forEach((u) => u());
    subs = [];
    pathTelemetry.clear();
    container = null;
    els = {};
  }

  return {
    id: 'audio-output',
    name: 'Audio Output',
    navEntry: { label: 'Audio Output', icon: 'speaker', group: 'system', fixed: true },
    routingNode: {
      id: NODE_ID,
      name: 'Audio Output',
      type: 'audio-output',
      inputs: [{ id: 'audio-in', type: 'audio', label: 'AUDIO IN' }],
      outputs: []
    },
    mount,
    unmount
  };
}
