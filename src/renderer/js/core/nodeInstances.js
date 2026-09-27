/**
 * Node Instance Manager.
 *
 * Manages user-created node instances (e.g. "VST 1", "Video 1"). Each instance
 * is a thin object:
 *
 *   { id, type, ordinal, name, content }
 *
 * IDENTITY vs DISPLAY NUMBER - these are deliberately two different things:
 *
 *   id       `vst-011`. Stable, unique forever, NEVER reused after a delete.
 *            Everything that must survive a reload keys off this: routing
 *            connections, layout, module registration, native engine chains.
 *   ordinal  `2`, rendered as "VST 2". Display only. A new node takes the
 *            LOWEST positive number not currently used by a live node of the
 *            same type, so deleting VST 2..10 makes the next VST "VST 2"
 *            again - while its id may well be `vst-011`.
 *
 * Existing nodes are never renumbered; only new ones fill the holes.
 * `name` is derived (`type.label + ordinal`) and is not persisted separately.
 *
 * `type` is immutable (from the Node Type Registry). `content` is the type's
 * own: a VST node's plugin chain `{ plugins: [] }` (see vstChain.js), a
 * Mixer's levels, an arpeggiator's pattern; `defaultContentFor` and
 * `normalizeContentFor` below say what each may hold.
 *
 * A node's PAGE is not here. Each type with a page of its own brings it from
 * its folder under `modules/` through `nodeEditors.js`; `mount()` below draws
 * whatever the registry hands back and knows nothing of any of them.
 *
 * Instances are persisted under the `nodeInstances` settings key, together with
 * the per-type monotonic id sequence. They integrate with the Hub by
 * registering a module (sidebar entry + editor shell) and a routing node in
 * `hub.network`.
 *
 * VST nodes now connect their internal plugin chain to the native engine:
 * every chain operation (add / remove / reorder / bypass) is synchronized to
 * the engine, and MIDI reaching a VST node through the network is forwarded to
 * the engine for that chain. The Patch Bay still sees the complete VST chain as
 * ONE VST node — individual plugins never enter `hub.network`.
 *
 * Responsibilities are kept separate: `nodeInstances` owns instances,
 * `networkLayout` owns positions, `networkConnections` owns routing.
 */
import { defaultListPlace, getNodeType, nodeDisplayName, nodeFamily } from './nodeTypes.js';
import { NetworkLayout } from './networkLayout.js';
import { VstChain, duplicateVstContent } from './vstChain.js';
import { escapeHtml } from './html.js';
import { normalizeControlBinding, normalizeControlBindings } from './controlBindings.js';
import { defaultArpeggiatorContent, normalizeArpeggiatorContent } from './arpeggiatorState.js';
import { createSequence, readSequence } from './oneRingSequence.js';
import { AUDIO_PLAYER_TYPE, defaultAudioPlayerContent, normalizeAudioPlayerContent } from './audioPlayerState.js';
import { getNodeEditor } from './nodeEditors.js';
import { createDisposers } from './disposers.js';
import { midiThruReach } from './midiThru.js';
import { NODE_COMMANDS } from './nodeCommands.js';

const KEY = 'nodeInstances';

/** The page of a node type with no editor of its own (`video`, `image`, `audio-input`). */
function renderGenericShell(instance, type) {
  return `
    <div class="panel">
      <div class="row">
        <h1 class="page-title">${escapeHtml(instance.name)}</h1>
        <span class="spacer"></span>
        <span class="pill accent-${type.id} family-${nodeFamily(type.id)}">${type.label}</span>
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

function buildRoutingNode(instance, hub) {
  const type = getNodeType(instance.type);
  return {
    id: instance.id,
    name: instance.name,
    type: instance.type,
    // A node that grows its AUDIO IN rows keeps its declared inputs (CTRL IN)
    // after them, where a new row cannot land between two of its audio inputs.
    inputs: type.dynamicAudioInputs
      ? [...instance.content.inputs.map((p, i) => ({ id: p.id, type: 'audio', label: `AUDIO IN ${i + 1}` })), ...((type.ports && type.ports.inputs) || [])]
      : ((type.ports && type.ports.inputs) || []),
    outputs: (type.ports && type.ports.outputs) || [],
    onInput: (portId, data) => {
      // The Sequencer owns musical focus. Its controller records the one
      // physical ingress and forwards live MIDI only through the stable output
      // branches selected by armed/monitored tracks. Arrangement playback is
      // still routed independently by the native per-track plan.
      if (instance.type === 'sequencer') {
        if (portId !== 'midi-in' || !data || !Array.isArray(data.raw)) return;
        hub.sequencer?.receiveMidiInput(data);
        return;
      }
      // Forward raw MIDI to the native engine for this VST chain. This only
      // fires when the MiniLab is actually connected into this node in the
      // network (the network only calls onInput for connected targets).
      // A One Ring node hears them too: what it captures is what reaches it.
      if (instance.type === 'arpeggiator' || instance.type === 'one-ring') {
        if (portId === 'midi-in' && data && Array.isArray(data.raw)) hub.engine?.midiNode(instance.id, data.raw);
        return;
      }
      if (instance.type !== 'vst') return;
      if (portId === 'ctrl-in') {
        if (hub.control) hub.control.route(instance.id, data);
        return;
      }
      if (portId !== 'midi-in' || !data || !Array.isArray(data.raw)) return;
      hub.engine?.midi(instance.id, data.raw);
      // MIDI OUT repeats what came in (D-039). The series is walked once from
      // here instead of re-emitted, so an instrument two cables away plays the
      // note once, and the Sequencer's MIDI IN is never handed a VST's notes.
      // A VST in the series takes the note straight into its chain -- through
      // its own onInput it would walk the rest of the series a second time.
      for (const hop of midiThruReach(hub.network, instance.id)) {
        if (hop.kind === 'vst') hub.engine?.midi(hop.id, data.raw);
        else hub.network.emitDataTo(hop.via, 'midi-out', hop.id, data);
      }
    }
  };
}

const firstAudioInput = () => ({ id: 'audio-in-1', level: 1, muted: false });

/** Fresh default content for a node type (VST nodes own a plugin chain). */
function defaultContentFor(typeId) {
  if (typeId === 'vst') return { plugins: [], controlBindings: [] };
  if (typeId === 'mixer') {
    return { inputs: [firstAudioInput()], masterLevel: 1, nextInputSeq: 1 };
  }
  if (typeId === 'morpher') {
    // A ramp from 0 to 1 over the 32 steps, whatever number of them is shown.
    const steps = Array.from({ length: 32 }, (_, i) => i / 31);
    return { inputs: [firstAudioInput()], stepCount: 4, steps, nextInputSeq: 1 };
  }
  if (typeId === 'arpeggiator') return defaultArpeggiatorContent();
  if (typeId === 'one-ring') return createSequence();
  if (typeId === AUDIO_PLAYER_TYPE) return defaultAudioPlayerContent();
  return null;
}

/** An independent deep copy of a node's content, for duplicate/paste. */
function cloneContentFor(typeId, content) {
  if (typeId === 'vst') return duplicateVstContent(content);
  return content ? JSON.parse(JSON.stringify(content)) : null;
}

/**
 * A node's content exactly as a history snapshot holds it.
 *
 * Not `cloneContentFor`, which is right for Duplicate and Paste and wrong here:
 * it gives a VST chain's plugins new instance ids and drops its bindings, so that
 * a copy never inherits the knobs of the node it came from. A restore is the
 * same node coming back. Every Ctrl+Z went through the copy, which emptied the
 * bindings of every VST node on screen and brought a deleted one back with
 * renumbered plugins and no bindings (2026-09-15).
 */
function restoredContentFor(content) {
  return content ? JSON.parse(JSON.stringify(content)) : null;
}

/**
 * A node's content, made safe to trust, by type.
 *
 * WHY THIS IS A FUNCTION AND NOT A TERNARY INSIDE `load()`
 * --------------------------------------------------------
 * `load()` was the only reader of untrusted content -- a `.minihub` file, which
 * can be corrupt or old. The agent channel is the second (INTENT 8 sexies), and
 * its content arrives from outside with no guarantee at all. Two copies of
 * "what a mixer's content is allowed to be" would drift, and the drift is
 * silent: a malformed level reaches the engine as a NaN gain rather than as an
 * error.
 *
 * A VST node's PLUGINS are deliberately not derived from the argument here --
 * the caller decides whether they come from the payload (a project being
 * loaded) or from the live chain (anything else). A plugin is a running native
 * instance; it cannot be conjured by writing a list.
 */
export function normalizeContentFor(typeId, content) {
  if (typeId === 'vst') {
    return {
      controlBindings: normalizeControlBindings(content?.controlBindings),
      ...(Number.isSafeInteger(content?.nextPluginInstanceSeq) && content.nextPluginInstanceSeq >= 0
        ? { nextPluginInstanceSeq: content.nextPluginInstanceSeq } : {})
    };
  }
  if (typeId === 'mixer' || typeId === 'morpher') return normalizeNativeAudioContent(typeId, content);
  if (typeId === 'arpeggiator') return normalizeArpeggiatorContent(content);
  if (typeId === 'one-ring') {
    // A sequence that cannot be read is not guessed at: the node starts empty,
    // as the VST did with a state it refused.
    try {
      return readSequence(content);
    } catch (_) {
      return createSequence();
    }
  }
  if (typeId === AUDIO_PLAYER_TYPE) return normalizeAudioPlayerContent(content);
  return content ?? null;
}

const clampTo = (low, high, value) => Math.max(low, Math.min(high, value));

function normalizeNativeAudioContent(typeId, value) {
  const base = defaultContentFor(typeId);
  const source = value && typeof value === 'object' ? value : {};
  const inputs = Array.isArray(source.inputs)
    ? source.inputs
      .filter((p) => p && /^audio-in-[1-9][0-9]*$/.test(p.id))
      .map((p) => ({
        id: p.id,
        level: Number.isFinite(p.level) ? clampTo(0, 2, p.level) : 1,
        muted: p.muted === true,
        // A Mixer strip's pan, kept only where there is one: a strip that was
        // never turned is centred, and a Morpher has no pan to keep.
        ...(typeId === 'mixer' && Number.isFinite(p.pan) && p.pan !== 0 ? { pan: clampTo(-1, 1, p.pan) } : {})
      }))
    : base.inputs;
  // `audio-in-12` -> 12: the next row never takes a number already used.
  const maxSeq = inputs.reduce((m, p) => Math.max(m, Number(p.id.slice(9)) || 0), 0);
  if (!inputs.length) inputs.push(firstAudioInput());
  const nextInputSeq = Math.max(maxSeq, source.nextInputSeq || 0);
  if (typeId === 'mixer') {
    const masterLevel = Number.isFinite(source.masterLevel) ? clampTo(0, 2, source.masterLevel) : 1;
    return { inputs, masterLevel, nextInputSeq };
  }
  const stepCount = [4, 8, 16, 32].includes(source.stepCount) ? source.stepCount : 4;
  const steps = Array.from({ length: 32 }, (_, i) =>
    Number.isFinite(source.steps?.[i]) ? clampTo(0, 1, source.steps[i]) : base.steps[i]);
  return { inputs, stepCount, steps, nextInputSeq };
}

/** Numeric suffix of a stable instance id (`vst-011` -> 11), or 0. */
function idSuffix(id) {
  const m = /-(\d+)$/.exec(String(id));
  return m ? Number(m[1]) : 0;
}

export class NodeInstanceManager {
  constructor(hub) {
    this.hub = hub;
    this.instances = new Map(); // id -> instance
    this.layout = new NetworkLayout(hub.settings);
    this._idSeq = {}; // type -> last used ID sequence number (never reused)
    this._expandingPorts = false;
    hub.events.on('network:change', () => this._ensureDynamicAudioPorts());
  }

  /**
   * A Mixer or a Morpher always has one free AUDIO IN: when every row is
   * cabled, a new one appears under them.
   */
  _ensureDynamicAudioPorts() {
    if (this._expandingPorts) return;
    this._expandingPorts = true;
    let changed = false;
    for (const instance of this.instances.values()) {
      if (instance.type !== 'mixer' && instance.type !== 'morpher') continue;
      const networkNode = this.hub.network.getNode(instance.id);
      if (!networkNode) continue;
      const connected = new Set(this.hub.network.connectionsTo(instance.id).map((c) => c.to.portId));
      if (instance.content.inputs.some((input) => !connected.has(input.id))) continue;
      const seq = (instance.content.nextInputSeq || 0) + 1;
      instance.content.nextInputSeq = seq;
      const input = { id: `audio-in-${seq}`, level: 1, muted: false };
      instance.content.inputs.push(input);
      // Under the last AUDIO IN, above the CTRL IN that follows them.
      const port = { id: input.id, type: 'audio', label: `AUDIO IN ${instance.content.inputs.length}` };
      const firstDeclared = networkNode.inputs.findIndex((existing) => existing.type !== 'audio');
      if (firstDeclared < 0) networkNode.inputs.push(port);
      else networkNode.inputs.splice(firstDeclared, 0, port);
      changed = true;
    }
    this._expandingPorts = false;
    if (!changed) return;
    this._persist();
    // connections(), not serialize(): this event says what is routing, and
    // serialize() also carries the cables still waiting for an absent node.
    this.hub.events.emit('network:change', { type: 'ports', connections: this.hub.network.connections() });
  }

  list() {
    return [...this.instances.values()];
  }

  get(id) {
    return this.instances.get(id) || null;
  }

  /**
   * Put a node in the sidebar's NODES list just before another, or last when
   * `beforeId` is null.
   *
   * The list IS the order of this map, and the map is what `_persist()` writes,
   * so the order a person arranges is the order the project saves and reopens
   * with -- no second key naming the same nodes, which could disagree with it.
   * Nothing else reads this order as meaning: ids name nodes everywhere, and
   * the edit history compares the node SET sorted by id, so reordering is
   * neither a step to undo nor a change to anything that sounds.
   */
  move(id, beforeId = null) {
    if (!this.instances.has(id) || id === beforeId) return false;
    if (beforeId !== null && !this.instances.has(beforeId)) return false;
    const order = [...this.instances.keys()].filter((key) => key !== id);
    const at = beforeId === null ? order.length : order.indexOf(beforeId);
    order.splice(at, 0, id);
    if (order.every((key, index) => key === [...this.instances.keys()][index])) return false;
    this.instances = new Map(order.map((key) => [key, this.instances.get(key)]));
    this._persist();
    this.hub.events.emit('nodes:reordered', { nodeId: id, order });
    return true;
  }

  /**
   * Access the internal plugin chain of a VST instance (or null).
   *
   * Every edit of the chain is announced (`vst:chainChanged`): the Patch Bay's
   * card prints the chain, and nothing else told it the chain had moved. A
   * plugin taken from the canvas menu is added after its node is drawn, and
   * an agent adds and removes them with the Patch Bay on screen; the card went
   * on saying "empty", or the old count, until the VST page was visited.
   */
  getChain(instanceId) {
    const inst = this.instances.get(instanceId);
    if (!inst || inst.type !== 'vst') return null;
    return new VstChain(inst.content, () => {
      this._persist();
      this.hub.events.emit('vst:chainChanged', { nodeId: instanceId });
    });
  }

  /**
   * Put a plugin at the end of a VST node's chain, in the model and in the
   * engine, and answer with the chain entry.
   *
   * WHY THIS IS A METHOD AND NOT THREE LINES AT THE CALL SITE
   * ---------------------------------------------------------
   * It was three lines inside the VST panel's click handler, which was fine
   * while the panel was the only thing that could add a plugin. It is not any
   * more: the agent channel adds one too (INTENT §8 sexies), and a second copy
   * of "append, then tell the engine, and remember the index" is a copy that
   * drifts. The failure is silent by nature -- a chain the renderer believes in
   * and the engine has never heard of.
   */
  appendPlugin(instanceId, pluginId) {
    const plugin = this.hub.engine.getPlugin(pluginId);
    if (!plugin) return null;
    const chain = this.getChain(instanceId);
    if (!chain) return null;
    const entry = chain.append({ pluginId: plugin.pluginId, name: plugin.name, role: plugin.role });
    this.hub.engine.createInstance(instanceId, plugin.pluginId, entry.id, chain.plugins.length - 1);
    return entry;
  }

  /**
   * Move a plugin within its chain, in the model and in the engine.
   *
   * Out of the click handler for the same reason as its neighbours: the engine
   * call carries the NEW index, and a caller that computes it differently
   * leaves the renderer and the engine disagreeing about the order of the
   * effects -- which is audible, and looks like nothing at all on screen.
   */
  movePlugin(instanceId, pluginInstanceId, toIndex) {
    const chain = this.getChain(instanceId);
    if (!chain || !chain.plugins.some((plugin) => plugin.id === pluginInstanceId)) return false;
    const index = Math.max(0, Math.min(chain.plugins.length - 1, Math.trunc(Number(toIndex))));
    if (!Number.isFinite(index)) return false;
    if (!chain.reorder(pluginInstanceId, index)) return false;
    this.hub.engine.reorderChain(instanceId, pluginInstanceId, index);
    return true;
  }

  /** Bypass a plugin, in the model and in the engine. */
  setPluginBypass(instanceId, pluginInstanceId, bypassed) {
    const chain = this.getChain(instanceId);
    if (!chain || !chain.plugins.some((plugin) => plugin.id === pluginInstanceId)) return false;
    const next = bypassed === true;
    chain.setBypass(pluginInstanceId, next);
    this.hub.engine.setBypass(instanceId, pluginInstanceId, next);
    return true;
  }

  /**
   * Take a plugin out of a VST node's chain, in the model and in the engine.
   *
   * The two `hub.control` lines are the reason this is a method, and neither may
   * be forgotten. A Learn armed on the plugin would otherwise capture into a
   * target that is gone. And a CONTROL binding pointing at it would outlive it:
   * nothing throws, the knob simply stops doing anything, and the binding went
   * on reading as live in the bindings bar -- or, in a node with no plugin left
   * that opens a window, sat where nothing could show or clear it. Both lines
   * run before the plugin leaves the model.
   */
  removePlugin(instanceId, pluginInstanceId) {
    const chain = this.getChain(instanceId);
    if (!chain || !chain.plugins.some((plugin) => plugin.id === pluginInstanceId)) return false;
    this.hub.control?.targetInvalidated?.(instanceId, pluginInstanceId, 'target-removed');
    this.hub.control?.releasePlugin?.(instanceId, pluginInstanceId);
    chain.remove(pluginInstanceId);
    this.hub.engine.removeInstance(instanceId, pluginInstanceId);
    return true;
  }

  /** Validated persistent CONTROL bindings owned by one VST node. */
  getControlBindings(instanceId) {
    const inst = this.instances.get(instanceId);
    if (!inst || inst.type !== 'vst' || !Array.isArray(inst.content.controlBindings)) return [];
    return inst.content.controlBindings;
  }

  /** Upsert one binding by physical source identity. */
  setControlBinding(instanceId, value) {
    const inst = this.instances.get(instanceId);
    const binding = normalizeControlBinding(value);
    if (!inst || inst.type !== 'vst' || !binding) return false;
    if (!Array.isArray(inst.content.controlBindings)) inst.content.controlBindings = [];
    const index = inst.content.controlBindings
      .findIndex((item) => item.sourceControlId === binding.sourceControlId);
    if (index === -1) inst.content.controlBindings.push(binding);
    else inst.content.controlBindings[index] = binding;
    this._persist();
    return true;
  }

  clearControlBinding(instanceId, sourceControlId) {
    const inst = this.instances.get(instanceId);
    if (!inst || inst.type !== 'vst' || !Array.isArray(inst.content.controlBindings)) return false;
    const before = inst.content.controlBindings.length;
    inst.content.controlBindings = inst.content.controlBindings
      .filter((binding) => binding.sourceControlId !== sourceControlId);
    if (inst.content.controlBindings.length === before) return false;
    this._persist();
    return true;
  }

  /** Keep a plugin's saved state, as long as it is still the plugin it was. */
  setPluginState(instanceId, pluginInstanceId, pluginId, state) {
    const inst = this.instances.get(instanceId);
    const plugin = inst?.type === 'vst' && inst.content?.plugins?.find((p) => p.id === pluginInstanceId);
    if (!plugin || plugin.pluginId !== pluginId || typeof state !== 'string') return false;
    plugin.state = state;
    this._persist();
    return true;
  }

  /** Restore persisted instances (registers modules + routing nodes). */
  async load() {
    const data = this.hub.settings.get(KEY);
    const stored = data && Array.isArray(data.instances) ? [...data.instances] : [];
    // `counts` is the pre-ordinal key name; still read so existing installs
    // keep their ID sequence and never regenerate an id that is already taken.
    const seq = (data && (data.idSeq || data.counts)) || {};
    this._idSeq = typeof seq === 'object' ? { ...seq } : {};
    let migratedArpeggiator = false;
    let migratedAudioInput = false;
    const migratedStableIds = new Map();

    // Audio Input used to be an always-present system module and therefore was
    // absent from nodeInstances even when a saved project routed or positioned
    // it. Materialise that legacy project evidence once so existing projects
    // keep their source while fresh New projects remain free of Audio Input.
    const connections = this.hub.settings.get('networkConnections');
    const layout = this.hub.settings.get('networkLayout');
    const legacyAudioInputPresent = Array.isArray(connections)
      && connections.some((connection) => connection?.from?.nodeId === 'audio-input'
        || connection?.to?.nodeId === 'audio-input');
    if (!stored.some((entry) => entry?.type === 'audio-input')
        && (legacyAudioInputPresent || Object.hasOwn(layout || {}, 'audio-input'))) {
      stored.push({ id: 'audio-input', type: 'audio-input', ordinal: 1, content: null });
      migratedAudioInput = true;
    }

    for (const entry of stored) {
      // Persisted data is not trusted: a corrupt entry must cost that one node,
      // not the whole startup.
      if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id) continue;
      const type = getNodeType(entry.type);
      if (!type) continue;
      const instanceId = type.stableId || entry.id;
      if (instanceId !== entry.id) migratedStableIds.set(entry.id, instanceId);
      if (this.instances.has(instanceId)) continue; // duplicate id in the file
      if (type.singleton && this.list().some((instance) => instance.type === type.id)) continue;
      // The plugins come from the FILE here, and only here: this is the one
      // caller restoring a chain that existed, rather than editing a live one.
      const content = entry.type === 'vst'
        ? {
            plugins: (entry.content && Array.isArray(entry.content.plugins)) ? entry.content.plugins : [],
            ...normalizeContentFor('vst', entry.content)
          }
        : normalizeContentFor(entry.type, entry.content);
      if (entry.type === 'arpeggiator' && JSON.stringify(content) !== JSON.stringify(entry.content)) migratedArpeggiator = true;

      const instance = {
        id: instanceId,
        type: entry.type,
        ordinal: this._restoreOrdinal(entry, type),
        content
      };
      instance.name = nodeDisplayName(type, instance.ordinal);

      // Defensive: if the persisted sequence is missing or behind the ids
      // actually in use, a new node would collide with an existing one and
      // module registration would throw. Keep the sequence ahead of reality.
      const suffix = idSuffix(instance.id);
      if (suffix > (this._idSeq[instance.type] || 0)) this._idSeq[instance.type] = suffix;

      this.instances.set(instance.id, instance);
      this._registerModule(instance);
    }
    // Rewrite a legacy degree-based Custom pattern once, during the existing
    // startup/project-loading phase. The conversion is pitch-preserving and
    // prevents a later save from resurrecting the obsolete representation.
    if (migratedStableIds.size) {
      const migrateId = (id) => migratedStableIds.get(id) || id;
      const connections = this.hub.settings.get('networkConnections');
      if (Array.isArray(connections)) await this.hub.settings.set('networkConnections', connections.map((connection) => {
        if (!connection || typeof connection !== 'object') return connection;
        return {
          ...connection,
          from: { ...connection.from, nodeId: migrateId(connection.from?.nodeId) },
          to: { ...connection.to, nodeId: migrateId(connection.to?.nodeId) }
        };
      }));
      const layout = this.hub.settings.get('networkLayout');
      if (layout && typeof layout === 'object') {
        const migratedLayout = { ...layout };
        for (const [oldId, stableId] of migratedStableIds) {
          if (!(stableId in migratedLayout) && oldId in migratedLayout) migratedLayout[stableId] = migratedLayout[oldId];
          delete migratedLayout[oldId];
        }
        await this.hub.settings.set('networkLayout', migratedLayout);
      }
    }
    if (migratedArpeggiator || migratedAudioInput || migratedStableIds.size) await this._persist();
  }

  /**
   * Ordinal for a restored instance: the persisted one when valid, else the
   * number in its persisted name (pre-ordinal installs), else the lowest free
   * one. Duplicates are resolved so two live nodes never share a number.
   */
  _restoreOrdinal(entry, type) {
    const candidates = [];
    if (Number.isInteger(entry.ordinal) && entry.ordinal > 0) candidates.push(entry.ordinal);
    const fromName = /\s(\d+)$/.exec(String(entry.name || ''));
    if (fromName) candidates.push(Number(fromName[1]));
    const taken = this._takenOrdinals(entry.type);
    for (const n of candidates) {
      if (!taken.has(n)) return n;
    }
    return this._lowestFreeOrdinal(entry.type);
  }

  /** Display ordinals currently in use by live instances of a type. */
  _takenOrdinals(typeId) {
    const taken = new Set();
    for (const inst of this.instances.values()) {
      if (inst.type === typeId) taken.add(inst.ordinal);
    }
    return taken;
  }

  /**
   * Lowest positive display number free within a type family. This is what
   * makes "delete VST 2..10, create a VST" produce "VST 2" and not "VST 11".
   */
  _lowestFreeOrdinal(typeId) {
    const taken = this._takenOrdinals(typeId);
    let n = 1;
    while (taken.has(n)) n += 1;
    return n;
  }

  /** Next stable id for a type. Monotonic per type; never reused. */
  _nextId(typeId) {
    const n = (this._idSeq[typeId] || 0) + 1;
    this._idSeq[typeId] = n;
    return `${typeId}-${String(n).padStart(3, '0')}`;
  }

  /**
   * The single creation path. Every UI route (sidebar, Patch Bay toolbar,
   * context menu, paste, duplicate) ends up here, so naming, default content,
   * module registration, network registration and persistence cannot drift
   * apart between them.
   */
  _add(typeId, content, { id = null, ordinal = null } = {}) {
    const type = getNodeType(typeId);
    if (!type) return null;
    // Singleton creation is deliberately a no-op. Returning null also keeps a
    // repeated Patch Bay create action from moving/reselecting the live node.
    if (type.singleton && this.list().some((instance) => instance.type === typeId)) return null;
    const instance = {
      // `id` is only ever supplied by a restore -- the edit history putting
      // back the node you just deleted. That is not invariant 4's "a node id is
      // never reused": it is the SAME node, with the same content, coming back
      // under the identity every cable and every layout entry still names. A
      // new node never takes this path.
      id: id || type.stableId || this._nextId(typeId),
      type: typeId,
      ordinal: Number.isInteger(ordinal) && ordinal > 0 ? ordinal : this._lowestFreeOrdinal(typeId),
      content
    };
    // The sequence must never fall behind an id that exists, or the next new
    // node collides with the one just restored and registration throws.
    const restoredSuffix = idSuffix(instance.id);
    if (restoredSuffix > (this._idSeq[typeId] || 0)) this._idSeq[typeId] = restoredSuffix;
    instance.name = nodeDisplayName(type, instance.ordinal);
    // A new node joins its own kind in the NODES list. A restored one does not:
    // the edit history puts it back where it was (editHistoryApply.js).
    const beforeId = id ? null : defaultListPlace(this.list(), typeId);
    this.instances.set(instance.id, instance);
    if (beforeId !== null) {
      const order = [...this.instances.keys()].filter((key) => key !== instance.id);
      order.splice(order.indexOf(beforeId), 0, instance.id);
      this.instances = new Map(order.map((key) => [key, this.instances.get(key)]));
    }
    this._registerModule(instance);
    this._persist();
    return instance;
  }

  /** Create a new empty instance of the given node type. */
  create(typeId) {
    if (!getNodeType(typeId)) throw new Error(`Unknown node type: ${typeId}`);
    return this._add(typeId, defaultContentFor(typeId));
  }

  /**
   * Create a new independent instance duplicating a live instance's content.
   * The copy gets a fresh ID, its own display number and a separate layout
   * entry; it starts externally disconnected (no copied network connections).
   */
  duplicate(sourceId) {
    const source = this.instances.get(sourceId);
    if (!source) return null;
    if (getNodeType(source.type)?.copyable === false) return null;
    return this._copied(this._add(source.type, cloneContentFor(source.type, source.content)));
  }

  /**
   * Announce a node born as a copy. A copied VST node lists its plugins with
   * their state, and `_add` creates nothing in the engine: its page came up
   * empty and it made no sound until the project was reopened (2026-09-26).
   * `chainSync` answers by creating them, as it does for a restored node.
   */
  _copied(instance) {
    if (instance) this.hub.events.emit('nodes:copied', { nodeId: instance.id });
    return instance;
  }

  /**
   * Create a new instance from a serializable { type, content } snapshot
   * (e.g. the internal Patch Bay clipboard). Content is duplicated so the new
   * instance is fully independent of the snapshot/source.
   */
  createFromSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return null;
    const type = getNodeType(snapshot.type);
    if (!type || type.copyable === false) return null;
    return this._copied(this._add(snapshot.type, cloneContentFor(snapshot.type, snapshot.content)));
  }

  /**
   * Put a live node's content back, and tell the engine.
   *
   * A VST node's PLUGIN LIST is deliberately kept as it is: those are running
   * native instances, and swapping the list here would leave the engine holding
   * plugins the model no longer lists. Everything else -- an arpeggiator's
   * pattern, a mixer's levels, control bindings -- is a parameter the engine is
   * told about by the republish below, so it goes back whole.
   *
   * Returns whether anything moved.
   */
  restoreContent(id, content) {
    const instance = this.instances.get(id);
    if (!instance) return false;
    return this._writeContent(instance, restoredContentFor(content));
  }

  /**
   * Write a node's content from OUTSIDE, normalising it first.
   *
   * `restoreContent` trusts its argument because the history only ever hands it
   * back a snapshot it took itself. Nothing else may: a level of `"loud"` or a
   * pattern of the wrong length reaches the engine as a NaN rather than as a
   * complaint, so the agent channel writes through here.
   *
   * A VST node's plugins are not writable this way on purpose -- they are
   * running native instances, added and removed by `appendPlugin` /
   * `removePlugin`, which tell the engine. `_writeContent` keeps the live list.
   */
  setContent(id, content) {
    const instance = this.instances.get(id);
    if (!instance) return false;
    return this._writeContent(instance, normalizeContentFor(instance.type, content));
  }

  /** Compare, keep what is not the caller's to write, persist, and signal. */
  _writeContent(instance, next) {
    const plugins = instance.content?.plugins || [];
    // A binding is kept only while its plugin is in the live chain. The plugin
    // list is not the caller's to write, so a binding naming a plugin removed
    // since the snapshot was taken can never work again -- and bringing it back
    // would put it where `releasePlugin()` took it from, drawn under the next
    // plugin opened in the node and cleared from nowhere once none is left.
    const livePlugins = new Set(plugins.map((plugin) => plugin.id));
    const kept = instance.type === 'vst'
      ? { ...(next || {}),
          plugins,
          controlBindings: (Array.isArray(next?.controlBindings) ? next.controlBindings : [])
            .filter((binding) => livePlugins.has(binding?.pluginInstanceId)),
          ...(Number.isSafeInteger(instance.content?.nextPluginInstanceSeq)
            ? { nextPluginInstanceSeq: instance.content.nextPluginInstanceSeq } : {}) }
      : next;
    if (JSON.stringify(kept) === JSON.stringify(instance.content)) return false;
    const bindingsMoved = instance.type === 'vst'
      && JSON.stringify(kept.controlBindings) !== JSON.stringify(instance.content?.controlBindings || []);
    instance.content = kept;
    this._persist();
    // The same signals an ordinary edit of this node sends. `engineSync` listens
    // to the first two and republishes the whole plan, so the engine follows the
    // model rather than being handed a reverse command (D-032). A binding is
    // announced the way Learn and Clear announce one, so an open bindings bar
    // reads again where its knobs stand.
    if (instance.type === 'arpeggiator') this.hub.events.emit('nativeMidi:stateChanged', { nodeId: instance.id });
    else if (instance.type === 'mixer' || instance.type === 'morpher') {
      this.hub.events.emit('nativeAudio:stateChanged', { nodeId: instance.id });
    } else if (instance.type === 'one-ring') {
      this.hub.events.emit('oneRing:contentChanged', { nodeId: instance.id });
    } else if (instance.type === AUDIO_PLAYER_TYPE) {
      // Its level is a value of the audio network; its file and loop are the
      // player's own (audioPlayers.js).
      this.hub.events.emit('nativeAudio:stateChanged', { nodeId: instance.id });
      this.hub.events.emit('audioPlayer:contentChanged', { nodeId: instance.id });
    } else if (bindingsMoved) {
      this.hub.events.emit('control:bindingsChanged', { nodeId: instance.id });
    }
    // For an open page: what it shows was written by someone else -- a
    // command, an agent -- and not by its own controls.
    this.hub.events.emit('nodes:contentWritten', { nodeId: instance.id });
    return true;
  }

  /**
   * Put a node back exactly as it was: same id, same ordinal, same content.
   *
   * Goes through `_add`, which is the single creation path, so naming, module
   * registration and network registration cannot drift from the ordinary one.
   *
   * A VST node's plugins keep their instance ids, which is what its bindings
   * name. Deleting the node took those plugins out of the engine, and `_add`
   * creates nothing there: `nodes:restored` is what `chainSync` answers by
   * creating them again, with their state and their bypass.
   */
  restoreInstance(entry) {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') return null;
    if (this.instances.has(entry.id)) return this.instances.get(entry.id);
    const type = getNodeType(entry.type);
    if (!type) return null;
    const instance = this._add(entry.type, restoredContentFor(entry.content),
      { id: entry.id, ordinal: entry.ordinal });
    if (instance) this.hub.events.emit('nodes:restored', { nodeId: instance.id });
    return instance;
  }

  /** Delete a user-created instance (native/system nodes are never deletable). */
  delete(id) {
    const instance = this.instances.get(id);
    if (!instance) return false;
    if (getNodeType(instance.type)?.deletable === false) return false;
    // Tear the chain down in the engine FIRST. Deleting the node only removed
    // it from the network, so `engineSync` stopped seeing it and its chain kept
    // its last `outputEnabled=true` — a deleted VST node went on making sound
    // and kept its plugins (and their editor windows) alive forever.
    if (instance.type === 'vst' && this.hub.engine) {
      if (this.hub.control?.pendingLearn?.nodeId === id) {
        this.hub.control.cancelLearn(id, null, 'node-deleted');
      }
      this.hub.engine.setChainMidiEnabled(id, false);
      const plugins = (instance.content && Array.isArray(instance.content.plugins))
        ? instance.content.plugins
        : [];
      for (const plugin of plugins) {
        this.hub.engine.removeInstance(id, plugin.id);
      }
    }
    this.layout.remove(id);
    // A fixed module (currently Sequencer) is the project-wide editor for data
    // that outlives its Patch Bay routing presence. Removing that node must not
    // make the editor — and therefore its Stop control / arrangement — vanish.
    // Its routing node has no module to unregister, so it is dropped directly;
    // every other node leaves through `unregister`, which now removes the
    // routing node it registered (the network cleans up its own connections).
    if (getNodeType(instance.type)?.fixedModuleId) this.hub.network.removeNode(id);
    else this.hub.modules.unregister(id);
    this.instances.delete(id);
    this._persist();
    return true;
  }

  _registerModule(instance) {
    const type = getNodeType(instance.type);
    const manager = this;
    const hub = this.hub;
    // Sequencer keeps its existing fixed page/sidebar module. Its persisted
    // project instance contributes only the network node, avoiding a duplicate
    // module id while keeping NodeInstanceManager as the sole instance store.
    if (type.fixedModuleId) {
      if (!hub.network.getNode(instance.id)) hub.network.addNode(buildRoutingNode(instance, hub));
      return;
    }
    const commands = NODE_COMMANDS[instance.type];
    const module = {
      id: instance.id,
      name: instance.name,
      navEntry: { label: instance.name, icon: type.icon, accent: instance.type, group: 'node' },
      routingNode: buildRoutingNode(instance, hub),
      ...(commands ? { controlCommands: () => commands(hub, instance.id) } : {}),
      mount(container) {
        const editor = getNodeEditor(type.id);
        // Fresh at each mount: `state` is what this opening of the page
        // remembers, and it must not leak into the next one (nodeEditors.js).
        const context = { instance, type, hub, manager, state: {} };
        const paint = () => {
          container.innerHTML = editor ? editor.render(context) : renderGenericShell(instance, type);
        };
        paint();

        const disposers = createDisposers();
        // An undo or a redo changed this node under the page drawing it. The
        // canvas listens for this; a page that did not went on showing the
        // node as it was before the Ctrl+Z (2026-09-12).
        disposers.add(hub.events.on('history:applied', () => {
          if (!manager.instances.has(instance.id)) return; // deleted by this very undo
          if (editor?.refresh) editor.refresh(container, context);
          else paint();
        }));
        // Every page has its Delete button. The handler belongs to this mount
        // and leaves with it: attached to the shared `#content` and never
        // removed, "Delete Node" on any page once deleted a node visited earlier.
        disposers.listen(container, 'click', (e) => {
          if (!e.target.closest('#node-delete')) return;
          manager.delete(instance.id);
          hub.modules.activate('home', container);
        });
        // The page's own listeners, and their teardown, are the editor's: this
        // file knows nothing of any of them (invariant 8).
        if (editor?.bind) disposers.add(editor.bind(container, context));
        module._disposers = disposers;
      },
      unmount() {
        if (module._disposers) {
          module._disposers.dispose();
          module._disposers = null;
        }
      }
    };
    this.hub.modules.register(module);
  }

  /**
   * Save a node whose page has just edited its content in place.
   *
   * A page's controls write `instance.content` directly -- that is where
   * `engineSync` reads a level or a pattern -- so the model is already right
   * and only the project is behind. Each page then says to the engine what
   * changed, which only the page knows.
   */
  persist() {
    return this._persist();
  }

  /**
   * Persisted form of an instance. `name` is deliberately NOT stored: it is
   * derived from type + ordinal, and storing both invites the two to drift.
   */
  _serialize(instance) {
    return {
      id: instance.id,
      type: instance.type,
      ordinal: instance.ordinal,
      content: instance.content
    };
  }

  _persist() {
    return this.hub.settings.set(KEY, {
      instances: this.list().map((inst) => this._serialize(inst)),
      idSeq: { ...this._idSeq }
    });
  }
}
