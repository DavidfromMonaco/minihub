import { AUDIO_PLAYER_TYPE } from './audioPlayerState.js';

/**
 * The project's Audio Player nodes, as the engine plays them.
 *
 * WHAT THIS KEEPS IN STEP
 * -----------------------
 * A node's content names a file, a loop and a level (audioPlayerState.js). The
 * level is a value of the audio network and travels with it (engineSync.js);
 * the file and the loop go to the engine here, as ONE list of every player of
 * the project, sent whenever it may have changed: a node added or removed, a
 * content changed, an engine started. A player the list leaves out holds no
 * file afterwards, which is how a deleted node, a closed project or a renderer
 * that reloaded can never leave a file playing that nothing on screen names.
 *
 * What the engine says back is kept here for the node's page and the agent: of
 * each file, whether it is loading, ready -- with its length, its rate and its
 * overview -- or why it cannot be played (`audioPlayerFile`); of each player,
 * whether it plays, and where (`audioPlayerStatus`, ten times a second while it
 * plays).
 *
 * DESCRIBE
 * --------
 * A renderer that opens while the engine already holds the files never sees
 * them load. So the list asks the engine to describe every player this file has
 * no answer for, under the path the node names now.
 */

const FILE_STATES = new Set(['empty', 'loading', 'ready', 'error']);
const PLAYER_STATES = new Set(['stopped', 'playing', 'paused']);
const ACTIONS = new Set(['play', 'pause', 'stop', 'seek']);
const MAX_PEAKS = 4096;

const now = () => globalThis.performance?.now?.() ?? Date.now();

function readFile(msg) {
  const number = (value) => (Number.isFinite(value) && value > 0 ? value : 0);
  return {
    state: FILE_STATES.has(msg.state) ? msg.state : 'error',
    filePath: typeof msg.filePath === 'string' ? msg.filePath : '',
    message: typeof msg.message === 'string' ? msg.message : '',
    durationSeconds: number(msg.durationSeconds),
    sampleRate: number(msg.sampleRate),
    channels: Number.isInteger(msg.channels) && msg.channels > 0 ? msg.channels : 0,
    format: typeof msg.format === 'string' ? msg.format : '',
    peaks: Array.isArray(msg.peaks)
      ? msg.peaks.slice(0, MAX_PEAKS).map((peak) => (Number.isFinite(peak) ? Math.max(0, Math.min(1, peak)) : 0))
      : []
  };
}

export class AudioPlayerNodes {
  constructor(hub) {
    this.hub = hub;
    /** nodeId -> what the engine last said of its file. */
    this._files = new Map();
    /** nodeId -> where it last said the player was, and when that was heard. */
    this._statuses = new Map();
    /** The list last sent, without its requests, as JSON. */
    this._sent = '';
    /** Nodes whose file is to be read again from the disk. */
    this._reload = new Set();
    this._queued = false;
    /** Whether this file has seen the engine running since it last stopped. */
    this._engineRunning = false;
    this._unsubs = [
      hub.events.on('network:change', (change) => this._onNetworkChange(change)),
      hub.events.on('audioPlayer:contentChanged', () => this.sync()),
      hub.events.on('engine:state', (state) => this._onEngineState(state)),
      // A renderer that opens while the engine already runs never sees it
      // start (engineClient.init); the device state it then asks for is the
      // first sign given here, as it is for the One Ring nodes.
      hub.events.on('engine:deviceState', () => this._onEngineUp()),
      hub.events.on('engine:audioPlayerFile', (msg) => this._acceptFile(msg)),
      hub.events.on('engine:audioPlayerStatus', (msg) => this._acceptStatus(msg))
    ];
  }

  isPlayer(nodeId) {
    return this.hub.nodes?.get?.(nodeId)?.type === AUDIO_PLAYER_TYPE;
  }

  /** The players of the project: in the network, which a deleted node has left. */
  list() {
    return (this.hub.nodes?.list?.() || [])
      .filter((node) => node.type === AUDIO_PLAYER_TYPE && this.hub.network?.getNode?.(node.id));
  }

  /** What the engine last said of the node's file, or null. */
  fileOf(nodeId) {
    return this._files.get(nodeId) ?? null;
  }

  /** Where the engine last said the player was, or null. `at` is when that was heard. */
  statusOf(nodeId) {
    return this._statuses.get(nodeId) ?? null;
  }

  /**
   * How long the longest file that can be heard lasts, in seconds, or 0.
   *
   * An export plays every player from its beginning, and a project whose sound
   * comes from players alone has no arrangement to measure: without this, its
   * export stopped after one bar. A player counts once its file is read and
   * something is cabled to it; a muted one plays silence. A looping one counts
   * its file once -- a loop has no end to find.
   */
  longestHeardSeconds() {
    let longest = 0;
    for (const node of this.list()) {
      if (node.content?.muted === true) continue;
      if (!this.hub.network?.connectionsFrom?.(node.id)?.length) continue;
      const file = this._files.get(node.id);
      if (file?.state === 'ready') longest = Math.max(longest, file.durationSeconds);
    }
    return longest;
  }

  /** Whether a player plays: the transport's Stop has something to stop. */
  anyPlaying() {
    for (const [nodeId, status] of this._statuses) {
      if (status.state === 'playing' && this.isPlayer(nodeId)) return true;
    }
    return false;
  }

  /**
   * Send the list, once for everything changed in the same turn -- a project
   * that opens adds all its players at once.
   */
  sync() {
    if (this._queued) return true;
    this._queued = true;
    queueMicrotask(() => {
      this._queued = false;
      this._send();
    });
    return true;
  }

  /** The node's file, read again from the disk: edited elsewhere, or back where it was. */
  reload(nodeId) {
    if (!this.isPlayer(nodeId)) return false;
    this._reload.add(nodeId);
    return this.sync();
  }

  play(nodeId) { return this.transport(nodeId, 'play'); }
  pause(nodeId) { return this.transport(nodeId, 'pause'); }
  stop(nodeId) { return this.transport(nodeId, 'stop'); }
  seek(nodeId, seconds) { return this.transport(nodeId, 'seek', seconds); }

  /** Played, not authored: nothing here is an edit of the project. */
  transport(nodeId, action, seconds) {
    if (!this.isPlayer(nodeId)) return Promise.resolve({ ok: false, reason: 'node-not-found' });
    if (!ACTIONS.has(action)) return Promise.resolve({ ok: false, reason: 'invalid-action' });
    if (action === 'seek' && !(Number.isFinite(seconds) && seconds >= 0)) {
      return Promise.resolve({ ok: false, reason: 'invalid-position' });
    }
    return Promise.resolve(this.hub.engine.audioPlayerTransport(nodeId, action, seconds));
  }

  dispose() {
    for (const off of this._unsubs) off?.();
    this._unsubs = [];
  }

  _send() {
    if (this.hub.engine?.state !== 'running') return false;
    this._engineRunning = true;
    const players = this.list().map((node) => {
      const content = node.content || {};
      const entry = { nodeId: node.id, filePath: content.filePath || '', loop: content.loop === true };
      if (this._files.get(node.id)?.filePath !== entry.filePath) entry.describe = true;
      if (this._reload.has(node.id)) entry.reload = true;
      return entry;
    });
    const key = JSON.stringify(players.map(({ nodeId, filePath, loop }) => ({ nodeId, filePath, loop })));
    if (key === this._sent && !players.some((entry) => entry.describe || entry.reload)) return false;
    this._sent = key;
    this._reload.clear();
    // Not carried: the next change sends it again instead of trusting it landed.
    const forget = () => { if (this._sent === key) this._sent = ''; };
    Promise.resolve(this.hub.engine.syncAudioPlayers(players))
      .then((result) => { if (result?.ok === false) forget(); })
      .catch(forget);
    return true;
  }

  _onNetworkChange(change) {
    if (change?.type === 'add' && this.isPlayer(change.nodeId)) {
      this.sync();
      return;
    }
    if (change?.type !== 'remove') return;
    // A node being deleted is still an instance when the network lets it go;
    // one of a project being closed may not be, but it was in the list sent.
    const wasPlayer = this.isPlayer(change.nodeId) || this._files.has(change.nodeId)
      || this._statuses.has(change.nodeId) || this._sent.includes(JSON.stringify(change.nodeId));
    if (!wasPlayer) return;
    this._files.delete(change.nodeId);
    this._statuses.delete(change.nodeId);
    this.sync();
    this.hub.events.emit('audioPlayer:gone', { nodeId: change.nodeId });
  }

  _onEngineUp() {
    if (this._engineRunning || this.hub.engine?.state !== 'running') return;
    this._engineRunning = true;
    this._sent = '';
    this.sync();
  }

  _onEngineState(state) {
    // The engine client repeats its state; only a change of it matters here.
    const running = state?.state === 'running';
    if (running === this._engineRunning) return;
    this._engineRunning = running;
    // Every file left with the engine that held it. A new engine is given the
    // list again, and reads every file anew.
    const known = [...new Set([...this._files.keys(), ...this._statuses.keys()])];
    this._files.clear();
    this._statuses.clear();
    this._sent = '';
    for (const nodeId of known) this.hub.events.emit('audioPlayer:gone', { nodeId });
    if (running) this.sync();
  }

  _acceptFile(msg) {
    if (!this.isPlayer(msg?.nodeId)) return;
    const file = readFile(msg);
    this._files.set(msg.nodeId, file);
    this.hub.events.emit('audioPlayer:file', { nodeId: msg.nodeId, file });
  }

  _acceptStatus(msg) {
    if (!this.isPlayer(msg?.nodeId)) return;
    const status = {
      state: PLAYER_STATES.has(msg.state) ? msg.state : 'stopped',
      positionSeconds: Number.isFinite(msg.positionSeconds) && msg.positionSeconds > 0 ? msg.positionSeconds : 0,
      ended: Number.isSafeInteger(msg.ended) && msg.ended > 0 ? msg.ended : 0,
      at: now()
    };
    this._statuses.set(msg.nodeId, status);
    this.hub.events.emit('audioPlayer:status', { nodeId: msg.nodeId, status });
  }
}
