import {
  CHANNEL_COMMANDS, CHANNEL_COUNT, MEMORY_COMMANDS, TICKS_PER_BEAT, VOICE_COUNT, WRITER_COMMANDS, WRITE_MODE,
  defaultWriter, engineSequence, readMaterial, readNoteList, voiceValid
} from './oneRingSequence.js';

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
 *
 * THE MATERIAL TRAVELS ON ITS OWN
 * -------------------------------
 * What a node plays notes from changes in the engine -- a capture ends, a step
 * clears it -- and in the content -- a clip loaded, an edit undone. Sent inside
 * the sequence, each change would publish a new plan, and a new plan releases
 * what Legato holds. So the material goes by `setOneRingMaterial`, and comes
 * back by `oneRingMaterial`, which the content takes as an edit, as a take
 * becomes a clip (D-032). The material last sent or received is remembered, so
 * neither side is sent back what it already holds.
 *
 * A GENERATION IS WRITTEN HERE, ONCE
 * ----------------------------------
 * A WRITE in the engine sends `oneRingWrite`: the notes the voices played over
 * the writer's window. It is written through the Sequencer where the node's
 * writer says, and the node counts it -- in the same turn, so the clip and the
 * count are one undo step. A generation from a runtime the node no longer has
 * -- a sequence republished, an engine restarted, a project closed -- is not
 * written: the generation number would name the wrong thing. What could not be
 * written is counted and its reason kept, for the page and the agent.
 */

const TYPE = 'one-ring';
const MAX_REFUSALS_LOGGED = 20;

const sentKey = (content) => JSON.stringify({ ...engineSequence(content), selectedScene: null });
const CAPTURE_STATES = Object.freeze(['off', 'armed', 'capturing']);

function readStatus(msg, previous) {
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
    guarded: count(msg.guarded),
    capture: CAPTURE_STATES[msg.capture] ?? 'off',
    captured: count(msg.captured),
    captureRefused: count(msg.captureRefused),
    originNotes: count(msg.originNotes),
    currentNotes: count(msg.currentNotes),
    hasCurrent: msg.hasCurrent === true,
    frozen: msg.frozen === true,
    materialGeneration: count(msg.materialGeneration),
    sounding: Array.from({ length: VOICE_COUNT }, (_, v) => count(msg.sounding?.[v])),
    notesRefused: count(msg.notesRefused),
    // Sent only when they moved: otherwise the ones last sent still hold.
    voices: Array.isArray(msg.voices) && msg.voices.length === VOICE_COUNT && msg.voices.every(voiceValid)
      ? msg.voices : previous?.voices ?? null,
    // The engine's side of the writer: generations sent, those that found no
    // room on their way, those a WRITE made of nothing.
    writes: count(msg.writes),
    writesDropped: count(msg.writesDropped),
    writesEmpty: count(msg.writesEmpty),
    feedback: msg.feedback === true,
    // Feedback turned itself off at its limit.
    feedbackStopped: msg.feedbackStopped === true
  };
}

const emptyWrites = () => ({ written: 0, refused: 0, lastRefusal: '', last: null });

export class OneRingNodes {
  constructor(hub) {
    this.hub = hub;
    /** nodeId -> the runtime generation the engine reported for it. */
    this._generations = new Map();
    /** nodeId -> its last status. */
    this._statuses = new Map();
    /** nodeId -> the content last sent, without its scene. */
    this._sent = new Map();
    /** nodeId -> why its last command or sequence was refused; '' once one is taken. */
    this._refusals = new Map();
    /** nodeId -> the material the engine holds, as JSON: last sent, or last reported. */
    this._materials = new Map();
    /** nodeId -> what was written of its generations this session, and what was refused. */
    this._writes = new Map();
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
      hub.events.on('engine:oneRingStatus', (msg) => this._acceptStatus(msg)),
      hub.events.on('engine:oneRingMaterial', (msg) => this._acceptMaterial(msg)),
      hub.events.on('engine:oneRingWrite', (msg) => this._acceptWrite(msg)),
      hub.events.on('oneRing:refusal', (msg) => {
        if (this.isOneRing(msg?.nodeId)) this._refusals.set(msg.nodeId, String(msg.message || ''));
      })
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

  /**
   * A memory command asked by a person or an agent: a capture (armed for the
   * next bar of what plays), its end, or one of the material's own commands.
   */
  memory(nodeId, name) {
    if (!MEMORY_COMMANDS.includes(name)) return Promise.resolve({ ok: false, reason: 'invalid-command' });
    return this.command(nodeId, 'memory', { name });
  }

  /** WRITE, FEEDBACK_ON or FEEDBACK_OFF, asked by a person or an agent. */
  writer(nodeId, name) {
    return this.command(nodeId, 'writer', { name });
  }

  /**
   * The generations written since the session began: how many, how many were
   * refused and the last reason, and where the last one went
   * (`{ number, trackId, clipId }`).
   */
  writesOf(nodeId) {
    const record = this._writes.get(nodeId) ?? emptyWrites();
    return { ...record, last: record.last ? { ...record.last } : null };
  }

  /** Why the node's last command or sequence was refused, or ''. */
  refusalOf(nodeId) {
    return this._refusals.get(nodeId) ?? '';
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
    const sequenceDue = restore || this._sent.get(nodeId) !== key;
    if (sequenceDue) {
      this._sent.set(nodeId, key);
      const sequence = engineSequence(node.content);
      this._send(this._sent, nodeId, key, () => this.hub.engine.syncOneRing(nodeId, sequence, restore));
    }
    const materialDue = this._syncMaterial(nodeId, node.content.material, restore);
    return sequenceDue || materialDue;
  }

  /** The material, sent after the sequence it belongs to, when the engine does not hold it already. */
  _syncMaterial(nodeId, material, force) {
    if (!material) return false;
    const key = JSON.stringify(material);
    if (!force && this._materials.get(nodeId) === key) return false;
    this._materials.set(nodeId, key);
    this._send(this._materials, nodeId, key, () => this.hub.engine.setOneRingMaterial?.(nodeId, material));
    return true;
  }

  _send(memory, nodeId, key, send) {
    // Not carried: the next change sends it again instead of trusting it landed.
    const forget = () => { if (memory.get(nodeId) === key) memory.delete(nodeId); };
    Promise.resolve(send())
      .then((result) => { if (result?.ok === false) forget(); })
      .catch(forget);
  }

  syncAll() {
    for (const node of this.hub.nodes?.list?.() || []) {
      if (node.type === TYPE) this.sync(node.id, { restore: true });
    }
  }

  /**
   * RUN, STOP, a channel command (`{ channel: 1-16, name }`), a scene recall
   * (`{ scene }`), or a memory or writer command (`{ name }`), for the node's
   * current runtime. Played, not authored.
   */
  command(nodeId, command, { channel, name, scene } = {}) {
    const generation = this.generationOf(nodeId);
    if (generation === null) return Promise.resolve({ ok: false, reason: 'not-running' });
    const fields = {};
    if (command === 'memory' || command === 'writer') {
      const names = command === 'memory' ? MEMORY_COMMANDS : WRITER_COMMANDS;
      if (!names.includes(name)) return Promise.resolve({ ok: false, reason: 'invalid-command' });
      fields.name = name;
    } else if (command === 'channel') {
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
    this._refusals.delete(nodeId);
    this._materials.delete(nodeId);
    this._writes.delete(nodeId);
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
    this._refusals.clear();
    this._materials.clear();
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
      this._refusals.set(msg.nodeId, `sequence refused: ${msg.message || 'no reason'}`);
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
    const status = readStatus(msg, this._statuses.get(msg.nodeId));
    this._statuses.set(msg.nodeId, status);
    this.hub.events.emit('oneRing:status', { nodeId: msg.nodeId, status });
    this._keepScene(msg.nodeId, status.scene);
  }

  _acceptMaterial(msg) {
    if (!this.isOneRing(msg?.nodeId) || msg.generation !== this._generations.get(msg.nodeId)) return;
    let material;
    try {
      material = readMaterial(msg.material);
    } catch (error) {
      this.hub.diagnostics?.log?.(`one-ring: ${msg.nodeId} material unreadable -- ${error?.message || error}`);
      return;
    }
    this._materials.set(msg.nodeId, JSON.stringify(material));
    const node = this.hub.nodes.get(msg.nodeId);
    if (JSON.stringify(node.content.material) === JSON.stringify(material)) return;
    // What the engine made of the material is authored, as a take's clip is.
    this.hub.nodes.setContent(msg.nodeId, { ...node.content, material });
  }

  _acceptWrite(msg) {
    if (!this.isOneRing(msg?.nodeId) || msg.generation !== this._generations.get(msg.nodeId)) return;
    const node = this.hub.nodes.get(msg.nodeId);
    const writer = node.content.writer ?? defaultWriter();
    const number = writer.written + 1;
    let result;
    try {
      const list = readNoteList(msg.notes, 'generation');
      const notes = list.notes.map((note) => ({
        pitch: note.pitch, velocity: note.velocity, channel: note.channel,
        startPpq: note.start / TICKS_PER_BEAT, durationPpq: note.duration / TICKS_PER_BEAT
      }));
      const lengthPpq = list.length / TICKS_PER_BEAT;
      const sequencer = this.hub.sequencer;
      if (typeof sequencer?.writeGeneration !== 'function') {
        result = { ok: false, reason: 'no-sequencer', message: 'there is no Sequencer to write into' };
      } else if (writer.mode === WRITE_MODE.newTrack) {
        // Where it was heard: the arrangement's position at the WRITE, less
        // the window. With the transport at rest, the playhead.
        const heard = msg.transportPlaying === true && Number.isFinite(msg.transportBeat)
          ? Math.max(0, msg.transportBeat - lengthPpq) : null;
        const name = `${node.name || 'One Ring'} Generation ${number}`;
        result = sequencer.writeGeneration({
          mode: 'new-track', name, destination: writer.destination, startPpq: heard, lengthPpq, notes
        });
      } else {
        result = sequencer.writeGeneration({
          mode: writer.mode === WRITE_MODE.add ? 'add' : 'replace', clipId: writer.clipId, lengthPpq, notes
        });
      }
    } catch (error) {
      result = { ok: false, reason: 'invalid-generation', message: String(error?.message || error) };
    }
    const record = this._writes.get(msg.nodeId) ?? emptyWrites();
    this._writes.set(msg.nodeId, record);
    if (!result?.ok) {
      record.refused += 1;
      record.lastRefusal = String(result?.message || result?.reason || 'refused');
      if (this._refusalsLogged < MAX_REFUSALS_LOGGED) {
        this._refusalsLogged += 1;
        this.hub.diagnostics?.log?.(`one-ring: ${msg.nodeId} generation not written -- ${record.lastRefusal}`);
      }
      this.hub.events.emit('oneRing:writeRefused', { nodeId: msg.nodeId, reason: result?.reason, message: record.lastRefusal });
      return;
    }
    record.written += 1;
    record.last = { number, trackId: result.trackId, clipId: result.clipId };
    // Counted in the content, in the same turn as the clip: one undo step.
    this.hub.nodes.setContent(msg.nodeId, { ...node.content, writer: { ...writer, written: number } });
    this.hub.events.emit('oneRing:written', { nodeId: msg.nodeId, number, ...result });
  }

  _keepScene(nodeId, scene) {
    const node = this.hub.nodes.get(nodeId);
    if (!node || node.content.selectedScene === scene || !node.content.scenes?.[scene]) return;
    const write = () => this.hub.nodes.setContent(nodeId, { ...node.content, selectedScene: scene });
    if (typeof this.hub.perform === 'function') this.hub.perform(write);
    else write();
  }
}
