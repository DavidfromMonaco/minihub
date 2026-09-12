/**
 * The node editor seam (ROADMAP §4).
 *
 * These tests exist so a new node type can be added as its own folder plus one
 * registerNodeEditor() call. What they lock is the contract the next editor
 * relies on: the registry decides the rendering, an unregistered type still
 * falls back to the generic shell, and an editor that binds its own listeners
 * gets its teardown run by unmount() (invariant 8).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from '../src/renderer/js/core/hub.js';
import {
  getNodeEditor,
  registerNodeEditor
} from '../src/renderer/js/core/nodeEditors.js';

/** In-memory API mirroring the preload `hubAPI` surface. */
function mockApi() {
  return {
    loadSettings: async () => ({}),
    saveSettings: async () => true,
    diagnosticsLog: () => true,
    engineCommand: async () => ({ ok: true }),
    engineState: async () => ({ state: 'running', error: null }),
    onEngineEvent: () => () => {},
    onEngineState: () => () => {}
  };
}

/** Only the container surface a node editor mount actually touches. */
function makeContainer() {
  const listeners = [];
  return {
    innerHTML: '',
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener(type, fn, options) { listeners.push({ type, fn, options }); },
    removeEventListener(type, fn) {
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn);
      if (i !== -1) listeners.splice(i, 1);
    },
    listenerCount: () => listeners.length
  };
}

// ---- Registry contract ------------------------------------------------------

test('the four editors that predate the registry are registered', () => {
  for (const typeId of ['vst', 'arpeggiator', 'mixer', 'morpher']) {
    assert.ok(getNodeEditor(typeId), `${typeId} must have a registered editor`);
    assert.equal(typeof getNodeEditor(typeId).render, 'function');
  }
});

test('a type with no editor resolves to null, not to a throw', () => {
  assert.equal(getNodeEditor('image'), null);
  assert.equal(getNodeEditor('nope'), null);
});

test('registering twice for one type throws instead of silently replacing', () => {
  // Two editors claiming one type means one of them is dead code that never
  // runs, and nothing would say so.
  assert.throws(() => registerNodeEditor('vst', { render: () => '' }), /already registered/);
});

test('an editor without render() is rejected at registration', () => {
  assert.throws(() => registerNodeEditor('probe-no-render', {}), /render/);
  assert.throws(() => registerNodeEditor('', { render: () => '' }), /type id/);
});

test('registration hands back an unregister, so a test never leaks its editor', () => {
  const unregister = registerNodeEditor('probe-leak', { render: () => '<p>probe</p>' });
  assert.ok(getNodeEditor('probe-leak'));
  unregister();
  assert.equal(getNodeEditor('probe-leak'), null);
});

// ---- Integration through NodeInstanceManager.mount() -------------------------

test('mount() renders through the registry and unmount() runs the editor teardown', async () => {
  const hub = createHub(mockApi());
  hub.engine.init();

  // `image` is a real node type that deliberately has no editor, so borrowing
  // it exercises the seam without disturbing the four live editors.
  let boundContainer = null;
  let torndown = 0;
  const unregister = registerNodeEditor('image', {
    render: ({ instance }) => `<p data-probe="${instance.id}">registry</p>`,
    bind: (container) => {
      boundContainer = container;
      return () => { torndown += 1; };
    }
  });

  try {
    const node = hub.nodes.create('image');
    const module = hub.modules.get(node.id);
    const container = makeContainer();

    module.mount(container);
    assert.match(container.innerHTML, /data-probe/, 'the registered render must win');
    assert.equal(boundContainer, container, 'bind() receives the mounted container');
    assert.ok(container.listenerCount() > 0);

    module.unmount();
    assert.equal(torndown, 1, 'the editor teardown runs exactly once');
    assert.equal(container.listenerCount(), 0, 'no shared handler survives unmount');
  } finally {
    unregister();
  }
});

test('without a registered editor the type still falls back to the generic shell', async () => {
  const hub = createHub(mockApi());
  hub.engine.init();

  const node = hub.nodes.create('image');
  const container = makeContainer();
  hub.modules.get(node.id).mount(container);

  assert.doesNotMatch(container.innerHTML, /data-probe/);
  assert.match(container.innerHTML, /No video assigned|No image assigned|panel/,
    'the generic shell still renders when no editor is registered');
});

// ---- an undo happening under an open editor ---------------------------------

/*
 * Reported from use on 2026-09-12: "Ctrl+Z in the arpeggiator acts on the Patch
 * Bay". It did not. It restored the arpeggiator's pattern correctly, and the
 * panel went on drawing the old one -- so the only change the eye could find
 * was on the canvas, which listens for `history:applied` and this did not.
 *
 * A node editor that does not answer that event is a node editor where undo is
 * invisible, which is indistinguishable from undo being broken.
 */

test('a mounted editor redraws when the history puts its node back', async () => {
  const hub = createHub(mockApi());
  hub.engine.init();

  let renders = 0;
  const unregister = registerNodeEditor('image', {
    render: ({ instance }) => `<p data-probe="${instance.id}">render ${renders += 1}</p>`
  });

  try {
    const node = hub.nodes.create('image');
    const module = hub.modules.get(node.id);
    const container = makeContainer();
    module.mount(container);
    assert.equal(renders, 1, 'mounting drew it once');

    hub.events.emit('history:applied', { keys: ['nodeInstances'] });
    assert.equal(renders, 2, 'an undo under the panel redraws it from the model');

    // And the subscription is not a leak: invariant 8.
    module.unmount();
    hub.events.emit('history:applied', { keys: ['nodeInstances'] });
    assert.equal(renders, 2, 'an unmounted editor answers nothing');
  } finally {
    unregister();
  }
});

test('an editor whose node the undo deleted does not try to redraw it', async () => {
  const hub = createHub(mockApi());
  hub.engine.init();

  let renders = 0;
  const unregister = registerNodeEditor('image', {
    render: () => `<p data-probe="x">render ${renders += 1}</p>`
  });

  try {
    const node = hub.nodes.create('image');
    const container = makeContainer();
    hub.modules.get(node.id).mount(container);
    assert.equal(renders, 1);

    // This is the order a restore runs in: the node goes, then the event.
    hub.nodes.delete(node.id);
    assert.doesNotThrow(() => hub.events.emit('history:applied', { keys: ['nodeInstances'] }));
    assert.equal(renders, 1, 'drawing a node that no longer exists is not a redraw, it is a crash waiting');
  } finally {
    unregister();
  }
});
