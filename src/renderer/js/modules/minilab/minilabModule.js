import { describeMessage } from '../../midi/parseMidi.js';
import { controlSourcesOfNode } from '../../midi/minilabControls.js';
import { surfaceOfNode } from '../../ui/miniLabControlSurface.js';
import { controllerProfileSectionHtml, bindControllerProfileSection } from '../../ui/controllerProfileSection.js';
import { escapeHtml } from '../../core/html.js';
import { LOADED_PROFILE } from '../../midi/loadedProfile.js';
import { CONTROLLER_NODE_IDS } from '../../core/systemNodes.js';

const MONITOR_MAX = 120;

/**
 * One controller's panel: connection, device info, live activity and monitor.
 *
 * ONE PER LOADED PROFILE, and that is the whole of step 5 of
 * `plans/active/two-controllers-at-once.md`. `app.js` calls this once per entry
 * in `LOADED_PROFILES`, so two keyboards are two pages, two sidebar entries and
 * two routing nodes -- not one page with a switch on it, which would be the
 * "primary controller" the plan puts out of scope.
 *
 * The module's own id is `controller-<profileId>`. It used to be the literal
 * `'minilab'`, which cannot be two things at once and was a device word inside a
 * page id besides.
 *
 * `profile` is a parameter and not a module-level read, for the reason
 * `resolveProfiles` is exported: a constant fixed at module load is a constant
 * no test can swap, and "this draws any keyboard" would be a claim rather than
 * something that runs.
 *
 * `DEVICE_NAME` is `device.model` rather than the profile's `name`: the profile
 * is titled "Arturia MiniLab 3", which is the file's name for itself and may
 * carry a variant or a vendor, while a Patch Bay card and a status pill have
 * room for the device. Both fields are required by the format, so neither can
 * be absent. It is the single point where a profile becomes a name on screen --
 * everything else asks the routing node (`core/controllerNode.js`).
 */
export function createMiniLabModule(hub, profile = LOADED_PROFILE) {
  const DEVICE_NAME = profile.device.model;
  const NODE_ID = profile.profileId;
  // The PAGE id, deliberately not the node id. `test/profileImport.test.mjs`
  // pins that they differ, and the reason is a bug: the shell used to spell a
  // page id, `ModuleSystem.activate()` answers false for an unknown one WITHOUT
  // saying so, and the button was dead. Keeping the two strings apart is what
  // stops `activate(node.id)` from being written somewhere and appearing to work.
  const PAGE_ID = `controller-${profile.profileId}`;
  let container = null;
  let subs = [];
  let els = {};
  let monitor = [];
  let lastMsg = null;
  let msgCount = 0;
  let signalTimer = null;
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
          <!-- Lit by anything this keyboard sends. The drawn keyboard below is
               approximate on purpose -- it is 25 keys from C2 whatever the
               device -- and making it exact would be a lot of work for a
               question the user is really asking about the CABLE: is the signal
               arriving? A lamp answers that, on any hardware, exactly. -->
          <span id="ml-signal" class="signal-led" role="status"
                aria-label="Signal from ${escapeHtml(DEVICE_NAME)}"
                title="Lights up when ${escapeHtml(DEVICE_NAME)} sends"></span>
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
      last: container.querySelector('#ml-last'),
      monitor: container.querySelector('#ml-monitor'),
      offsetRange: container.querySelector('#ml-offset-range'),
      offsetValue: container.querySelector('#ml-offset-value'),
      offsetReset: container.querySelector('#ml-offset-reset')
    };

    els.input.addEventListener('change', () => onInputSelect());
    els.output.addEventListener('change', () => onOutputSelect());
    els.connect.addEventListener('click', connect);
    els.disconnect.addEventListener('click', disconnect);
    els.offsetRange.addEventListener('input', onOffsetChange);
    els.offsetReset.addEventListener('click', onOffsetReset);
    // The controller's own page is where a keyboard is changed, so the profile
    // section is bound here rather than in Settings. See controllerProfileSection.js.
    // The window has to reload for a profile change; the project does not have
    // to be lost with it. `reloadKeepingProject` stages the open project through
    // the same handoff a project switch uses, so the reload comes back to it.
    bindControllerProfileSection(container, hub, {
      refresh: refreshProfiles,
      reload: () => (hub.project?.reloadKeepingProject
        ? hub.project.reloadKeepingProject()
        : globalThis.location?.reload())
    });

    refreshPorts();
    refreshTiming();
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

    // THIS keyboard, not any keyboard: `midiManager` arms one cable per loaded
    // profile, so an armed port is this device answering. `isMiniLabConnected()`
    // asks whether anything on the desk looks like a MiniLab, which on a page
    // named after a second controller is a sentence about the wrong hardware.
    // It stays as the fallback for a manager that predates the arming.
    const anyMiniLab = hub.midi.armedInputFor
      ? hub.midi.armedInputFor(NODE_ID) !== null
      : hub.midi.isMiniLabConnected();
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

  /**
   * This keyboard's messages, not the desk's.
   *
   * `midi:message` carries every armed cable, and `midiManager` stamps the
   * profile it came from. Without this filter the MiniLab's page counted the
   * BeatStep's notes, lit its keys and printed its CCs in the monitor -- one
   * page reporting two instruments, with nothing saying so.
   *
   * A message with no stamp arrived on a port no loaded profile claims: the user
   * selected a keyboard MiniHub has no profile for. It goes to the first
   * controller's page, which is where `core/midiRouting.js` sends it too.
   */
  function isMine(msg) {
    return (msg?.profileId ?? CONTROLLER_NODE_IDS[0]) === NODE_ID;
  }

  /** A lamp, lit by any message and fading on its own. Set from the CSSOM via a
   *  class: `style-src 'self'` drops an inline style attribute in silence. */
  function flashSignal() {
    if (!els.signal) return;
    els.signal.classList.add('lit');
    clearTimeout(signalTimer);
    signalTimer = setTimeout(() => els.signal?.classList.remove('lit'), 180);
  }

  function onMessage(msg) {
    if (!isMine(msg)) return;
    msgCount++;
    lastMsg = msg;
    flashSignal();

    els.channel.textContent = String(msg.channel);
    els.count.textContent = String(msgCount);
    renderLastEvent(msg);
    pushMonitor(msg);
    // Routing is NOT done here: `core/midiRouting.js` feeds the network for the
    // whole app lifetime, so MIDI keeps flowing when this page is not visible.
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
    // Invariant 8: a timer that outlives the page would reach into the next
    // module's DOM, since `#content` is shared.
    clearTimeout(signalTimer);
    signalTimer = null;
    monitor = [];
    lastMsg = null;
    container = null;
    els = {};
  }

  return {
    id: PAGE_ID,
    name: DEVICE_NAME,
    navEntry: { label: DEVICE_NAME, icon: 'keyboard', group: 'system', fixed: true },
    routingNode: {
      id: NODE_ID,
      name: DEVICE_NAME,
      type: 'midi-output',
      surface: surfaceOfNode(NODE_ID),
      inputs: [
        { id: 'midi-in', type: 'midi', label: 'Hardware MIDI In' }
      ],
      outputs: [
        { id: 'midi-out', type: 'midi', label: 'MIDI Out' },
        ...controlSourcesOfNode(NODE_ID).map((source) => ({
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
    unmount,
    // Exposed for the same reason `routingModule` exposes `isRearView()`: the
    // DOM shim does not parse innerHTML, so a mounted page cannot be inspected,
    // and "this page ignores the other keyboard" would be a claim rather than
    // something that runs.
    handlesMessage: isMine
  };
}
