import { createHub } from './core/hub.js';
import { buildSidebar } from './ui/sidebar.js';
import { buildHeader } from './ui/header.js';
import { buildSettingsModal } from './ui/settingsModal.js';
import { createHomeModule } from './modules/home/homeModule.js';
import { createMiniLabModule } from './modules/minilab/minilabModule.js';
import { createRoutingModule } from './modules/routing/routingModule.js';
import { createAudioOutputModule } from './modules/audioOutput/audioOutputModule.js';
import { createSequencerModule } from './modules/sequencer/sequencerModule.js';
// Imported for its side effect: the module registers the Preset node editor
// in core/nodeEditors.js. A node type needs no other wiring here.
import './modules/presets/presetEditor.js';
import { setupEngineSync } from './core/engineSync.js';
import { setupMasterOutput } from './core/masterOutput.js';
import { setupMidiRouting } from './core/midiRouting.js';
import { setupControlRouting } from './core/controlRouting.js';
import { setupChainSync } from './core/chainSync.js';
import { BUILD_STAMP } from './core/buildStamp.js';

async function main() {
  const hub = createHub(window.hubAPI);
  const mark = (name) => hub.diagnostics.log(`startup:${name} rendererMs=${Math.round(performance.now())}`);
  mark('renderer-main-start');
  hub.diagnostics.log('renderer: startup begin');
  hub.diagnostics.log(`renderer: build ${BUILD_STAMP.stamp}`);

  // Persisted settings (selected ports).
  mark('settings-load-start');
  await hub.settings.load();
  mark('settings-load-complete');
  mark('recent-project-lookup');
  mark('project-manager-init-start');
  hub.project.bootstrap();
  mark('project-manager-init-complete');

  // Register modules — the sidebar auto-populates from these.
  hub.modules.register(createHomeModule(hub));
  hub.modules.register(createMiniLabModule(hub));
  hub.modules.register(createRoutingModule(hub));
  // Native/system Audio Output node + editor (non-deletable, non-copyable).
  hub.modules.register(createAudioOutputModule(hub));
  hub.sequencer.load();
  hub.modules.register(createSequencerModule(hub));

  // Restore persisted dynamic node instances (registers their modules +
  // routing nodes). Must run before restoring connections so nodes exist.
  await hub.nodes.load();

  // Restore persisted routing connections (nodes must exist first).
  hub.graph.restore(hub.settings.get('graphConnections'));
  // The first Sequencer publication happened before the Patch Bay cables were
  // restored. Republish now so persisted per-track destinations are audible
  // even when the native engine was already running before this renderer.
  hub.sequencer.syncNative();
  hub.project.finishBootstrap();

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
  setupMasterOutput(hub);
  const syncRouting = setupEngineSync(hub);
  // MIDI reaches the graph for the whole app lifetime, not just while the
  // MiniLab page happens to be mounted.
  setupMidiRouting(hub);
  setupControlRouting(hub);
  // Replay persisted VST chains into the engine once it has a plugin registry
  // (engine restart / renderer reload leaves the engine with no chains).
  setupChainSync(hub, syncRouting);

  // A successfully created/loaded project opens its workspace. Ordinary cold
  // launch still starts on Home and does not restore the recent project.
  hub.modules.activate(hub.project.initialModule || 'home', contentEl);
  mark('home-first-render');

  // MIDI layer.
  await hub.midi.init();
  console.info('[midi] state:', hub.midi.state);

  // Input restoration occurs inside port enumeration so startup and hot-plug
  // use the same stable-identity path. With no preference, select the best
  // MiniLab performance port once and remember it.
  hub.midi.autoSelectMiniLabInput();
  const outId = hub.settings.get('selectedOutputId');
  if (outId) hub.midi.selectOutput(outId);
}

window.addEventListener('DOMContentLoaded', () => {
  main().catch((err) => {
    console.error('[app] fatal:', err);
    const content = document.getElementById('content');
    content.innerHTML =
      '<div class="panel"><p class="muted">Application failed to start. See console for details.</p></div>';
  });
});
