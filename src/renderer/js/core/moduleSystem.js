/**
 * Module registry.
 *
 * A module is a plain object with:
 *   id        - unique string id
 *   name      - display name
 *   navEntry  - optional { label, icon } to appear in the sidebar
 *   mount(container)  - called when the module becomes active
 *   unmount()         - called when the module is deactivated
 *   onRegister(hub)   - optional, called once at registration time
 *
 * Future modules (sequencer, VST library, etc.) register themselves here and
 * the sidebar auto-populates — no shell changes required.
 *
 * A module may optionally declare `routingNode` (a node descriptor with
 * typed input/output ports) to become a routing node in the Hub's graph.
 * Purely UI modules simply omit it.
 */
export class ModuleSystem {
  constructor(hub) {
    this.hub = hub;
    this.modules = new Map();
    this.activeId = null;
  }

  register(module) {
    if (!module || typeof module.id !== 'string' || !module.id) {
      throw new Error('Module must have a string id');
    }
    if (this.modules.has(module.id)) {
      throw new Error(`Module already registered: ${module.id}`);
    }
    this.modules.set(module.id, module);
    if (module.routingNode && this.hub.graph) {
      this.hub.graph.addNode(module.routingNode);
    }
    if (typeof module.onRegister === 'function') {
      module.onRegister(this.hub);
    }
    this.hub.events.emit('module:registered', module);
  }

  activate(id, container) {
    const module = this.modules.get(id);
    if (!module) return false;
    if (this.activeId === id) return false;

    const current = this.modules.get(this.activeId);
    if (current && typeof current.unmount === 'function') {
      try {
        current.unmount();
      } catch (err) {
        console.error(`[modules] unmount failed for "${current.id}":`, err);
      }
    }

    this.activeId = id;

    if (container) {
      container.innerHTML = '';
      if (typeof module.mount === 'function') {
        try {
          module.mount(container);
        } catch (err) {
          console.error(`[modules] mount failed for "${id}":`, err);
          container.innerHTML =
            '<div class="panel"><p class="muted">Module failed to load. See console for details.</p></div>';
        }
      }
    }

    this.hub.events.emit('module:activated', id);
    return true;
  }

  get(id) {
    return this.modules.get(id);
  }

  list() {
    return [...this.modules.values()];
  }

  /**
   * Remove a module (e.g. a deleted dynamic node instance).
   *
   * Exactly undoes `register`, routing node included. It used to undo only
   * half of it: `register` added `routingNode` to the graph but `unregister`
   * left it there, so every caller had to remember `hub.graph.removeNode()`
   * separately. Forgetting it leaves a node with no module behind it — still
   * drawn in the Patch Bay, still cabled, still published to the native engine,
   * and impossible to open.
   */
  unregister(id) {
    const module = this.modules.get(id);
    if (!module) return false;
    if (typeof module.unmount === 'function') {
      try {
        module.unmount();
      } catch (err) {
        console.error(`[modules] unmount failed for "${id}":`, err);
      }
    }
    this.modules.delete(id);
    if (module.routingNode && this.hub.graph) {
      this.hub.graph.removeNode(module.routingNode.id);
    }
    if (this.activeId === id) this.activeId = null;
    this.hub.events.emit('module:unregistered', id);
    return true;
  }
}
