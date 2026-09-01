'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { installConsoleStreamGuards } = require('../src/main/consoleStreamGuard');

test('closed launcher pipes cannot crash the Electron main process with EPIPE', () => {
  const stream = new EventEmitter();
  installConsoleStreamGuards([stream]);
  installConsoleStreamGuards([stream]);

  assert.equal(stream.listenerCount('error'), 1, 'the guard is installed once');
  assert.doesNotThrow(() => stream.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' })));
});
