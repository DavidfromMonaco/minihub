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
 * typed input/output ports) to become a routing node in the Hub's network.
 * Purely UI modules simply omit it.
 */
export class ModuleSystem {
  constructor(hub) {
    this.hub = hub;
    this.modules = new Map();
    this.activeId = null;
    this.container = null;
    // A module mounted beside the page area rather than in it: the Sequencer
    // above the page in the Hybrid 1 layout (ui/interfaceLayout.js).
    this.docked = null;
    // The page the page area falls back to when the one on screen is removed
    // under it (`unregister`). Set by app.js; null leaves the area empty.
    this.fallbackId = null;
  }

  get dockedId() {
    return this.docked?.id ?? null;
  }

  /**
   * Mount a module in a second container, beside the page area, until
   * `undock`. The page area keeps working as it always has; opening the docked
   * module there becomes a request to look at the dock instead, since one
   * module instance cannot be mounted twice.
   */
  dock(id, container) {
    const module = this.modules.get(id);
    if (!module || !container) return false;
    if (this.docked?.id === id && this.docked.container === container) return true;
    this.undock();
    if (this.activeId === id) return false;
    this.docked = { id, container };
    container.innerHTML = '';
    try {
      module.mount?.(container);
    } catch (err) {
      console.error(`[modules] dock failed for "${id}":`, err);
    }
    this.hub.events.emit('module:docked', id);
    return true;
  }

  undock() {
    const docked = this.docked;
    if (!docked) return false;
    this.docked = null;
    try {
      this.modules.get(docked.id)?.unmount?.();
    } catch (err) {
      console.error(`[modules] unmount failed for "${docked.id}":`, err);
    }
    docked.container.innerHTML = '';
    this.hub.events.emit('module:undocked', docked.id);
    return true;
  }

  register(module) {
    if (!module || typeof module.id !== 'string' || !module.id) {
      throw new Error('Module must have a string id');
    }
    if (this.modules.has(module.id)) {
      throw new Error(`Module already registered: ${module.id}`);
    }
    this.modules.set(module.id, module);
    if (module.routingNode && this.hub.network) {
      this.hub.network.addNode(module.routingNode);
    }
    if (typeof module.onRegister === 'function') {
      module.onRegister(this.hub);
    }
    this.hub.events.emit('module:registered', module);
  }

  activate(id, container) {
    const module = this.modules.get(id);
    if (!module) return false;
    // Already on screen, in the dock: nothing to mount, only to look at.
    if (this.docked?.id === id) {
      this.hub.events.emit('module:dock-shown', id);
      return false;
    }
    // A page opening another from its own container (the Sequencer's "Open
    // Patch Bay") must not land in the dock: the page area is the other one.
    if (container && this.docked && container === this.docked.container) container = this.container;
    if (container) this.container = container;
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

  /**
   * Bring a page on screen for a caller that holds no container.
   *
   * Every page mounts into the one shared `#content`, so the container the last
   * activation used IS the page area. An agent asking for the Patch Bay has no
   * element to pass, and handing it one would put the DOM into a file that owns
   * none. Answers true when the page is the one showing afterwards, including
   * when it already was -- to a caller, "it is on screen" is the whole question.
   */
  show(id) {
    if (this.docked?.id === id) return true;
    if (!this.modules.has(id) || (!this.container && this.activeId !== id)) return false;
    if (this.activeId === id) return true;
    return this.activate(id, this.container);
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
   * half of it: `register` added `routingNode` to the network but `unregister`
   * left it there, so every caller had to remember `hub.network.removeNode()`
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
    if (this.docked?.id === id) this.docked = null;
    this.modules.delete(id);
    if (module.routingNode && this.hub.network) {
      this.hub.network.removeNode(module.routingNode.id);
    }
    if (this.activeId === id) {
      this.activeId = null;
      this._replaceVanishedPage();
    }
    this.hub.events.emit('module:unregistered', id);
    return true;
  }

  /**
   * The page on screen was removed without anyone choosing where to go next.
   *
   * Reported by the author on 2026-09-27: a Ctrl+Z undoing a node's creation,
   * with its page open below the Sequencer, took the node away and left its
   * page drawn -- unmounted, answering nothing, for a node that no longer
   * existed. An agent deleting the node did the same.
   *
   * A microtask later, not at once: the page's own Delete button removes the
   * node and opens Home in the same click, and that choice is the caller's.
   * Only when nothing else was opened meanwhile does the fallback page come.
   */
  _replaceVanishedPage() {
    queueMicrotask(() => {
      if (this.activeId !== null || !this.container) return;
      if (this.fallbackId && this.modules.has(this.fallbackId)) this.activate(this.fallbackId, this.container);
      else this.container.innerHTML = '';
    });
  }
}
