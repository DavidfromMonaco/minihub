'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { quitOnRequest } = require('../src/main/quitRequest');

function rig({ dirty, hasFile }) {
  const calls = [];
  const guard = {
    isDirty: () => dirty,
    hasFile: () => hasFile,
    allowCloseOnce: () => calls.push('allow-close')
  };
  const app = { quit: () => calls.push('quit') };
  return { calls, guard, app };
}

test('a quit on request is Exit: a project with a file is left to the guard, which saves it', () => {
  const { calls, guard, app } = rig({ dirty: true, hasFile: true });
  quitOnRequest({ app, guard, discardUnsaved: true });
  assert.deepEqual(calls, ['quit'], 'discardUnsaved cannot skip the save of a project with a file, because Exit cannot');
});

test('quitting without saving is authorised only for unsaved work that never had a file', () => {
  const unsaved = rig({ dirty: true, hasFile: false });
  quitOnRequest({ app: unsaved.app, guard: unsaved.guard, discardUnsaved: true });
  assert.deepEqual(unsaved.calls, ['allow-close', 'quit']);

  const notSaid = rig({ dirty: true, hasFile: false });
  quitOnRequest({ app: notSaid.app, guard: notSaid.guard });
  assert.deepEqual(notSaid.calls, ['quit'], 'unless the request says so, the guard asks as it always does');

  const clean = rig({ dirty: false, hasFile: false });
  quitOnRequest({ app: clean.app, guard: clean.guard, discardUnsaved: true });
  assert.deepEqual(clean.calls, ['quit'], 'nothing to discard, so no authorisation is left armed for a later close');
});
