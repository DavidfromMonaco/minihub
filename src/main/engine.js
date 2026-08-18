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

const PROTOCOL_VERSION = 1;

function defaultExePath() {
  const candidates = [
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
   * @param {string} [opts.exePath]
   */
  constructor({ onEvent, onStateChange, exePath }) {
    this.onEvent = onEvent || (() => {});
    this.onStateChange = onStateChange || (() => {});
    this.exePath = exePath || defaultExePath();
    this.child = null;
    this._rl = null;
    this.state = 'stopped'; // stopped | starting | running | error
    this.error = null;
    this._shuttingDown = false;
    this._handshakeOk = false;
  }

  get running() {
    return this.state === 'running';
  }

  _emitState() {
    this.onStateChange(this.state, this.error);
  }

  start() {
    if (this.child) return;
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
      this.child = spawn(this.exePath, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (err) {
      this.state = 'error';
      this.error = err.message;
      this._emitState();
      return;
    }

    this._rl = readline.createInterface({ input: this.child.stdout });
    this._rl.on('line', (line) => this._onLine(line));

    this.child.stderr.on('data', (d) => {
      const text = String(d).trim();
      if (text) console.error('[engine]', text);
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
    this.onEvent(msg);
  }

  _onExit(code, signal) {
    const wasRunning = this.state === 'running';
    this._rl = null;
    this.child = null;
    if (this._shuttingDown) {
      this.state = 'stopped';
      this.error = null;
      this._emitState();
      return;
    }
    // Unexpected exit = crash. Electron stays alive and surfaces an error.
    this.state = 'error';
    this.error = `Audio engine exited unexpectedly (code=${code}, signal=${signal})`;
    this._emitState();
  }

  _fail(message) {
    this.state = 'error';
    this.error = message;
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
  async shutdown() {
    if (!this.child) {
      this.state = 'stopped';
      this._emitState();
      return;
    }
    this._shuttingDown = true;
    try {
      this.send({ v: PROTOCOL_VERSION, type: 'shutdown' });
      await this._waitForExit(3000);
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
