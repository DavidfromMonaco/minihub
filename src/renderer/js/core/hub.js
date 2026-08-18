import { EventBus } from './eventBus.js';
import { SettingsStore } from './settingsStore.js';
import { ModuleSystem } from './moduleSystem.js';
import { Graph } from './graph.js';
import { NodeInstanceManager } from './nodeInstances.js';
import { MidiManager } from '../midi/midiManager.js';
import { EngineClient } from './engineClient.js';
import { createDiagnostics } from './diagnostics.js';

/**
 * Central Hub: the single seam through which modules interact with the app.
 * Exposes:
 *   events   - pub/sub bus (all cross-module communication)
 *   settings - persisted user settings
 *   midi     - MIDI device layer
 *   modules  - module registry (UI focus)
 *   graph    - routing graph (signal routing, independent of UI focus)
 *   engine   - native audio engine client (VST3 + audio device)
 *   nodes    - node instance manager
 */
export function createHub(api) {
  const events = new EventBus();
  const settings = new SettingsStore(api);
  const midi = new MidiManager(events, settings);
  const graph = new Graph(events, settings);
  const engine = new EngineClient(api, events, settings);
  const diagnostics = createDiagnostics(api);

  const hub = { events, settings, midi, graph, engine, diagnostics };
  // Both take the real hub: handing ModuleSystem a partial copy meant anything
  // it later needed (engine, nodes, diagnostics) was silently undefined.
  hub.modules = new ModuleSystem(hub);
  hub.nodes = new NodeInstanceManager(hub);

  return hub;
}
