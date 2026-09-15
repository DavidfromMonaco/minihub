import { EventBus } from './eventBus.js';
import { SettingsStore } from './settingsStore.js';
import { ModuleSystem } from './moduleSystem.js';
import { Network } from './network.js';
import { NodeInstanceManager } from './nodeInstances.js';
import { MidiManager } from '../midi/midiManager.js';
import { EngineClient } from './engineClient.js';
import { createDiagnostics } from './diagnostics.js';
import { ControlBindingManager } from './controlBindings.js';
import { HardwareConfigManager } from './hardwareConfig.js';
import { ProjectManager, PROJECT_KEYS } from './projectManager.js';
import { SequencerController } from './sequencerController.js';
import { CommandBus } from './commandBus.js';

/**
 * Central Hub: the single seam through which modules interact with the app.
 * Exposes:
 *   events   - pub/sub bus (all cross-module communication)
 *   settings - persisted user settings
 *   midi     - MIDI device layer
 *   modules  - module registry (UI focus)
 *   network    - routing network (signal routing, independent of UI focus)
 *   engine   - native audio engine client (VST3 + audio device)
 *   nodes    - node instance manager
 *   commands - what a plugin on a CTRL OUT cable may command (commandBus.js)
 *   perform  - run writes that are played rather than authored
 */
export function createHub(api) {
  const events = new EventBus();
  const settings = new SettingsStore(api);
  const midi = new MidiManager(events, settings);
  const network = new Network(events, settings);
  const engine = new EngineClient(api, events, settings);
  const diagnostics = createDiagnostics(api);

  const hub = { events, settings, midi, network, engine, diagnostics, api };
  hub.hardware = new HardwareConfigManager(hub);
  // Both take the real hub: handing ModuleSystem a partial copy meant anything
  // it later needed (engine, nodes, diagnostics) was silently undefined.
  hub.modules = new ModuleSystem(hub);
  hub.control = new ControlBindingManager(hub);
  hub.nodes = new NodeInstanceManager(hub);
  hub.project = new ProjectManager(hub, api);
  hub.sequencer = new SequencerController(hub);

  // What a plugin commands is played, not authored (D-032). A step that turns a
  // mixer down writes the same keys a hand on the fader writes, so the writes
  // made inside `perform` are told apart here, at the one hook both go through:
  // no undo step, no "modified", and the settings file saved once afterwards
  // instead of once per step of a sequence. The history is still told what
  // moved, so that its idea of the present includes it (`absorb`).
  let performing = 0;
  const performedKeys = new Set();
  hub.perform = (fn) => {
    performing += 1;
    try {
      return typeof settings.coalescingSaves === 'function' ? settings.coalescingSaves(fn) : fn();
    } finally {
      performing -= 1;
      if (performing === 0 && performedKeys.size > 0) {
        const keys = [...performedKeys];
        performedKeys.clear();
        hub.history?.absorb?.(keys);
      }
    }
  };
  hub.commands = new CommandBus(hub);

  // One hook, two readers. `onSet` is the only place that sees every write, so
  // it is where "the project is dirty" and "that was an edit" are both decided
  // -- neither has to be wired into `nodeInstances.js` or `routingModule.js`.
  // `hub.history` appears later (app.js, once the project is on screen), so the
  // call is optional by construction rather than by accident.
  settings.onSet = (key, value) => {
    if (performing > 0) {
      performedKeys.add(key);
      return;
    }
    if (PROJECT_KEYS.includes(key)) hub.project.markDirty();
    hub.history?.observe?.(key, value);
  };

  return hub;
}
