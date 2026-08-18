import { EventBus } from '../src/renderer/js/core/eventBus.js';
import { Graph } from '../src/renderer/js/core/graph.js';
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

/** A minimal Hub seam (events + settings + graph) for testing modules/core. */
export function makeHub(settingsData = {}) {
  const settings = mockSettings(settingsData);
  const events = new EventBus();
  const graph = new Graph(events, settings);
  return { events, settings, graph };
}

/** A full Hub seam including the module system and node instance manager. */
export function makeFullHub(settingsData = {}) {
  const settings = mockSettings(settingsData);
  const events = new EventBus();
  const graph = new Graph(events, settings);
  const modules = new ModuleSystem({ events, settings, graph });
  const nodes = new NodeInstanceManager({ events, settings, graph, modules });
  return { events, settings, graph, modules, nodes };
}
