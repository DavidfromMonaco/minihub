import { EventBus } from '../src/renderer/js/core/eventBus.js';
import { Network } from '../src/renderer/js/core/network.js';
import { ModuleSystem } from '../src/renderer/js/core/moduleSystem.js';
import { NodeInstanceManager } from '../src/renderer/js/core/nodeInstances.js';

/** In-memory settings store that mirrors the renderer SettingsStore API. */
export function mockSettings(initial = {}) {
  const data = { ...initial };
  return {
    data,
    get(key) {
    return data[key];
    },
    async set(key, value) {
      data[key] = value;
    }
  };
}

/** A minimal Hub seam (events + settings + network) for testing modules/core. */
export function makeHub(settingsData = {}) {
  const settings = mockSettings(settingsData);
  const events = new EventBus();
  const network = new Network(events, settings);
  return { events, settings, network };
}

/** A full Hub seam including the module system and node instance manager. */
export function makeFullHub(settingsData = {}) {
  const settings = mockSettings(settingsData);
  const events = new EventBus();
  const network = new Network(events, settings);
  const modules = new ModuleSystem({ events, settings, network });
  const nodes = new NodeInstanceManager({ events, settings, network, modules });
  return { events, settings, network, modules, nodes };
}
