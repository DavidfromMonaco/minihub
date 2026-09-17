import { CHANNEL_COMMANDS, CHANNEL_COUNT } from './oneRingSequence.js';

/**
 * The project's One Ring nodes, as the engine runs them.
 *
 * WHAT THIS KEEPS IN STEP
 * -----------------------
 * A node's content is its sequence (oneRingSequence.js); the engine runs a copy
 * (native one_ring/runtime.h). This file sends that copy when the content
 * changes, sends every one again when an engine starts, and takes a node's
 * runtime away when the node goes. It remembers which runtime generation each
 * node has -- the identity CommandBus gives a native command source, as a
 * plugin's generation is for a plugin -- and the last status each one
 * reported, for the node's page.
 *
 * WHY THE SCENE IS WRITTEN BACK, AND NOTHING ELSE
 * -----------------------------------------------
 * The VST saved the scene that was playing, so a project reopened where it was
 * left. The node does the same: when the engine reports another scene, the
 * content takes it, as performance (`hub.perform`): no undo step, no
 * "modified". Sending that content back to the engine would publish a new plan
 * for nothing, and a new plan releases what Legato holds -- a PLAY held by a
 * channel would stop and start again. So a content that differs from the last
 * one sent only by its scene is not sent.
 */

const TYPE = 'one-ring';
const MAX_REFUSALS_LOGGED = 20;

const sentKey = (content) => JSON.stringify({ ...content, selectedScene: null });

function readStatus(msg) {
  const list = (value, check, fallback) => Array.from({ length: CHANNEL_COUNT },
    (_, i) => (Array.isArray(value) && check(value[i]) ? value[i] : fallback));
  const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
  return {
    playing: msg.playing === true,
    beat: Number.isFinite(msg.beat) ? msg.beat : 0,
    bpm: Number.isFinite(msg.bpm) ? msg.bpm : 0,
    scene: Number.isInteger(msg.scene) && msg.scene >= 0 ? msg.scene : 0,
    // A Next bar recall that has not played yet, or -1.
    pendingScene: Number.isInteger(msg.pendingScene) && msg.pendingScene >= 0 ? msg.pendingScene : -1,
    playheads: list(msg.playheads, (v) => Number.isInteger(v) && v >= -1, -1),
    active: list(msg.active, (v) => typeof v === 'boolean', false),
    rejected: count(msg.rejected),
    guarded: count(msg.guarded)
  };
}

export class OneRingNodes {
  constructor(hub) {
    this.hub = hub;
    /** nodeId -> the runtime generation the engine reported for it. */
    this._generations = new Map();
    /** nodeId -> its last status. */
    this._statuses = new Map();
    /** nodeId -> the content last sent, without its scene. */
    this._sent = new Map();
    this._refusalsLogged = 0;
    /** Whether this file has seen the engine running since it last stopped. */
    this._engineRunning = false;
    this._unsubs = [
      hub.events.on('network:change', (change) => this._onNetworkChange(change)),
      hub.events.on('oneRing:contentChanged', (msg) => this.sync(msg?.nodeId)),
      hub.events.on('engine:state', (state) => this._onEngineState(state)),
      // A renderer that opens while the engine already runs never sees it
      // start: the engine client learns it from a query and says nothing
      // (engineClient.init), and the project's nodes were loaded before that.
      // The device state it then asks for is the first sign given here.
      hub.events.on('engine:deviceState', () => this._onEngineUp()),
      hub.events.on('engine:oneRingSynced', (msg) => this._acceptSynced(msg)),
      hub.events.on('engine:oneRingStatus', (msg) => this._acceptStatus(msg))
    ];
  }

  isOneRing(nodeId) {
    return this.hub.nodes?.get?.(nodeId)?.type === TYPE;
  }

  /** The node's current runtime generation, or null while the engine has none. */
  generationOf(nodeId) {
    return this._generations.get(nodeId) ?? null;
  }

  /** What the node's runtime last reported, or null. */
  statusOf(nodeId) {
    return this._statuses.get(nodeId) ?? null;
  }

  /** Whether a node's runtime last said it plays: the transport's Stop has something to stop. */
  anyPlaying() {
    for (const status of this._statuses.values()) if (status.playing) return true;
    return false;
  }

  /**
   * Send a node's sequence. `restore` says the file is speaking -- a project
   * opened, an engine started -- and the engine takes the saved scene; an edit
   * keeps the scene that plays. False when there is nothing to send it to.
   */
  sync(nodeId, { restore = false } = {}) {
    const node = this.hub.nodes?.get?.(nodeId);
    if (!node || node.type !== TYPE || this.hub.engine?.state !== 'running') return false;
    this._engineRunning = true;
    const key = sentKey(node.content);
    if (!restore && this._sent.get(nodeId) === key) return false;
    this._sent.set(nodeId, key);
    Promise.resolve(this.hub.engine.syncOneRing(nodeId, node.content, restore))
      .then((result) => {
        // Not carried: the next change sends it again instead of trusting it landed.
        if (result?.ok === false && this._sent.get(nodeId) === key) this._sent.delete(nodeId);
      })
      .catch(() => {
        if (this._sent.get(nodeId) === key) this._sent.delete(nodeId);
      });
    return true;
  }

  syncAll() {
    for (const node of this.hub.nodes?.list?.() || []) {
      if (node.type === TYPE) this.sync(node.id, { restore: true });
    }
  }

  /**
   * RUN, STOP, a channel command (`{ channel: 1-16, name }`) or a scene recall
   * (`{ scene }`), for the node's current runtime. Played, not authored.
   */
  command(nodeId, command, { channel, name, scene } = {}) {
    const generation = this.generationOf(nodeId);
    if (generation === null) return Promise.resolve({ ok: false, reason: 'not-running' });
    const fields = {};
    if (command === 'channel') {
      if (!Number.isInteger(channel) || channel < 1 || channel > CHANNEL_COUNT || !CHANNEL_COMMANDS.includes(name)) {
        return Promise.resolve({ ok: false, reason: 'invalid-command' });
      }
      Object.assign(fields, { channel, name });
    } else if (command === 'scene') {
      if (!Number.isInteger(scene) || scene < 0 || !this.hub.nodes.get(nodeId)?.content?.scenes?.[scene]) {
        return Promise.resolve({ ok: false, reason: 'invalid-command' });
      }
      fields.scene = scene;
    } else if (command !== 'run' && command !== 'stop') {
      return Promise.resolve({ ok: false, reason: 'invalid-command' });
    }
    return Promise.resolve(this.hub.engine.oneRingCommand(nodeId, generation, command, fields));
  }

  dispose() {
    for (const off of this._unsubs) off?.();
    this._unsubs = [];
  }

  _forget(nodeId) {
    this._generations.delete(nodeId);
    this._statuses.delete(nodeId);
    this._sent.delete(nodeId);
  }

  _onNetworkChange(change) {
    if (change?.type === 'add' && this.isOneRing(change.nodeId)) {
      this.sync(change.nodeId, { restore: true });
    } else if (change?.type === 'remove' && (this._sent.has(change.nodeId) || this._generations.has(change.nodeId))) {
      this._forget(change.nodeId);
      if (this.hub.engine?.state === 'running') this.hub.engine.removeOneRing(change.nodeId);
      this.hub.events.emit('oneRing:gone', { nodeId: change.nodeId });
    }
  }

  _onEngineUp() {
    if (this._engineRunning || this.hub.engine?.state !== 'running') return;
    this._engineRunning = true;
    this.syncAll();
  }

  _onEngineState(state) {
    // The engine client repeats its state; only a change of it matters here.
    const running = state?.state === 'running';
    if (running === this._engineRunning) return;
    this._engineRunning = running;
    // Every runtime left with the engine that ran it. A new engine is given
    // every sequence, as it was saved.
    const known = [...new Set([...this._generations.keys(), ...this._sent.keys()])];
    this._generations.clear();
    this._statuses.clear();
    this._sent.clear();
    for (const nodeId of known) this.hub.events.emit('oneRing:gone', { nodeId });
    if (state?.state === 'running') this.syncAll();
  }

  _acceptSynced(msg) {
    if (!this.isOneRing(msg?.nodeId)) return;
    if (msg.ok !== true) {
      this._sent.delete(msg.nodeId);
      if (this._refusalsLogged < MAX_REFUSALS_LOGGED) {
        this._refusalsLogged += 1;
        this.hub.diagnostics?.log?.(`one-ring: ${msg.nodeId} sequence refused -- ${msg.message || 'no reason'}`);
      }
      this.hub.events.emit('oneRing:refused', { nodeId: msg.nodeId, message: String(msg.message || '') });
      return;
    }
    if (!Number.isSafeInteger(msg.generation) || msg.generation <= 0) return;
    const previous = this._generations.get(msg.nodeId);
    this._generations.set(msg.nodeId, msg.generation);
    if (previous !== msg.generation) {
      this._statuses.delete(msg.nodeId);
      this.hub.events.emit('oneRing:ready', { nodeId: msg.nodeId, generation: msg.generation });
    }
  }

  _acceptStatus(msg) {
    if (!this.isOneRing(msg?.nodeId) || msg.generation !== this._generations.get(msg.nodeId)) return;
    const status = readStatus(msg);
    this._statuses.set(msg.nodeId, status);
    this.hub.events.emit('oneRing:status', { nodeId: msg.nodeId, status });
    this._keepScene(msg.nodeId, status.scene);
  }

  _keepScene(nodeId, scene) {
    const node = this.hub.nodes.get(nodeId);
    if (!node || node.content.selectedScene === scene || !node.content.scenes?.[scene]) return;
    const write = () => this.hub.nodes.setContent(nodeId, { ...node.content, selectedScene: scene });
    if (typeof this.hub.perform === 'function') this.hub.perform(write);
    else write();
  }
}
