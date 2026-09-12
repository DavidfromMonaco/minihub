'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AgentChannel, HOST } = require('../src/main/agentChannel');

/**
 * Contract: the door, and who it opens for. INTENT §8 sexies.
 *
 * What is checked here is mostly refusal, because refusal is where a channel
 * like this one fails dangerously rather than visibly: a door that answers an
 * unauthenticated caller, that binds beyond the machine, or that leaves a live
 * secret in a file after it closes.
 */

function fakeNet() {
  const net = { handler: null, listening: null, closed: false };
  net.createServer = (handler) => {
    net.handler = handler;
    return {
      on() {},
      listen(port, host, ready) { net.listening = { port, host }; ready(); },
      close() { net.closed = true; }
    };
  };
  return net;
}

function fakeSocket() {
  const socket = {
    written: [], ended: [], destroyed: false, handlers: {},
    setEncoding() {},
    on(event, fn) { socket.handlers[event] = fn; return socket; },
    write(data) { socket.written.push(data); return true; },
    end(data) { if (data !== undefined) socket.ended.push(data); socket.destroyed = true; },
    destroy() { socket.destroyed = true; }
  };
  socket.feed = (text) => socket.handlers.data(text);
  return socket;
}

function rig({ withWindow = true } = {}) {
  const net = fakeNet();
  const ipcMain = { handlers: {}, handle(channel, fn) { this.handlers[channel] = fn; } };
  const sent = [];
  const webContents = { isDestroyed: () => false, send: (channel, payload) => sent.push({ channel, payload }) };
  const window = { isDestroyed: () => false, webContents };
  const endpoints = [];
  const channel = new AgentChannel({
    net, ipcMain,
    getMainWindow: () => (withWindow ? window : null),
    writeEndpoint: (endpoint) => endpoints.push(endpoint),
    timeoutMs: 50
  });
  channel.bind();
  channel.start();
  const socket = fakeSocket();
  net.handler(socket);
  return { channel, net, ipcMain, sent, webContents, endpoints, socket };
}

const answer = (rig, result) => {
  const { payload } = rig.sent.at(-1);
  return rig.ipcMain.handlers['agent:respond'](
    { sender: rig.webContents }, { requestId: payload.requestId, result }
  );
};
const flush = () => new Promise((resolve) => setImmediate(resolve));
const parse = (line) => JSON.parse(String(line).trim());

// ---- who it opens for -------------------------------------------------------

test('the door is on loopback and nowhere else', () => {
  const { net } = rig();
  assert.equal(net.listening.host, HOST);
  assert.equal(net.listening.host, '127.0.0.1');
});

test('a request without the secret is refused and the connection ends', async () => {
  const context = rig();
  context.socket.feed(`${JSON.stringify({ id: 1, token: 'guessed', request: { kind: 'describe' } })}\n`);
  await flush();
  assert.equal(parse(context.socket.ended[0]).error, 'unauthorized');
  assert.equal(context.socket.destroyed, true, 'one attempt per connection, not a prompt to hammer');
  assert.equal(context.sent.length, 0, 'nothing reached the renderer');
});

test('a browser fetch arriving as HTTP is refused as malformed', async () => {
  const context = rig();
  context.socket.feed('GET / HTTP/1.1\n');
  await flush();
  assert.equal(parse(context.socket.ended[0]).error, 'invalid-json');
  assert.equal(context.sent.length, 0);
});

test('a line beyond the ceiling is refused rather than buffered', async () => {
  const context = rig();
  context.socket.feed('x'.repeat(8 * 1024 * 1024 + 1));
  await flush();
  assert.equal(parse(context.socket.ended[0]).error, 'request-too-large');
});

// ---- what it does when it does open -----------------------------------------

test('an authenticated request reaches the renderer and its answer comes back', async () => {
  const context = rig();
  context.socket.feed(`${JSON.stringify({ id: 7, token: context.channel.token, request: { kind: 'describe' } })}\n`);
  await flush();

  assert.equal(context.sent.length, 1);
  assert.equal(context.sent[0].channel, 'agent:request');
  assert.deepEqual(context.sent[0].payload.request, { kind: 'describe' });

  answer(context, { ok: true, setup: { nodes: [] } });
  await flush();
  assert.deepEqual(parse(context.socket.written[0]), { id: 7, result: { ok: true, setup: { nodes: [] } } });
});

test('two requests on one connection are answered against their own ids', async () => {
  const context = rig();
  const token = context.channel.token;
  context.socket.feed(`${JSON.stringify({ id: 1, token, request: { kind: 'describe' } })}\n`);
  await flush();
  const first = context.sent.at(-1).payload.requestId;
  context.socket.feed(`${JSON.stringify({ id: 2, token, request: { kind: 'describe' } })}\n`);
  await flush();
  const second = context.sent.at(-1).payload.requestId;
  assert.notEqual(first, second, 'each request gets its own correlation id');

  context.ipcMain.handlers['agent:respond']({ sender: context.webContents }, { requestId: second, result: { ok: true, which: 2 } });
  context.ipcMain.handlers['agent:respond']({ sender: context.webContents }, { requestId: first, result: { ok: true, which: 1 } });
  await flush();

  const byId = context.socket.written.map(parse).reduce((all, line) => ({ ...all, [line.id]: line.result.which }), {});
  assert.deepEqual(byId, { 1: 1, 2: 2 }, 'answers follow their request, not their order');
});

test('several lines arriving in one chunk are each handled', async () => {
  const context = rig();
  const token = context.channel.token;
  context.socket.feed(
    `${JSON.stringify({ id: 1, token, request: { kind: 'describe' } })}\n`
    + `${JSON.stringify({ id: 2, token, request: { kind: 'describe' } })}\n`
  );
  await flush();
  assert.equal(context.sent.length, 2);
});

// ---- what it refuses to be tricked by ----------------------------------------

test('a response from anything but the main renderer is ignored', async () => {
  const context = rig();
  context.socket.feed(`${JSON.stringify({ id: 1, token: context.channel.token, request: { kind: 'describe' } })}\n`);
  await flush();
  const { requestId } = context.sent.at(-1).payload;

  const accepted = context.ipcMain.handlers['agent:respond'](
    { sender: { impostor: true } }, { requestId, result: { ok: true, forged: true } }
  );
  assert.equal(accepted, false);
  assert.equal(context.socket.written.length, 0, 'the agent was told nothing by the impostor');
});

test('a request with no window to ask answers instead of hanging', async () => {
  const context = rig({ withWindow: false });
  context.socket.feed(`${JSON.stringify({ id: 1, token: context.channel.token, request: { kind: 'describe' } })}\n`);
  await flush();
  assert.deepEqual(parse(context.socket.written[0]),
    { id: 1, result: { ok: false, reason: 'main-window-unavailable' } });
});

test('a renderer that never answers becomes a timeout, not a held socket', async () => {
  const context = rig();
  context.socket.feed(`${JSON.stringify({ id: 1, token: context.channel.token, request: { kind: 'describe' } })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(parse(context.socket.written[0]),
    { id: 1, result: { ok: false, reason: 'main-renderer-timeout' } });
});

// ---- closing ----------------------------------------------------------------

test('closing takes the endpoint file with it', async () => {
  const context = rig();
  assert.equal(context.endpoints[0].port, context.net.listening.port);
  assert.equal(context.endpoints[0].token, context.channel.token);

  context.channel.stop();
  assert.equal(context.endpoints.at(-1), null, 'no stale secret pointing at a dead port');
  assert.equal(context.net.closed, true);
  assert.equal(context.socket.destroyed, true);
});

test('a request still in flight when the channel closes is answered', async () => {
  const context = rig();
  context.socket.feed(`${JSON.stringify({ id: 1, token: context.channel.token, request: { kind: 'describe' } })}\n`);
  await flush();
  context.channel.stop();
  await flush();
  assert.equal(context.channel.pending.size, 0);
});

test('every channel gets its own secret', () => {
  assert.notEqual(rig().channel.token, rig().channel.token);
});
