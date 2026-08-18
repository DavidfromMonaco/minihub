/**
 * Node Instance Manager.
 *
 * Manages user-created node instances (e.g. "VST 1", "Video 1"). Each instance
 * is a thin object:
 *
 *   { id, type, name, content }
 *
 * `type` is immutable (from the Node Type Registry); `content` is reserved for
 * future loading. For VST nodes, content is the internal plugin chain
 * `{ plugins: [] }` (see vstChain.js); other types keep `content: null` for now.
 *
 * Instances are persisted separately under the `nodeInstances` settings key
 * (with a per-type monotonic counter so IDs are never reused after deletion).
 * They integrate with the Hub by registering a module (sidebar entry + editor
 * shell) and a routing node in `hub.graph`.
 *
 * VST nodes now connect their internal plugin chain to the native engine:
 * every chain operation (add / remove / reorder / bypass) is synchronized to
 * the engine, and MIDI reaching a VST node through the graph is forwarded to
 * the engine for that chain. The Patch Bay still sees the complete VST chain as
 * ONE VST node — individual plugins never enter `hub.graph`.
 *
 * Responsibilities are kept separate: `nodeInstances` owns instances,
 * `graphLayout` owns positions, `graphConnections` owns routing.
 */
import { getNodeType } from './nodeTypes.js';
import { GraphLayout } from './graphLayout.js';
import { VstChain, getVstRole, duplicateVstContent } from './vstChain.js';
import { escapeHtml } from './html.js';

const KEY = 'nodeInstances';

function renderGenericShell(instance, type) {
  return `
    <div class="panel">
      <div class="row">
        <h1 class="page-title">${escapeHtml(instance.name)}</h1>
        <span class="spacer"></span>
        <span class="pill accent-${type.id}">${type.label}</span>
      </div>
      <div class="panel mt-16">
        <h2 class="panel-title">Content</h2>
        <p class="muted m-0">${type.emptyLabel}</p>
      </div>
      <div class="row mt-16">
        <span class="spacer"></span>
        <button id="node-delete" class="btn danger">Delete Node</button>
      </div>
    </div>`;
}

function renderPluginCard(plugin, status, editorNote) {
  const role = getVstRole(plugin.role);
  const st = plugin.bypassed ? 'bypassed' : (status || 'ready');
  const note = editorNote ? `<span class="plugin-editor-note">${escapeHtml(editorNote)}</span>` : '';
  return `
    <div class="plugin-card role-${role.id}" data-plugin-id="${escapeHtml(plugin.id)}">
      <span class="plugin-role-dot"></span>
      <span class="plugin-name">${escapeHtml(plugin.name)}</span>
      <span class="plugin-role-badge">${role.badge}</span>
      <span class="plugin-status status-${st}">${st}</span>
      ${note}
      <span class="plugin-actions">
        <button class="btn btn-sm plugin-action" data-action="open" title="Open native plugin editor">Open Plugin</button>
        <button class="btn btn-sm plugin-action" data-action="bypass">${plugin.bypassed ? 'Unbypass' : 'Bypass'}</button>
        <button class="btn btn-sm plugin-action" data-action="up" title="Move up">↑</button>
        <button class="btn btn-sm plugin-action" data-action="down" title="Move down">↓</button>
        <button class="btn btn-sm plugin-action" data-action="remove">Remove</button>
      </span>
    </div>`;
}

function renderChain(plugins, statusMap, editorNotes) {
  if (!plugins || plugins.length === 0) {
    return `<div class="empty-state"><p class="muted m-0">No plugins loaded</p></div>`;
  }
  return plugins
    .map((p) => renderPluginCard(p, statusMap.get(p.id), editorNotes && editorNotes.get(p.id)))
    .join('');
}

function renderAddVst(hub) {
  const plugins = hub.engine.plugins;
  if (plugins.length === 0) {
    return `
      <div class="row mt-10">
        <button id="vst-scan" class="btn btn-sm primary">Scan for VST3</button>
        <span class="muted ml-6">No VST3 plugins discovered yet</span>
      </div>`;
  }
  return `
    <div class="row mt-10">
      <select id="vst-pick" class="select select-sm">
        ${plugins
          .map((p) => `<option value="${escapeHtml(p.pluginId)}">${escapeHtml(p.name)} · ${escapeHtml(p.manufacturer || '?')} · ${escapeHtml(p.role)}</option>`)
          .join('')}
      </select>
      <button id="vst-add" class="btn btn-sm primary">+ Add VST</button>
    </div>`;
}

function renderVstEditor(instance, type, hub, statusMap, editorNotes) {
  const plugins = (instance.content && Array.isArray(instance.content.plugins)) ? instance.content.plugins : [];
  const engineDown = hub.engine.state === 'error' || hub.engine.state === 'stopped';
  return `
    <div class="panel">
      <div class="row">
        <h1 class="page-title">${instance.name}</h1>
        <span class="spacer"></span>
        <span class="pill accent-vst">VST</span>
        <span id="vst-engine-status" class="pill ${engineDown ? 'off' : 'ok'}">${engineDown ? 'Engine unavailable' : 'Engine ready'}</span>
      </div>
      <div class="panel mt-16">
        <h2 class="panel-title">Plugin Chain</h2>
        <div id="vst-chain">${renderChain(plugins, statusMap, editorNotes)}</div>
        <div id="vst-add-section">${renderAddVst(hub)}</div>
      </div>
      <div class="row mt-16">
        <span class="spacer"></span>
        <button id="node-delete" class="btn danger">Delete Node</button>
      </div>
    </div>`;
}

function buildRoutingNode(instance, hub) {
  const type = getNodeType(instance.type);
  return {
    id: instance.id,
    name: instance.name,
    type: instance.type,
    inputs: (type.ports && type.ports.inputs) || [],
    outputs: (type.ports && type.ports.outputs) || [],
    onInput: (portId, data) => {
      // Forward raw MIDI to the native engine for this VST chain. This only
      // fires when the MiniLab is actually connected into this node in the
      // graph (the graph only calls onInput for connected targets).
      if (instance.type !== 'vst' || portId !== 'midi-in') return;
      if (data && Array.isArray(data.raw) && hub.engine) {
        hub.engine.midi(instance.id, data.raw);
      }
    }
  };
}

export class NodeInstanceManager {
  constructor(hub) {
    this.hub = hub;
    this.instances = new Map(); // id -> instance
    this.layout = new GraphLayout(hub.settings);
    this._counts = {}; // type -> last used sequence number (never reused)
  }

  list() {
    return [...this.instances.values()];
  }

  get(id) {
    return this.instances.get(id) || null;
  }

  /** Access the internal plugin chain of a VST instance (or null). */
  getChain(instanceId) {
    const inst = this.instances.get(instanceId);
    if (!inst || inst.type !== 'vst') return null;
    return new VstChain(inst.content, () => this._persist());
  }

  /** Restore persisted instances (registers modules + routing nodes). */
  async load() {
    const data = this.hub.settings.get(KEY);
    const stored = data && Array.isArray(data.instances) ? data.instances : [];
    const counts = data && data.counts && typeof data.counts === 'object' ? data.counts : {};
    this._counts = { ...counts };
    for (const inst of stored) {
      if (!getNodeType(inst.type)) continue;
      let content = inst.content ?? null;
      if (inst.type === 'vst') {
        const plugins = content && Array.isArray(content.plugins) ? content.plugins : [];
        content = { plugins };
      }
      const instance = { id: inst.id, type: inst.type, name: inst.name, content };
      this.instances.set(instance.id, instance);
      this._registerModule(instance);
    }
  }

  /** Create a new empty instance of the given node type. */
  create(typeId) {
    const type = getNodeType(typeId);
    if (!type) throw new Error(`Unknown node type: ${typeId}`);
    const n = (this._counts[typeId] || 0) + 1;
    this._counts[typeId] = n;
    const id = `${typeId}-${String(n).padStart(3, '0')}`;
    const content = typeId === 'vst' ? { plugins: [] } : null;
    const instance = { id, type: typeId, name: `${type.label} ${n}`, content };
    this.instances.set(id, instance);
    this._registerModule(instance);
    this._persist();
    return instance;
  }

  /**
   * Create a new independent instance duplicating a live instance's content.
   * The copy gets a fresh monotonic ID/name and a separate layout entry; it
   * starts externally disconnected (no copied graph connections).
   */
  duplicate(sourceId) {
    const source = this.instances.get(sourceId);
    if (!source) return null;
    return this._createFrom(source.type, source.content);
  }

  /**
   * Create a new instance from a serializable { type, content } snapshot
   * (e.g. the internal Patch Bay clipboard). Content is duplicated so the new
   * instance is fully independent of the snapshot/source.
   */
  createFromSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || !getNodeType(snapshot.type)) {
      return null;
    }
    return this._createFrom(snapshot.type, snapshot.content);
  }

  _createFrom(typeId, content) {
    const type = getNodeType(typeId);
    if (!type) return null;
    const n = (this._counts[typeId] || 0) + 1;
    this._counts[typeId] = n;
    const id = `${typeId}-${String(n).padStart(3, '0')}`;
    const newContent = typeId === 'vst'
      ? duplicateVstContent(content)
      : (content ? JSON.parse(JSON.stringify(content)) : null);
    const instance = { id, type: typeId, name: `${type.label} ${n}`, content: newContent };
    this.instances.set(id, instance);
    this._registerModule(instance);
    this._persist();
    return instance;
  }

  /** Delete a user-created instance (native/system nodes are never deletable). */
  delete(id) {
    const instance = this.instances.get(id);
    if (!instance) return false;
    // Tear the chain down in the engine FIRST. Deleting the node only removed
    // it from the graph, so `engineSync` stopped seeing it and its chain kept
    // its last `outputEnabled=true` — a deleted VST node went on making sound
    // and kept its plugins (and their editor windows) alive forever.
    if (instance.type === 'vst' && this.hub.engine) {
      this.hub.engine.setChainOutputEnabled(id, false);
      this.hub.engine.setChainMidiEnabled(id, false);
      const plugins = (instance.content && Array.isArray(instance.content.plugins))
        ? instance.content.plugins
        : [];
      for (const plugin of plugins) {
        this.hub.engine.removeInstance(id, plugin.id);
      }
    }
    // Remove routing node (graph cleans up its connections) and layout entry.
    this.hub.graph.removeNode(id);
    this.layout.remove(id);
    // Remove the module / sidebar entry.
    this.hub.modules.unregister(id);
    this.instances.delete(id);
    this._persist();
    return true;
  }

  _registerModule(instance) {
    const type = getNodeType(instance.type);
    const manager = this;
    const hub = this.hub;
    const module = {
      id: instance.id,
      name: instance.name,
      navEntry: { label: instance.name, icon: type.icon, accent: instance.type },
      routingNode: buildRoutingNode(instance, hub),
      mount(container) {
        const statusMap = new Map(); // instanceId -> loading|ready|error
        const editorNotes = new Map(); // instanceId -> last editor feedback line
        const subs = [];

        hub.diagnostics.log(`vst: mount ${instance.id} plugins=${hub.engine.plugins.length} engine=${hub.engine.state}`);
        container.innerHTML = type.id === 'vst'
          ? renderVstEditor(instance, type, hub, statusMap, editorNotes)
          : renderGenericShell(instance, type);

        if (type.id === 'vst') {
          // Live engine status for this chain.
          subs.push(
            hub.events.on('engine:instanceStatus', (msg) => {
              if (msg.chainId !== instance.id) return;
              statusMap.set(msg.instanceId, msg.status);
              rerenderChain();
            }),
            hub.events.on('engine:chainChanged', (msg) => {
              if (msg.chainId !== instance.id) return;
              for (const inst of msg.instances || []) statusMap.set(inst.instanceId, inst.status);
              rerenderChain();
            }),
            // Native editor feedback. Without this the user got no signal at
            // all from "Open Plugin" — a failure and a success looked the same.
            hub.events.on('engine:editorStatus', (msg) => {
              if (msg.chainId !== instance.id) return;
              if (msg.open) {
                editorNotes.set(msg.instanceId, `editor open ${msg.width || '?'}x${msg.height || '?'}`);
              } else {
                editorNotes.set(msg.instanceId, msg.message ? `editor: ${msg.message}` : 'editor closed');
              }
              rerenderChain();
            }),
            hub.events.on('engine:plugins', () => {
              hub.diagnostics.log(`vst: plugins event -> re-render add section (${hub.engine.plugins.length} plugins)`);
              const addEl = container.querySelector('#vst-add-section');
              if (addEl) addEl.innerHTML = renderAddVst(hub);
            }),
            hub.events.on('engine:state', () => {
              const pill = container.querySelector('#vst-engine-status');
              if (pill) {
                const down = hub.engine.state === 'error' || hub.engine.state === 'stopped';
                pill.textContent = down ? 'Engine unavailable' : 'Engine ready';
                pill.className = 'pill ' + (down ? 'off' : 'ok');
              }
              // If the engine became ready and the registry is still empty
              // (e.g. the auto-scan raced engine startup), re-trigger the scan.
              if (hub.engine.state === 'running' && hub.engine.plugins.length === 0) {
                hub.engine.scanVst3();
              }
            })
          );
        }

        function rerenderChain() {
          const chainEl = container.querySelector('#vst-chain');
          if (chainEl) chainEl.innerHTML = renderChain(instance.content.plugins, statusMap, editorNotes);
        }

        // One handler per mount, removed on unmount. It used to be attached to
        // the shared `#content` element and never removed, so every module
        // visit left another live handler on it: clicking a plugin action then
        // fired for OTHER VST nodes too (same `plugin-N` ids), and "Delete
        // Node" on any page could delete a previously visited node.
        const onClick = (e) => {
          if (e.target.closest('#node-delete')) {
            manager.delete(instance.id);
            hub.modules.activate('home', container);
            return;
          }
          if (type.id !== 'vst') return;

          if (e.target.closest('#vst-scan')) {
            hub.engine.scanVst3();
            return;
          }
          if (e.target.closest('#vst-add')) {
            const pick = container.querySelector('#vst-pick');
            if (!pick || !pick.value) return;
            const plugin = hub.engine.getPlugin(pick.value);
            if (!plugin) return;
            const chain = manager.getChain(instance.id);
            if (!chain) return;
            const p = chain.append({
              pluginId: plugin.pluginId,
              name: plugin.name,
              role: plugin.role
            });
            statusMap.set(p.id, 'loading');
            hub.engine.createInstance(instance.id, plugin.pluginId, p.id, chain.plugins.length - 1);
            rerenderChain();
            return;
          }

          const card = e.target.closest('.plugin-card');
          if (!card) return;
          const id = card.dataset.pluginId;
          const action = e.target.dataset.action;
          const chain = manager.getChain(instance.id);
          if (!chain) return;
          const idx = chain.plugins.findIndex((x) => x.id === id);
          if (idx === -1) return;

          if (action === 'open') {
            editorNotes.set(id, 'opening editor…');
            rerenderChain();
            hub.engine.openEditor(instance.id, id);
          } else if (action === 'bypass') {
            const p = chain.plugins[idx];
            const newBypass = !p.bypassed;
            chain.setBypass(id, newBypass);
            hub.engine.setBypass(instance.id, id, newBypass);
            statusMap.set(id, newBypass ? 'bypassed' : 'ready');
            rerenderChain();
          } else if (action === 'remove') {
            chain.remove(id);
            hub.engine.removeInstance(instance.id, id);
            statusMap.delete(id);
            editorNotes.delete(id);
            rerenderChain();
          } else if (action === 'up') {
            if (idx > 0) {
              chain.reorder(id, idx - 1);
              hub.engine.reorderChain(instance.id, id, idx - 1);
              rerenderChain();
            }
          } else if (action === 'down') {
            if (idx < chain.plugins.length - 1) {
              chain.reorder(id, idx + 1);
              // After reorder, the plugin moves to idx+1; engine index is the new position.
              hub.engine.reorderChain(instance.id, id, idx + 1);
              rerenderChain();
            }
          }
        };

        container.addEventListener('click', onClick);

        // Store cleanup for unmount.
        module._subs = subs;
        module._container = container;
        module._onClick = onClick;
      },
      unmount() {
        if (module._subs) {
          module._subs.forEach((u) => u());
          module._subs = [];
        }
        if (module._container && module._onClick) {
          module._container.removeEventListener('click', module._onClick);
        }
        module._container = null;
        module._onClick = null;
      }
    };
    this.hub.modules.register(module);
  }

  _persist() {
    return this.hub.settings.set(KEY, {
      instances: [...this.instances.values()],
      counts: { ...this._counts }
    });
  }
}
