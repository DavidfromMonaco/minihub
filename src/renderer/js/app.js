import { createHub } from './core/hub.js';
import { buildSidebar } from './ui/sidebar.js';
import { buildHeader } from './ui/header.js';
import { buildSettingsModal } from './ui/settingsModal.js';
import { homeModule } from './modules/home/homeModule.js';
import { createMiniLabModule } from './modules/minilab/minilabModule.js';
import { createRoutingModule } from './modules/routing/routingModule.js';
import { createAudioOutputModule } from './modules/audioOutput/audioOutputModule.js';
import { setupEngineSync } from './core/engineSync.js';
import { setupMidiRouting } from './core/midiRouting.js';
import { setupChainSync } from './core/chainSync.js';
import { BUILD_STAMP } from './core/buildStamp.js';

async function main() {
  const hub = createHub(window.hubAPI);
  hub.diagnostics.log('renderer: startup begin');
  hub.diagnostics.log(`renderer: build ${BUILD_STAMP.stamp}`);

  // Persisted settings (selected ports).
  await hub.settings.load();

  // Register modules — the sidebar auto-populates from these.
  hub.modules.register(homeModule);
  hub.modules.register(createMiniLabModule(hub));
  hub.modules.register(createRoutingModule(hub));
  // Native/system Audio Output node + editor (non-deletable, non-copyable).
  hub.modules.register(createAudioOutputModule(hub));

  // Restore persisted dynamic node instances (registers their modules +
  // routing nodes). Must run before restoring connections so nodes exist.
  await hub.nodes.load();

  // Restore persisted routing connections (nodes must exist first).
  hub.graph.restore(hub.settings.get('graphConnections'));

  // UI shell.
  const sidebarEl = document.getElementById('sidebar');
  const contentEl = document.getElementById('content');
  const statusEl = document.getElementById('device-status');
  const modalRoot = document.getElementById('modal-root');
  const settingsButton = document.getElementById('settings-button');

  buildSidebar(hub, sidebarEl, contentEl);
  buildHeader(hub, statusEl);
  buildSettingsModal(hub, modalRoot, settingsButton);

  // Native audio engine client + graph sync. Initialized BEFORE any module is
  // activated so event listeners are always registered before a command can
  // trigger a response (no missed events).
  hub.engine.init();
  const syncRouting = setupEngineSync(hub);
  // MIDI reaches the graph for the whole app lifetime, not just while the
  // MiniLab page happens to be mounted.
  setupMidiRouting(hub);
  // Replay persisted VST chains into the engine once it has a plugin registry
  // (engine restart / renderer reload leaves the engine with no chains).
  setupChainSync(hub, syncRouting);
  // Populate the real VST3 registry in the background so "+ Add VST" works.
  hub.diagnostics.log('renderer: requesting scanVst3');
  hub.engine.scanVst3();
  // Pre-populate the real device list centrally so the Audio Output module shows
  // devices immediately when opened (no wait for a mount-time request).
  hub.diagnostics.log('renderer: requesting listDevices');
  hub.engine.listDevices();
  hub.engine.getDeviceState();

  // Start on Home.
  hub.modules.activate('home', contentEl);

  // MIDI layer.
  await hub.midi.init();
  console.info('[midi] state:', hub.midi.state);

  // Restore previously selected ports.
  restoreSelection(hub);

  // If a MiniLab is present and nothing selected yet, auto-select its input.
  if (!hub.midi.selectedInputId && hub.midi.isMiniLabConnected()) {
    const id = hub.midi.findMiniLabInputId();
    if (id) {
      hub.midi.selectInput(id);
      hub.settings.set('selectedInputId', id);
    }
  }

  // Restore the persisted audio output configuration once the engine is ready.
  restoreAudioConfig(hub);
}

function restoreSelection(hub) {
  const inId = hub.settings.get('selectedInputId');
  const outId = hub.settings.get('selectedOutputId');
  if (inId) hub.midi.selectInput(inId);
  if (outId) hub.midi.selectOutput(outId);
}

function restoreAudioConfig(hub) {
  const cfg = hub.settings.get('audioOutputConfig');
  if (!cfg || !cfg.deviceName) return;
  const sampleRate = cfg.sampleRate || 48000;
  const bufferSize = cfg.bufferSize || 0;
  hub.engine.selectDevice({ name: cfg.deviceName }, sampleRate, bufferSize);
}

window.addEventListener('DOMContentLoaded', () => {
  main().catch((err) => {
    console.error('[app] fatal:', err);
    const content = document.getElementById('content');
    content.innerHTML =
      '<div class="panel"><p class="muted">Application failed to start. See console for details.</p></div>';
  });
});
