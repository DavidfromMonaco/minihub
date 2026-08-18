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
import { isMiniLabName, isPerformanceInputName } from './midi/minilab.js';

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
  // EngineClient.init() resolves the current engine state and, when the engine
  // is up, pulls devices + device state + the VST3 registry once per engine
  // run. Modules read those cached values instead of each issuing their own
  // requests when they happen to be opened.
  hub.engine.init();
  const syncRouting = setupEngineSync(hub);
  // MIDI reaches the graph for the whole app lifetime, not just while the
  // MiniLab page happens to be mounted.
  setupMidiRouting(hub);
  // Replay persisted VST chains into the engine once it has a plugin registry
  // (engine restart / renderer reload leaves the engine with no chains).
  setupChainSync(hub, syncRouting);

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

/**
 * Restore the persisted port selection, correcting one specific stale case.
 *
 * A MiniLab exposes several inputs and only some of them carry what you play.
 * An earlier heuristic scored them all identically, so the first enumerated
 * port - the MCU/HUI control surface - could be persisted as "the" input, and
 * every key press was then filtered out as coming from an unselected device.
 *
 * Only a selection that PROVABLY cannot deliver notes is overridden; a working
 * choice (including a deliberate non-MiniLab one) is always left alone.
 */
function restoreSelection(hub) {
  let inId = hub.settings.get('selectedInputId');
  const outId = hub.settings.get('selectedOutputId');

  const persisted = inId ? hub.midi.getInput(inId) : null;
  if (persisted && isMiniLabName(persisted.name) && !isPerformanceInputName(persisted.name)) {
    const better = hub.midi.findMiniLabInputId();
    if (better && better !== inId) {
      hub.diagnostics.log(
        `midi: corrected stale input ${inId} ${JSON.stringify(persisted.name)}`
        + ` -> ${better} ${JSON.stringify((hub.midi.getInput(better) || {}).name || '?')}`
        + ' (previous port cannot send played notes)'
      );
      inId = better;
      hub.settings.set('selectedInputId', inId);
    }
  }

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
