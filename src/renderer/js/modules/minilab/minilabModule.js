import { describeMessage, noteName } from '../../midi/parseMidi.js';
import { MINILAB_CONTROL_SOURCES } from '../../midi/minilabControls.js';
import { MINILAB_SURFACE } from '../../ui/miniLabControlSurface.js';
import { controllerProfileSectionHtml, bindControllerProfileSection } from '../../ui/controllerProfileSection.js';
import { escapeHtml } from '../../core/html.js';
import { MINILAB_NODE_ID } from '../../core/systemNodes.js';
import { LOADED_PROFILE } from '../../midi/loadedProfile.js';

/**
 * What the user calls the thing on his desk, and the only place in `src/` that
 * reads it. The header, the sequencer's blocking messages and the Learn panel
 * all name the device from the routing node below (`core/controllerNode.js`),
 * so this constant is the single point where a profile becomes a name on
 * screen -- and the whole application follows a profile that says something
 * else with nothing else edited.
 *
 * `device.model` rather than the profile's `name`: the profile is titled
 * "Arturia MiniLab 3", which is the file's name for itself and may carry a
 * variant or a vendor, while a Patch Bay card and a status pill have room for
 * the device. Both fields are required by the format, so neither can be
 * absent.
 */
const DEVICE_NAME = LOADED_PROFILE.device.model;

const KEY_BASE = 36; // C2 — 25 keys up to C4, matching the MiniLab 3
const KEY_COUNT = 25;
const MONITOR_MAX = 120;
const BLACK_NOTES = new Set([1, 3, 6, 8, 10]);

function isBlack(note) {
  return BLACK_NOTES.has(note % 12);
}

/**
 * MiniLab 3 panel: connection, device info, live activity and monitor.
 */
export function createMiniLabModule(hub) {
  let container = null;
  let subs = [];
  let els = {};
  let keyEls = [];
  let activeNotes = new Map(); // note -> velocity
  let monitor = [];
  let lastMsg = null;
  let msgCount = 0;
  // What main last reported about the profiles folder, plus whatever the last
  // action had to say. Held across renders, because a message that vanishes
  // with the redraw that follows it is a message nobody reads.
  let profiles = { selected: null, profiles: [], faults: [], message: null };

  // ---------- rendering ----------

  function render() {
    container.innerHTML = `
      <div class="panel">
        <div class="row">
          <h1 class="page-title">${escapeHtml(DEVICE_NAME)}</h1>
          <span class="spacer"></span>
          <span id="ml-status" class="pill off">No ${escapeHtml(DEVICE_NAME)} detected</span>
        </div>
      </div>

      <div class="grid grid-2 mt-16">
        <div>
          <div class="panel">
            <h2 class="panel-title">Connection</h2>
            <div class="field">
              <label for="ml-input">MIDI Input</label>
              <select id="ml-input" class="select"></select>
            </div>
            <div class="field mt-12">
              <label for="ml-output">MIDI Output</label>
              <select id="ml-output" class="select"></select>
            </div>
            <div class="row mt-14">
              <button id="ml-connect" class="btn primary">Connect</button>
              <button id="ml-disconnect" class="btn">Disconnect</button>
            </div>
          </div>

          <div class="panel">
            <h2 class="panel-title">Device</h2>
            <div class="stat">
              <span class="stat-label">Name</span>
              <span id="ml-name" class="stat-value mono">—</span>
            </div>
            <div class="stat mt-10">
              <span class="stat-label">Manufacturer</span>
              <span id="ml-manufacturer" class="stat-value">—</span>
            </div>
            <div class="row mt-14">
              <div class="stat">
                <span class="stat-label">Channel</span>
                <span id="ml-channel" class="stat-value mono">—</span>
              </div>
              <div class="stat">
                <span class="stat-label">Messages</span>
                <span id="ml-count" class="stat-value mono">0</span>
              </div>
            </div>
          </div>

          <div class="panel">
            <h2 class="panel-title">MIDI Timing Compensation</h2>
            <div class="row">
              <input id="ml-offset-range" class="range" type="range" min="-200" max="200" step="1" value="0" />
              <span id="ml-offset-value" class="offset-value">0 ms</span>
            </div>
            <p class="offset-hint mt-10">Applies to the selected input. Negative = earlier, positive = later.</p>
            <div class="row mt-10">
              <span class="spacer"></span>
              <button id="ml-offset-reset" class="btn">Reset to 0 ms</button>
            </div>
          </div>
        </div>

        <div>
          <div class="panel">
            <h2 class="panel-title">Keyboard</h2>
            <div id="ml-keyboard" class="keyboard"></div>
          </div>
          <div class="panel">
            <h2 class="panel-title">Last event</h2>
            <div id="ml-last" class="last-event">
              <span class="muted">No events received yet</span>
            </div>
          </div>
          <div class="panel" id="ml-profile">
            <h2 class="panel-title">Profile</h2>
            ${controllerProfileSectionHtml(profiles)}
          </div>
        </div>
      </div>

      <div class="panel mt-16">
        <h2 class="panel-title">MIDI monitor</h2>
        <div id="ml-monitor" class="monitor"></div>
      </div>`;

    els = {
      status: container.querySelector('#ml-status'),
      input: container.querySelector('#ml-input'),
      output: container.querySelector('#ml-output'),
      connect: container.querySelector('#ml-connect'),
      disconnect: container.querySelector('#ml-disconnect'),
      name: container.querySelector('#ml-name'),
      manufacturer: container.querySelector('#ml-manufacturer'),
      channel: container.querySelector('#ml-channel'),
      count: container.querySelector('#ml-count'),
      keyboard: container.querySelector('#ml-keyboard'),
      last: container.querySelector('#ml-last'),
      monitor: container.querySelector('#ml-monitor'),
      offsetRange: container.querySelector('#ml-offset-range'),
      offsetValue: container.querySelector('#ml-offset-value'),
      offsetReset: container.querySelector('#ml-offset-reset')
    };

    buildKeyboard();
    els.input.addEventListener('change', () => onInputSelect());
    els.output.addEventListener('change', () => onOutputSelect());
    els.connect.addEventListener('click', connect);
    els.disconnect.addEventListener('click', disconnect);
    els.offsetRange.addEventListener('input', onOffsetChange);
    els.offsetReset.addEventListener('click', onOffsetReset);
    // The controller's own page is where a keyboard is changed, so the profile
    // section is bound here rather than in Settings. See controllerProfileSection.js.
    bindControllerProfileSection(container, hub, { refresh: refreshProfiles });

    refreshPorts();
    refreshTiming();
  }

  function buildKeyboard() {
    keyEls = [];
    els.keyboard.innerHTML = '';
    for (let i = 0; i < KEY_COUNT; i++) {
      const note = KEY_BASE + i;
      const key = document.createElement('div');
      key.className = 'key' + (isBlack(note) ? ' black' : '');
      key.title = noteName(note);
      key.dataset.note = note;
      els.keyboard.appendChild(key);
      keyEls.push(key);
    }
  }

  // ---------- connection ----------

  function refreshPorts() {
    const inputs = hub.midi.listInputs();
    const outputs = hub.midi.listOutputs();
    const preference = hub.midi.inputPreferenceStatus();
    const unavailableLabel = preference.preference && !preference.available
      ? `— ${preference.preference.name || preference.preference.id} (preferred — unavailable) —`
      : '— No input —';

    fillSelect(els.input, inputs, hub.midi.selectedInputId, unavailableLabel);
    fillSelect(els.output, outputs, hub.midi.selectedOutputId, '— No output —');

    const connected = hub.midi.selectedInputId !== null;
    els.connect.disabled = connected;
    els.disconnect.disabled = !connected;

    const input = hub.midi.getInput(hub.midi.selectedInputId);
    els.name.textContent = input ? input.name : '—';
    els.manufacturer.textContent = input && input.manufacturer ? input.manufacturer : '—';

    const anyMiniLab = hub.midi.isMiniLabConnected();
    const preferredUnavailable = preference.preference && !preference.available;
    els.status.textContent = preferredUnavailable
      ? 'Preferred MIDI input unavailable'
      : (anyMiniLab ? `${DEVICE_NAME} detected` : `No ${DEVICE_NAME} detected`);
    els.status.className = 'pill ' + (anyMiniLab && !preferredUnavailable ? 'ok' : 'off');

    refreshTiming();
  }

  // ---------- timing compensation ----------

  function formatOffset(ms) {
    if (ms > 0) return `+${ms} ms`;
    if (ms < 0) return `${ms} ms`;
    return '0 ms';
  }

  function refreshTiming() {
    const inputId = hub.midi.selectedInputId;
    const disabled = !inputId;
    els.offsetRange.disabled = disabled;
    els.offsetReset.disabled = disabled;
    const ms = inputId ? hub.midi.getInputOffset(inputId) : 0;
    els.offsetRange.value = String(ms);
    els.offsetValue.textContent = formatOffset(ms);
  }

  function onOffsetChange() {
    const inputId = hub.midi.selectedInputId;
    if (!inputId) return;
    const ms = Number(els.offsetRange.value);
    els.offsetValue.textContent = formatOffset(ms);
    hub.midi.setInputOffset(inputId, ms);
  }

  function onOffsetReset() {
    const inputId = hub.midi.selectedInputId;
    if (!inputId) return;
    els.offsetRange.value = '0';
    els.offsetValue.textContent = '0 ms';
    hub.midi.setInputOffset(inputId, 0);
  }

  function fillSelect(select, ports, selectedId, emptyLabel) {
    select.innerHTML = '';
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = emptyLabel;
    select.appendChild(empty);

    ports.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      select.appendChild(opt);
    });

    select.value = selectedId || '';
  }

  function onInputSelect() {
    const id = els.input.value || null;
    hub.midi.selectInput(id, { remember: true });
    refreshPorts();
  }

  function onOutputSelect() {
    const id = els.output.value || null;
    hub.midi.selectOutput(id);
    hub.settings.set('selectedOutputId', id);
    refreshPorts();
  }

  function connect() {
    const id = hub.midi.findMiniLabInputId() || hub.midi.listInputs()[0]?.id || null;
    hub.midi.selectInput(id, { remember: true });
    refreshPorts();
  }

  function disconnect() {
    hub.midi.selectInput(null, { remember: true });
    refreshPorts();
  }

  // ---------- live activity ----------

  function onMessage(msg) {
    msgCount++;
    lastMsg = msg;

    if (msg.type === 'noteon') activeNotes.set(msg.note, msg.velocity);
    else if (msg.type === 'noteoff') activeNotes.delete(msg.note);
    updateKeyboard();

    els.channel.textContent = String(msg.channel);
    els.count.textContent = String(msgCount);
    renderLastEvent(msg);
    pushMonitor(msg);
    // Routing is NOT done here: `core/midiRouting.js` feeds the network for the
    // whole app lifetime, so MIDI keeps flowing when this page is not visible.
  }

  function updateKeyboard() {
    keyEls.forEach((key, i) => {
      const note = KEY_BASE + i;
      key.classList.toggle('on', activeNotes.has(note));
    });
  }

  function renderLastEvent(msg) {
    const time = new Date().toLocaleTimeString();
    els.last.innerHTML = `
      <div class="big">${describeMessage(msg)}</div>
      <div class="sub">ch ${msg.channel} · ${escapeHtml(msg.sourceName || 'unknown')} · ${time}</div>`;
  }

  function pushMonitor(msg) {
    const time = new Date().toLocaleTimeString([], { hour12: false });
    monitor.unshift({ time, msg });
    if (monitor.length > MONITOR_MAX) monitor.length = MONITOR_MAX;

    const row = document.createElement('div');
    row.className = 'monitor-row fresh';
    row.innerHTML = `
      <span class="time">${time}</span>
      <span class="ch">ch${String(msg.channel).padStart(2, '0')}</span>
      <span class="type">${msg.type}</span>
      <span class="data">${describeMessage(msg)}</span>`;
    els.monitor.prepend(row);

    // Trim DOM rows.
    while (els.monitor.children.length > MONITOR_MAX) {
      els.monitor.lastChild.remove();
    }
  }

  /**
   * Re-read the profiles folder and redraw the page.
   *
   * `outcome` carries what the action that triggered this had to say -- a
   * refusal with its faults, or a confirmation -- and it survives the round trip
   * to main on purpose: the redraw would otherwise wipe the only thing the user
   * has to read. A folder that cannot be listed leaves the built-in profile
   * showing, which is still true and still works.
   */
  async function refreshProfiles(outcome = {}) {
    let listed = { selected: null, profiles: [] };
    try {
      listed = (await hub.api.profileList?.()) || listed;
    } catch (_) { /* the built-in profile is still the one running */ }
    profiles = { ...listed, faults: outcome.faults || [], message: outcome.message || null };
    if (container) render();
  }

  // ---------- lifecycle ----------

  function mount(el) {
    container = el;
    // Drawn once without the folder rather than left blank while the IPC round
    // trip completes; the list fills in a tick later.
    render();
    refreshProfiles();
    subs.push(
      hub.events.on('midi:ports', refreshPorts),
      hub.events.on('midi:message', onMessage),
      hub.events.on('midi:offset', refreshTiming)
    );
  }

  function unmount() {
    subs.forEach((u) => u());
    subs = [];
    activeNotes.clear();
    monitor = [];
    lastMsg = null;
    container = null;
    els = {};
    keyEls = [];
  }

  return {
    id: 'minilab',
    name: DEVICE_NAME,
    navEntry: { label: DEVICE_NAME, icon: 'keyboard', group: 'system', fixed: true },
    routingNode: {
      id: MINILAB_NODE_ID,
      name: DEVICE_NAME,
      type: 'midi-output',
      surface: MINILAB_SURFACE,
      inputs: [
        { id: 'midi-in', type: 'midi', label: 'Hardware MIDI In' }
      ],
      outputs: [
        { id: 'midi-out', type: 'midi', label: 'MIDI Out' },
        ...MINILAB_CONTROL_SOURCES.map((source) => ({
          id: source.portId,
          type: 'control',
          label: source.label
        }))
      ],
      onInput: (portId, data) => {
        if (portId !== 'midi-in' || !Array.isArray(data?.raw)) return;
        hub.midi?.send(data.raw);
      }
    },
    mount,
    unmount
  };
}
