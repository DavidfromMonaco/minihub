import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHub } from './helpers.mjs';
import { makeEl, installDom, fire } from './domShim.mjs';

/**
 * Contract: Align is a COMMAND, and it can be taken back once.
 *
 * ROADMAP item 12. A canvas you rewire all day drifts, and the only way back to
 * a readable graph was dragging every node by hand. What INTENT section 6
 * refuses is a canvas that reorganises itself while you are reading it -- so
 * the test that matters most here is the one saying nothing but the button
 * moves a node.
 *
 * The step back is not a history: one state, never persisted, dropped when the
 * page is left. ROADMAP item 13 is what will own undo across the application.
 */

installDom();
const { createRoutingModule } = await import('../src/renderer/js/modules/routing/routingModule.js');
const { ModuleSystem } = await import('../src/renderer/js/core/moduleSystem.js');
const { NodeInstanceManager } = await import('../src/renderer/js/core/nodeInstances.js');

/**
 * The toolbar exists in this container, unlike the other Patch Bay fixtures:
 * the buttons ARE what is under test, and `mount()` reaches them by id.
 */
function makeContainer() {
  const container = makeEl('div');
  const build = () => {
    container.children.length = 0;
    const svg = makeEl('svg');
    svg.setAttribute('id', 'routing-svg');
    container.appendChild(svg);
    const buttons = {};
    for (const id of ['routing-align', 'routing-unalign', 'routing-reset', 'routing-new-node']) {
      const btn = makeEl('button');
      btn.setAttribute('id', id);
      btn.hidden = id === 'routing-unalign';
      container.appendChild(btn);
      buttons[id] = btn;
    }
    const zoom = makeEl('span');
    zoom.setAttribute('id', 'routing-zoom');
    container.appendChild(zoom);
    return { svg, buttons };
  };
  let parts = build();
  Object.defineProperty(container, 'innerHTML', {
    get() { return ''; },
    set() { parts = build(); },
    configurable: true
  });
  return { container, parts: () => parts };
}

function setupHub() {
  const hub = makeHub({ networkViewport: { x: 0, y: 0, zoom: 1 } });
  const modules = new ModuleSystem(hub);
  hub.modules = modules;
  hub.nodes = new NodeInstanceManager({
    events: hub.events, settings: hub.settings, network: hub.network, modules
  });
  // A patch drawn the wrong way round on purpose: the output was placed first
  // and furthest left, the controller last and furthest right.
  hub.network.addNode({
    id: 'audio-output', name: 'Audio Output', type: 'audio-output',
    inputs: [{ id: 'audio-in', type: 'audio' }], outputs: []
  });
  const vst = hub.nodes.create('vst');
  hub.network.addNode({
    id: 'minilab-3', name: 'MiniLab 3', type: 'midi-output',
    inputs: [{ id: 'midi-in', type: 'midi' }], outputs: [{ id: 'midi-out', type: 'midi' }]
  });
  hub.network.connect('minilab-3', 'midi-out', vst.id, 'midi-in');
  hub.network.connect(vst.id, 'audio-out', 'audio-output', 'audio-in');
  return { hub, vstId: vst.id };
}

function mount(hub) {
  const { container, parts } = makeContainer();
  const mod = createRoutingModule(hub);
  mod.mount(container);
  return { container, parts, mod };
}

const stored = (hub) => hub.settings.data.networkLayout || {};
const click = (btn) => fire(btn, 'click', {});

// ---- the command ---------------------------------------------------------------

test('nothing moves until the button is pressed', () => {
  const { hub } = setupHub();
  const { parts } = mount(hub);
  const before = JSON.stringify(stored(hub));

  // Everything a mounted Patch Bay does on its own: the network changes, it
  // re-renders. INTENT section 6 is the reason this assertion exists.
  hub.nodes.create('mixer');
  hub.events.emit('network:changed', {});
  assert.equal(JSON.stringify(stored(hub)), before, 'a render never lays the canvas out');

  click(parts().buttons['routing-align']);
  assert.notEqual(JSON.stringify(stored(hub)), before, 'the button does');
});

test('Align seats the graph along the signal and persists it', () => {
  const { hub, vstId } = setupHub();
  const { parts } = mount(hub);

  click(parts().buttons['routing-align']);

  const layout = stored(hub);
  assert.ok(layout['minilab-3'].x < layout[vstId].x, 'the controller opens the graph');
  assert.ok(layout[vstId].x < layout['audio-output'].x, 'the output closes it');
});

// ---- the step back ---------------------------------------------------------------

test('Undo Align appears only once there is something to undo', () => {
  const { hub } = setupHub();
  const { parts } = mount(hub);
  assert.equal(parts().buttons['routing-unalign'].hidden, true);

  click(parts().buttons['routing-align']);
  assert.equal(parts().buttons['routing-unalign'].hidden, false);

  click(parts().buttons['routing-unalign']);
  assert.equal(parts().buttons['routing-unalign'].hidden, true, 'one step, not a stack');
});

test('Undo Align puts every node back where it was', () => {
  const { hub } = setupHub();
  const { parts } = mount(hub);
  // Place them somewhere only a human would.
  const before = { 'minilab-3': { x: 640, y: 520 }, 'audio-output': { x: 120, y: 60 } };
  hub.settings.data.networkLayout = { ...stored(hub), ...before };
  const remounted = mount(hub);

  click(remounted.parts().buttons['routing-align']);
  assert.notDeepEqual(stored(hub)['minilab-3'], before['minilab-3']);

  click(remounted.parts().buttons['routing-unalign']);
  assert.deepEqual(stored(hub)['minilab-3'], before['minilab-3']);
  assert.deepEqual(stored(hub)['audio-output'], before['audio-output']);
});

test('the step back does not survive leaving the Patch Bay', () => {
  const { hub } = setupHub();
  const first = mount(hub);
  click(first.parts().buttons['routing-align']);
  const aligned = JSON.stringify(stored(hub));
  first.mod.unmount();

  const second = mount(hub);
  assert.equal(second.parts().buttons['routing-unalign'].hidden, true,
    'it is the button\'s counterpart, not a history that outlives the page');
  assert.equal(JSON.stringify(stored(hub)), aligned, 'and the arrangement stayed');
});

test('unmount removes the button listeners', () => {
  const { hub } = setupHub();
  const { parts, mod } = mount(hub);
  const align = parts().buttons['routing-align'];
  assert.equal(align._listeners.click.size, 1);

  mod.unmount();
  assert.equal(align._listeners.click.size, 0, 'invariant 8: unmount removes everything');
});
