'use strict';

const crypto = require('crypto');

/**
 * The local door an outside agent knocks on. INTENT §8 sexies.
 *
 * WHY A LINE PROTOCOL AND NOT HTTP
 * --------------------------------
 * A web page can reach any HTTP server on `localhost` — `fetch` is enough to
 * make the request happen, whatever the page is then allowed to read back. It
 * cannot open a raw socket and speak an arbitrary protocol. So the door only
 * opens for a program that can be told to write a line of JSON, which is a
 * program the user started, not a page the user visited. A browser's `fetch`
 * arrives here as `GET / HTTP/1.1`, fails to parse, and the connection closes.
 *
 * WHY THE TOKEN IS ON EVERY LINE
 * ------------------------------
 * There is no session to hijack if there is no session. Each request carries
 * the secret or it is refused, so a connection that was authenticated once
 * cannot be inherited, replayed onto, or left open as a standing grant.
 *
 * WHAT THIS FILE DOES NOT DO
 * --------------------------
 * It does not know what a request means. It authenticates, bounds and forwards
 * — the vocabulary lives in the renderer (`core/agentRequests.js`), behind the
 * same objects the interface uses. A command that only the channel could
 * perform would be the public API §6 refuses.
 */

/** Beyond this, a single line is a mistake or an attack, not a request. */
const MAX_LINE_BYTES = 8 * 1024 * 1024;

/** How long the renderer has to answer before the agent is told it did not. */
const DEFAULT_TIMEOUT_MS = 30000;

/** Loopback only, and stated rather than defaulted: this must never be 0.0.0.0. */
const HOST = '127.0.0.1';

const DEFAULT_PORT = 47821;

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  // `timingSafeEqual` throws on a length mismatch, which would itself leak the
  // length, so both sides are hashed to a fixed width first.
  const digest = (value) => crypto.createHash('sha256').update(value).digest();
  return crypto.timingSafeEqual(digest(left), digest(right));
}

class AgentChannel {
  constructor({
    net, ipcMain, getMainWindow, writeEndpoint, port = DEFAULT_PORT,
    timeoutMs = DEFAULT_TIMEOUT_MS, log = () => {}
  }) {
    Object.assign(this, {
      net, ipcMain, getMainWindow, writeEndpoint, port, timeoutMs, log,
      token: crypto.randomBytes(32).toString('hex'),
      server: null, sockets: new Set(), pending: new Map(), requestSeq: 0
    });
  }

  bind() {
    this.ipcMain.handle('agent:respond', (event, response) => {
      if (!this._isMainSender(event) || !response || typeof response.requestId !== 'string') return false;
      const pending = this.pending.get(response.requestId);
      if (!pending) return false;
      this.pending.delete(response.requestId);
      clearTimeout(pending.timer);
      pending.resolve(response.result);
      return true;
    });
  }

  start() {
    if (this.server) return { ok: true, port: this.port, reused: true };
    this.server = this.net.createServer((socket) => this._onConnection(socket));
    this.server.on('error', (error) => {
      this.log(`listen failed: ${error && error.message}`);
      this.server = null;
    });
    this.server.listen(this.port, HOST, () => {
      // The endpoint file is the whole discovery mechanism: a client reads the
      // port and the secret from one place instead of being configured, and a
      // client that cannot read the user's own app data cannot drive the app.
      this.writeEndpoint({ port: this.port, token: this.token });
      this.log(`listening on ${HOST}:${this.port}`);
    });
    return { ok: true, port: this.port, reused: false };
  }

  stop() {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, reason: 'channel-stopped' });
    }
    this.pending.clear();
    this.server?.close();
    this.server = null;
    // A stale endpoint file points a client at a dead port with a secret that
    // still looks live, so the client waits on a door that no longer exists
    // instead of being told there is none.
    this.writeEndpoint(null);
  }

  _isMainSender(event) {
    const window = this.getMainWindow();
    return !!window && !window.isDestroyed() && event?.sender === window.webContents;
  }

  _onConnection(socket) {
    this.sockets.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE_BYTES) {
        socket.end(`${JSON.stringify({ error: 'request-too-large' })}\n`);
        return;
      }
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) this._onLine(socket, line);
        newline = buffer.indexOf('\n');
      }
    });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => this.sockets.delete(socket));
  }

  async _onLine(socket, line) {
    let message = null;
    try {
      message = JSON.parse(line);
    } catch {
      socket.end(`${JSON.stringify({ error: 'invalid-json' })}\n`);
      return;
    }
    const id = message && (typeof message.id === 'number' || typeof message.id === 'string')
      ? message.id : null;
    if (!message || !safeEqual(message.token, this.token)) {
      // Ended, not answered: a caller without the secret gets one attempt per
      // connection rather than a prompt it can hammer.
      socket.end(`${JSON.stringify({ id, error: 'unauthorized' })}\n`);
      return;
    }
    const result = await this._dispatch(message.request || {});
    if (!socket.destroyed) socket.write(`${JSON.stringify({ id, result })}\n`);
  }

  _dispatch(request) {
    const window = this.getMainWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
      return Promise.resolve({ ok: false, reason: 'main-window-unavailable' });
    }
    const requestId = `agent-request-${++this.requestSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ ok: false, reason: 'main-renderer-timeout' });
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, timer });
      window.webContents.send('agent:request', { requestId, request });
    });
  }
}

module.exports = { AgentChannel, DEFAULT_PORT, MAX_LINE_BYTES, HOST };
