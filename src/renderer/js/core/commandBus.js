import { VALUE_TYPE, acceptsValue, compileTargets, outcomeOf, packetValue } from './commandRegistry.js';
import { SEQUENCER_NODE_ID } from './systemNodes.js';

/**
 * Commands a plugin sends MiniHub's modules, over the Patch Bay.
 *
 * A plugin that speaks the control connection (native
 * `control_source.h` -- One Ring is the first) plays its sequence in the audio
 * callback and queues fixed-size packets. The engine drains them at 60 Hz and
 * they arrive here as `engine:controlEvents`. This file decides what each one
 * may do, and does it through the module that owns the target.
 *
 * WHY A CABLE, AND NOT "EVERY MODULE"
 * -----------------------------------
 * Invariant 2: the network is the routing authority. A plugin commands exactly
 * the nodes its own node's CTRL OUT is cabled to -- that list is what it is
 * told, and it is checked again for every packet, because the cable can be
 * pulled between a note and the next. A sequence that can reach a node with no
 * cable drawn is a Patch Bay that no longer shows what drives what.
 *
 * WHY A COMMAND IS PERFORMANCE
 * ----------------------------
 * A step that changes the arpeggiator's rate is the instrument being played,
 * not the project being edited (D-032). Every command runs inside
 * `hub.perform()`: it moves what you hear and what the file would save, but it
 * is not an undo step, it does not mark the project modified, and forty steps a
 * second do not become forty writes of the settings file.
 *
 * WHY SOME COMMANDS ARE HELD
 * --------------------------
 * A target may declare that a command has a release -- PLAY's is STOP,
 * RECORD_ON's is RECORD_OFF. The plugin sends the release itself while it
 * runs. What it cannot send is the release it never gets to: its cable pulled,
 * its node deleted, the plugin bypassed or removed. So the bus remembers what
 * was started and releases it then -- once, only through the very target that
 * accepted it, and never into a project that replaced the one it was sent to.
 */

/** The cable a command travels: a node's CTRL OUT into a node's CTRL IN. */
export const COMMAND_OUT_PORT = 'ctrl-out';
export const COMMAND_IN_PORT = 'ctrl-in';

// What one drained batch may carry, the same bound the engine applies.
const EVENTS_PER_BATCH = 128;
const STATUS_CHARS = 1000;

// Shown in the plugin's own window, after the command's name.
const REFUSALS = Object.freeze({
  'target-not-connected': 'not cabled to this plugin',
  'unknown-command': 'unknown to its target',
  'wrong-type': 'wrong kind of value',
  'invalid-value': 'value out of range',
  'unknown-registry': 'sent before MiniHub listed its targets',
  'project-transition': 'the project is changing',
  'export-active': 'MiniHub is exporting',
  'asynchronous-command': 'not supported',
  refused: 'refused',
  failed: 'failed'
});

const sourceKey = (chainId, instanceId) => `${chainId}\u001f${instanceId}`;

export class CommandBus {
  constructor(hub) {
    this.hub = hub;
    /** One entry per running plugin instance that sends commands. */
    this.sources = new Map();
    /** VST nodes whose chain holds such a plugin, loaded or bypassed. */
    this._commandChains = new Set();
    /** nodeId -> its provider's compiled targets. Filled on demand, dropped on change. */
    this._compiled = new Map();
    /** source key -> the generation whose `instanceStatus: ready` has arrived. */
    this._readyGenerations = new Map();
    this._providerErrors = new Set();
    this._scheduled = false;
    this._disposed = false;
    const invalidateAll = () => this._invalidate(null);
    this._unsubs = [
      hub.events.on('engine:chainChanged', (msg) => this._acceptChain(msg)),
      hub.events.on('engine:instanceStatus', (msg) => this._acceptInstanceStatus(msg)),
      hub.events.on('engine:controlEvents', (msg) => this.dispatch(msg)),
      hub.events.on('engine:controlRegistryStatus', (msg) => this._acceptRegistryStatus(msg)),
      hub.events.on('engine:state', (state) => this._onEngineState(state)),
      hub.events.on('network:change', (change) => this._onNetworkChange(change)),
      hub.events.on('sequencer:changed', () => this._invalidate(SEQUENCER_NODE_ID)),
      hub.events.on('commands:providerChanged', (msg) => this._invalidate(msg?.nodeId ?? null)),
      hub.events.on('module:registered', invalidateAll),
      hub.events.on('module:unregistered', invalidateAll),
      hub.events.on('nodes:restored', invalidateAll),
      hub.events.on('history:applied', invalidateAll)
    ];
  }

  /** True when this node's CTRL OUT has something to send: the Patch Bay draws the jack. */
  sendsCommands(nodeId) {
    return this._commandChains.has(nodeId);
  }

  /**
   * What a source is cabled to, as compiled targets, each carrying the node it
   * is reached through. Reads the network every time: the answer is the cable,
   * not a list remembered from the last publication.
   */
  targetsOf(source) {
    const targets = [];
    const seen = new Set();
    for (const routeNodeId of this._routes(source)) {
      for (const target of this._targetsAt(routeNodeId)) {
        // Target ids are unique by construction (they start with the node id).
        // The plugin refuses a whole registry over one duplicate, so a provider
        // that breaks this loses its copy rather than the plugin losing all.
        if (seen.has(target.id)) continue;
        seen.add(target.id);
        targets.push(target);
      }
    }
    return targets;
  }

  /** Execute a batch of packets drained from one plugin instance. */
  dispatch(message) {
    const source = this.sources.get(sourceKey(message?.chainId, message?.instanceId));
    if (!source || message.pluginId !== source.pluginId || message.generation !== source.generation
        || !this._live(source)) return;
    const events = Array.isArray(message.events) ? message.events.slice(0, EVENTS_PER_BATCH) : [];
    for (const event of events) {
      // Sequence numbers only grow; a replayed or reordered packet is dropped.
      if (!event || !Number.isSafeInteger(event.sequence) || event.sequence <= source.sequence) continue;
      source.sequence = event.sequence;
      const result = this._execute(source, event);
      this._report(source, event, result);
    }
  }

  dispose() {
    this._disposed = true;
    for (const off of this._unsubs) off?.();
    this._unsubs = [];
    for (const source of this.sources.values()) this._releaseHeld(source, { all: true });
    this.sources.clear();
    this._commandChains.clear();
    this._compiled.clear();
  }

  // ---------- sources ----------

  _acceptChain(message) {
    const chainId = message?.chainId;
    if (typeof chainId !== 'string' || !chainId) return;
    const instances = Array.isArray(message.instances) ? message.instances : [];
    const sent = this._commandChains.has(chainId);
    const sends = instances.some((instance) => instance?.controlSource === true);
    if (sends) this._commandChains.add(chainId);
    else this._commandChains.delete(chainId);

    const keep = new Set();
    for (const instance of instances) {
      if (instance?.controlSource !== true || instance.status !== 'ready' || instance.bypassed === true
          || typeof instance.instanceId !== 'string' || typeof instance.pluginId !== 'string'
          || !Number.isSafeInteger(instance.generation)) continue;
      const key = sourceKey(chainId, instance.instanceId);
      keep.add(key);
      const previous = this.sources.get(key);
      if (previous && previous.generation === instance.generation && previous.pluginId === instance.pluginId) continue;
      if (previous) this._releaseHeld(previous, { all: true });
      this.sources.set(key, {
        chainId,
        instanceId: instance.instanceId,
        pluginId: instance.pluginId,
        generation: instance.generation,
        // A source taken back out of bypass has had its state for a long time.
        restored: this._readyGenerations.get(key) === instance.generation,
        revision: 0,
        signature: null,
        sequence: 0,
        held: new Map(),
        status: '',
        failed: null
      });
    }
    for (const [key, source] of this.sources) {
      if (source.chainId !== chainId || keep.has(key)) continue;
      this._releaseHeld(source, { all: true });
      this.sources.delete(key);
    }
    // The chain's own plugins are targets for whatever is cabled into its CTRL IN.
    this._compiled.delete(chainId);
    if (sent !== sends) this.hub.events.emit('commands:sourcesChanged', { nodeId: chainId });
    this._schedule();
  }

  /**
   * A plugin's saved state goes in before its first list of targets.
   *
   * The engine reports a new instance twice: `chainChanged`, then
   * `instanceStatus: ready` -- and it is on the second that `chainSync.js` sends
   * the state saved with the project. A plugin checks a state it is given
   * against the targets it already knows, and One Ring refuses a whole saved
   * sequence over one step whose value the target no longer accepts (a track
   * number past the last track). Given the state first, it keeps every step,
   * and the target checks each value when the step plays. So nothing is
   * published before that second report -- and then only in a microtask, once
   * every listener of the report, chainSync's included, has sent what it sends.
   */
  _acceptInstanceStatus(message) {
    const key = sourceKey(message?.chainId, message?.instanceId);
    if (message?.status !== 'ready' || !Number.isSafeInteger(message.generation)) {
      this._readyGenerations.delete(key);
      return;
    }
    this._readyGenerations.set(key, message.generation);
    const source = this.sources.get(key);
    if (source && source.generation === message.generation && !source.restored) {
      source.restored = true;
      this._schedule();
    }
  }

  _onEngineState(state) {
    if (state?.state === 'running') return;
    // The runtime instances are gone with the engine. Their holds are released
    // in the renderer's own state -- a transport left "playing" by a crash.
    for (const source of this.sources.values()) this._releaseHeld(source, { all: true });
    this.sources.clear();
    this._readyGenerations.clear();
    const chains = [...this._commandChains];
    this._commandChains.clear();
    for (const nodeId of chains) this.hub.events.emit('commands:sourcesChanged', { nodeId });
  }

  _onNetworkChange(change) {
    if (change?.type === 'remove') {
      this._compiled.delete(change.nodeId);
      for (const [key, source] of this.sources) {
        if (source.chainId !== change.nodeId) continue;
        this._releaseHeld(source, { all: true });
        this.sources.delete(key);
      }
      for (const key of this._readyGenerations.keys()) {
        if (key.startsWith(`${change.nodeId}\u001f`)) this._readyGenerations.delete(key);
      }
      if (this._commandChains.delete(change.nodeId)) {
        this.hub.events.emit('commands:sourcesChanged', { nodeId: change.nodeId });
      }
    } else if (change?.type === 'ports') {
      // A mixer grew an input, and with it two commands.
      this._compiled.clear();
    }
    // Synchronously, before any publication: a hold whose cable was pulled is
    // released now, even if the cable comes back within the same turn.
    for (const source of this.sources.values()) this._releaseHeld(source);
    this._schedule();
  }

  _live(source) {
    const node = this.hub.nodes?.get?.(source.chainId);
    const plugin = node?.content?.plugins?.find?.((item) => item.id === source.instanceId);
    return !!plugin && plugin.pluginId === source.pluginId && plugin.bypassed !== true
      && this.hub.engine?.getInstanceGeneration?.(source.chainId, source.instanceId) === source.generation
      && this.hub.engine?.getInstanceStatus?.(source.chainId, source.instanceId) === 'ready';
  }

  // ---------- discovery and publication ----------

  _routes(source) {
    const routes = new Set();
    for (const cable of this.hub.network.connectionsFrom(source.chainId, COMMAND_OUT_PORT)) {
      if (cable.to.portId === COMMAND_IN_PORT) routes.add(cable.to.nodeId);
    }
    return routes;
  }

  _invalidate(nodeId) {
    if (typeof nodeId === 'string') this._compiled.delete(nodeId);
    else this._compiled.clear();
    this._schedule();
  }

  /** The module that answers for a node: the one whose routing node it is. */
  _providerAt(nodeId) {
    for (const module of this.hub.modules?.list?.() || []) {
      if (typeof module?.controlCommands !== 'function') continue;
      if ((module.routingNode?.id ?? module.id) === nodeId) return module;
    }
    return null;
  }

  _targetsAt(nodeId) {
    if (this._compiled.has(nodeId)) return this._compiled.get(nodeId);
    let targets = [];
    const module = this._providerAt(nodeId);
    if (module) {
      try {
        targets = compileTargets(module.controlCommands()).map((target) => ({ ...target, routeNodeId: nodeId }));
      } catch (error) {
        // Logged once per distinct defect: a provider asked on every change
        // would otherwise write the same line for as long as the cable is in.
        const line = `commands: ${nodeId} has no targets -- ${error?.message || error}`;
        if (!this._providerErrors.has(line)) {
          this._providerErrors.add(line);
          this.hub.diagnostics?.log?.(line);
        }
        targets = [];
      }
    }
    this._compiled.set(nodeId, targets);
    return targets;
  }

  _schedule() {
    if (this._scheduled || this._disposed || this.sources.size === 0) return;
    this._scheduled = true;
    queueMicrotask(() => {
      this._scheduled = false;
      if (!this._disposed) this.publish();
    });
  }

  /**
   * Tell every live source what it is cabled to, when that changed.
   *
   * The comparison is on what the plugin would receive, so a renamed track is a
   * publication and a moved clip is not.
   */
  publish() {
    for (const source of this.sources.values()) {
      if (!this._live(source)) {
        this._releaseHeld(source, { all: true });
        continue;
      }
      if (!source.restored) continue;
      const modules = this.targetsOf(source).map((target) => target.descriptor);
      const signature = JSON.stringify(modules);
      if (signature === source.signature) continue;
      source.signature = signature;
      source.revision += 1;
      const revision = source.revision;
      const forget = () => {
        // Not accepted: publish again at the next change instead of believing it landed.
        if (source.revision === revision) source.signature = null;
      };
      Promise.resolve(this.hub.engine?.setControlRegistry?.(source, { version: 1, revision, modules }))
        .then((result) => { if (result?.ok === false) forget(); })
        .catch(forget);
    }
  }

  _acceptRegistryStatus(message) {
    const source = this.sources.get(sourceKey(message?.chainId, message?.instanceId));
    if (!source || message.generation !== source.generation || message.revision !== source.revision) return;
    if (message.ok === true) return;
    source.signature = null;
    this.hub.diagnostics?.log?.(
      `commands: ${source.chainId}/${source.instanceId} refused its targets -- ${message.message || 'no reason'}`
    );
  }

  // ---------- execution ----------

  _execute(source, event) {
    if (this.hub.project?._transitionPending) return { ok: false, reason: 'project-transition' };
    if (this.hub.sequencer?.exporting) return { ok: false, reason: 'export-active' };
    // A packet can only name what a publication described. The revision is not
    // required to be the latest: target ids are identities that are never
    // reused, and the target is checked below against the cable as it is now.
    if (!Number.isSafeInteger(event.registryRevision) || event.registryRevision < 1
        || event.registryRevision > source.revision) return { ok: false, reason: 'unknown-registry' };
    const target = typeof event.target === 'string'
      ? this.targetsOf(source).find((item) => item.id === event.target)
      : null;
    if (!target) return { ok: false, reason: 'target-not-connected' };
    const command = typeof event.command === 'string' ? target.commands.get(event.command) : null;
    if (!command) return { ok: false, reason: 'unknown-command' };
    if (event.valueType !== command.type) return { ok: false, reason: 'wrong-type' };
    const decoded = packetValue(event.valueType, event.number);
    if (!decoded.ok || !acceptsValue(command, decoded.value)) return { ok: false, reason: 'invalid-value' };
    const result = this._run(command, decoded.value);
    if (result.ok) this._remember(source, target, command);
    return result;
  }

  _run(command, value) {
    const run = () => {
      try {
        return outcomeOf(command.execute(value));
      } catch (error) {
        return { ok: false, reason: 'failed', message: String(error?.message || error) };
      }
    };
    return typeof this.hub.perform === 'function' ? this.hub.perform(run) : run();
  }

  _remember(source, target, command) {
    // A release that ran ends the hold it releases.
    for (const [key, hold] of source.held) {
      if (hold.targetId === target.id && hold.release === command.id) source.held.delete(key);
    }
    if (!command.releaseCommand) return;
    source.held.set(`${target.id}\u001f${command.id}`, {
      targetId: target.id,
      routeNodeId: target.routeNodeId,
      lifetime: target.lifetime,
      release: command.releaseCommand
    });
  }

  /**
   * Release what a source started and can no longer stop itself.
   *
   * Without `all`, only holds whose cable is gone. During a project change the
   * holds are forgotten, never executed: the target they name belongs to the
   * project being replaced, and a RECORD_OFF must not land in the next one.
   */
  _releaseHeld(source, { all = false } = {}) {
    if (!source.held.size) return;
    if (this.hub.project?._transitionPending) {
      source.held.clear();
      return;
    }
    const routes = all ? null : this._routes(source);
    for (const [key, hold] of [...source.held]) {
      if (routes?.has(hold.routeNodeId)) continue;
      source.held.delete(key);
      const target = this._targetsAt(hold.routeNodeId).find((item) => item.id === hold.targetId);
      if (!target || target.lifetime !== hold.lifetime) continue;
      const release = target.commands.get(hold.release);
      if (release?.type === VALUE_TYPE.none) this._run(release, undefined);
    }
  }

  _report(source, event, result) {
    this.hub.events.emit('commands:result', {
      chainId: source.chainId,
      instanceId: source.instanceId,
      sequence: event.sequence,
      target: event.target,
      command: event.command,
      ...result
    });
    // The plugin's window says why the last refused command was refused, and is
    // cleared by that same command succeeding -- not by any other.
    const key = `${event.target}\u001f${event.command}`;
    if (result.ok && source.failed !== key) return;
    source.failed = result.ok ? null : key;
    const reason = result.message || REFUSALS[result.reason] || result.reason;
    const status = result.ok ? '' : `${event.command}: ${reason}`.slice(0, STATUS_CHARS);
    if (status === source.status) return;
    source.status = status;
    Promise.resolve(this.hub.engine?.setControlStatus?.(source, status)).catch(() => {});
  }
}
