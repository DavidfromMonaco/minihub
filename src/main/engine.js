'use strict';

/**
 * Native audio engine supervisor (Electron main process).
 *
 * Launches `mlh-audio-engine.exe`, supervises its lifecycle (handshake, crash
 * detection, clean shutdown), and relays a versioned newline-delimited JSON
 * IPC protocol between the renderer and the engine. Audio samples never cross
 * this boundary — only CONTROL and MIDI messages.
 */

const { spawn } = require('child_process');
const readline = require('readline');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PROTOCOL_VERSION = 1;
let activeSupervisor = null;

function defaultExePath() {
  const candidates = [
    // Portable/packaged layout: resources/native/mlh-audio-engine.exe.
    // `process.resourcesPath` is supplied by Electron and remains stable even
    // when the user launches MiniHub from a shortcut or another directory.
    path.join(process.resourcesPath || '', 'native', 'mlh-audio-engine.exe'),
    path.join(__dirname, '../../native/audio-engine/build/Release/mlh-audio-engine.exe'),
    path.join(__dirname, '../../native/audio-engine/build/Debug/mlh-audio-engine.exe')
  ];
  return candidates.find((p) => fs.existsSync(p)) || candidates[0];
}

class EngineProcess {
  /**
   * @param {object} opts
   * @param {(msg: object) => void} opts.onEvent  engine event (JSON object)
   * @param {(state: string, error?: string) => void} opts.onStateChange
   * @param {(text: string) => void} [opts.onStderr]
   * @param {string} [opts.exePath]
   */
  constructor({ onEvent, onStateChange, onStderr, exePath }) {
    this.onEvent = onEvent || (() => {});
    this.onStateChange = onStateChange || (() => {});
    this.onStderr = onStderr || (() => {});
    this.exePath = exePath || defaultExePath();
    this.child = null;
    this._rl = null;
    this.state = 'stopped'; // stopped | starting | running | error
    this.error = null;
    this._shuttingDown = false;
    this._handshakeOk = false;
    this._stateCapturePending = null;
    this._shutdownAckPending = null;
  }

  get running() {
    return this.state === 'running';
  }

  executableSha256() {
    try { return crypto.createHash('sha256').update(fs.readFileSync(this.exePath)).digest('hex'); }
    catch (_) { return 'unavailable'; }
  }

  _emitState() {
    this.onStateChange(this.state, this.error);
  }

  start() {
    if (this.child) return;
    if (activeSupervisor && activeSupervisor !== this && activeSupervisor.child) {
      this.state = 'error';
      this.error = `Refusing a second live audio engine (existing pid=${activeSupervisor.child.pid || 'unknown'}).`;
      this._emitState();
      return;
    }
    this.state = 'starting';
    this.error = null;
    this._handshakeOk = false;
    this._emitState();

    if (!fs.existsSync(this.exePath)) {
      this.state = 'error';
      this.error = `Native engine not found at ${this.exePath}. Build it with CMake first.`;
      this._emitState();
      return;
    }

    try {
      const createdAt = new Date().toISOString();
      const args = ['--role', 'live', '--parent-pid', String(process.pid), '--created-at', createdAt];
      this.child = spawn(this.exePath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
      activeSupervisor = this;
      this.onStderr(`native-process role=live pid=${this.child.pid} parentPid=${process.pid} createdAt=${createdAt} audioDevice=owned lifetime=app reason=electron-main args=${JSON.stringify(args)} path=${this.exePath} sha256=${this.executableSha256()}`);
    } catch (err) {
      if (activeSupervisor === this) activeSupervisor = null;
      this.state = 'error';
      this.error = err.message;
      this._emitState();
      return;
    }

    this._rl = readline.createInterface({ input: this.child.stdout });
    this._rl.on('line', (line) => this._onLine(line));

    this.child.stderr.on('data', (d) => {
      const text = String(d).trim();
      if (text) {
        console.error('[engine]', text);
        this.onStderr(text.slice(0, 4096));
      }
    });

    this.child.on('error', (err) => {
      if (this._shuttingDown) return;
      this._fail(err.message);
    });

    this.child.on('exit', (code, signal) => this._onExit(code, signal));

    // Request a handshake.
    this.send({ v: PROTOCOL_VERSION, type: 'hello' });
  }

  _onLine(line) {
    const text = String(line).trim();
    if (!text) return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch (err) {
      // Ignore non-JSON noise (shouldn't happen — engine stdout is clean).
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'hello') {
      this._handshakeOk = true;
      this.state = 'running';
      this.error = null;
      this._emitState();
    }
    if (msg.type === 'shutdownAck') this._settleShutdownAck(true);
    if (msg.type === 'pluginStateCaptureComplete') this._settleStateCapture(true);
    this.onEvent(msg);
  }

  _onExit(code, signal) {
    this._settleStateCapture(false);
    this._settleShutdownAck(false);
    const wasRunning = this.state === 'running';
    this._rl = null;
    this.child = null;
    if (activeSupervisor === this) activeSupervisor = null;
    if (this._shuttingDown) {
      this.state = 'stopped';
      this.error = null;
      this._emitState();
      return;
    }
    // Unexpected exit = crash. Electron stays alive and surfaces an error.
    this.state = 'error';
    const codeLabel = Number.isInteger(code)
      ? `${code} (0x${(code >>> 0).toString(16).toUpperCase().padStart(8, '0')})`
      : String(code);
    this.error = `Audio engine exited unexpectedly (code=${codeLabel}, signal=${signal})`;
    this._emitState();
  }

  _fail(message) {
    this._settleStateCapture(false);
    this.state = 'error';
    this.error = message;
    if (!this.child && activeSupervisor === this) activeSupervisor = null;
    this._emitState();
  }

  /** Send a command object to the engine (thread-safe via single writer). */
  send(msg) {
    if (!this.child || !this.child.stdin) return false;
    try {
      this.child.stdin.write(`${JSON.stringify(msg)}\n`);
      return true;
    } catch (err) {
      console.error('[engine] send failed:', err);
      return false;
    }
  }

  /** Clean shutdown: ask the engine to quit, then force-kill if needed. */
  capturePluginStates(timeoutMs = 3000) {
    if (!this.child) return Promise.resolve(false);
    // Save, Save As and the close guard may request the same capture at nearly
    // the same time. Coalesce them onto one native snapshot transaction so no
    // later caller can overwrite an earlier resolver and manufacture a timeout.
    if (this._stateCapturePending) return this._stateCapturePending.promise;
    let resolveCapture;
    const promise = new Promise((resolve) => { resolveCapture = resolve; });
    const timer = setTimeout(() => this._settleStateCapture(false), timeoutMs);
    this._stateCapturePending = { promise, resolve: resolveCapture, timer };
    if (!this.send({ v: PROTOCOL_VERSION, type: 'capturePluginStates' }))
      this._settleStateCapture(false);
    return promise;
  }

  _settleStateCapture(ok) {
    const pending = this._stateCapturePending;
    if (!pending) return false;
    this._stateCapturePending = null;
    clearTimeout(pending.timer);
    pending.resolve(ok === true);
    return true;
  }

  _waitForShutdownAck(timeoutMs) {
    if (this._shutdownAckPending) return this._shutdownAckPending.promise;
    let resolveAck;
    const promise = new Promise((resolve) => { resolveAck = resolve; });
    const timer = setTimeout(() => this._settleShutdownAck(false), timeoutMs);
    this._shutdownAckPending = { promise, resolve: resolveAck, timer };
    return promise;
  }

  _settleShutdownAck(ok) {
    const pending = this._shutdownAckPending;
    if (!pending) return false;
    this._shutdownAckPending = null;
    clearTimeout(pending.timer);
    pending.resolve(ok === true);
    return true;
  }

  async shutdown() {
    if (!this.child) {
      this.state = 'stopped';
      this._emitState();
      return;
    }
    this._shuttingDown = true;
    try {
      this.send({ v: PROTOCOL_VERSION, type: 'shutdown' });
      await this._waitForShutdownAck(2000);
      await this._waitForExit(1000);
    } catch (err) {
      /* fall through to kill */
    }
    if (this.child) {
      try {
        this.child.kill();
      } catch (err) {
        /* ignore */
      }
    }
    this.child = null;
    this._settleShutdownAck(false);
    if (activeSupervisor === this) activeSupervisor = null;
    // `_onExit` already reported `stopped` for an orderly shutdown; only emit
    // here if the process never reached the exit handler.
    if (this.state !== 'stopped') {
      this.state = 'stopped';
      this._emitState();
    }
  }

  _waitForExit(timeoutMs) {
    return new Promise((resolve) => {
      if (!this.child) return resolve();
      const timer = setTimeout(() => resolve(), timeoutMs);
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

module.exports = { EngineProcess, PROTOCOL_VERSION };
