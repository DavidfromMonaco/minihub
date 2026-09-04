/**
 * A project saved before any of this opens exactly as it did.
 *
 * This is the acceptance criterion of the whole controller-profile workstream,
 * and the one that cannot be argued: every identity the MiniLab contributes to a
 * `.minihub` file — the node id, the port ids, the binding keys — was fixed by
 * MINIHUB_CONTROLLER_PLATFORM_SPEC.md section 3.3 precisely so that extracting
 * the hardware into a profile would move none of them.
 *
 * The failure mode it guards is silent. `Network.restore()` skips a connection
 * whose endpoints no longer exist and merely warns; `normalizeControlBindings()`
 * used to drop a binding it could not resolve. Neither raises. A project would
 * simply open with fewer cables than it was saved with, and the next save would
 * make that permanent — so the test counts, and does not merely look.
 *
 * The fixture is written in the pre-D-019 `graph` spelling, which is what files
 * saved before 2026-09-04 actually contain, and it carries what the author's own
 * project does not: control cables and learned bindings.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFullHub } from './helpers.mjs';
import { ProjectManager } from '../src/renderer/js/core/projectManager.js';
import { createMiniLabModule } from '../src/renderer/js/modules/minilab/minilabModule.js';
import { createAudioOutputModule } from '../src/renderer/js/modules/audioOutput/audioOutputModule.js';
import { getMiniLabControlSource } from '../src/renderer/js/midi/minilabControls.js';
import { MINILAB_NODE_ID, AUDIO_OUTPUT_NODE_ID } from '../src/renderer/js/core/systemNodes.js';
import { CONTROL_BINDING_VERSION } from '../src/renderer/js/core/controlBindings.js';

const binding = (sourceControlId, parameterId) => ({
  version: CONTROL_BINDING_VERSION,
  sourceControlId,
  pluginInstanceId: 'plugin-1',
  pluginId: 'C:/VST3/Vital.vst3',
  parameterId,
  pluginName: 'Vital',
  parameterName: 'Cutoff'
});

/** A project from before the profile existed, in the spelling of its day. */
const savedProject = () => ({
  format: 'minihub-project',
  version: 1,
  projectId: 'fixture-0001',
  name: 'Before the profile',
  createdAt: '2026-08-18T21:39:12.067Z',
  modifiedAt: '2026-08-18T21:42:08.835Z',
  graph: {
    connections: [
      { from: { nodeId: 'minilab-3', portId: 'midi-out' }, to: { nodeId: 'vst-001', portId: 'midi-in' } },
      { from: { nodeId: 'minilab-3', portId: 'control-k1' }, to: { nodeId: 'vst-001', portId: 'ctrl-in' } },
      { from: { nodeId: 'minilab-3', portId: 'control-p3' }, to: { nodeId: 'vst-001', portId: 'ctrl-in' } },
      { from: { nodeId: 'vst-001', portId: 'audio-out' }, to: { nodeId: 'audio-output', portId: 'audio-in' } }
    ],
    layout: {
      'minilab-3': { x: -153, y: -25 },
      'vst-001': { x: 110, y: -37 },
      'audio-output': { x: 596, y: 38 }
    },
    viewport: { x: 0, y: 0, scale: 1 }
  },
  nodeInstances: {
    instances: [{
      id: 'vst-001',
      type: 'vst',
      ordinal: 1,
      content: {
        plugins: [],
        controlBindings: [
          binding('minilab-3:k1', '4242'),
          // Learned on a machine that owned another keyboard. It cannot be
          // routed here, and it must not be destroyed here either.
          binding('launchkey-49:knob-3', '77')
        ]
      }
    }],
    idSeq: { vst: 1 }
  },
  transport: { bpm: 128 }
});

/** Everything opening a project does, minus the window reload that follows it. */
async function openProject(project) {
  const hub = makeFullHub();
  hub.midi = { send() {} };
  new ProjectManager(hub, {}).applySnapshot(project, null);
  hub.network.addNode(createMiniLabModule(hub).routingNode);
  hub.network.addNode(createAudioOutputModule(hub).routingNode);
  await hub.nodes.load();
  hub.network.restore(hub.settings.get('networkConnections'));
  return hub;
}

const cableKey = (cable) =>
  `${cable.from.nodeId}:${cable.from.portId}->${cable.to.nodeId}:${cable.to.portId}`;

test('every cable of a project saved before the profile is still connected', async () => {
  const project = savedProject();
  const hub = await openProject(project);

  const restored = hub.network.connections().map(cableKey).sort();
  assert.deepEqual(restored, project.graph.connections.map(cableKey).sort(),
    'a cable went missing: Network.restore() skips what it cannot resolve, and only warns');
  assert.equal(restored.length, 4);

  // Not just present in the list -- actually resolvable, port by port.
  for (const cable of hub.network.connections()) {
    const from = hub.network.getNode(cable.from.nodeId);
    const to = hub.network.getNode(cable.to.nodeId);
    assert.ok(from?.outputs.some((port) => port.id === cable.from.portId),
      `${cable.from.nodeId} no longer has the port ${cable.from.portId}`);
    assert.ok(to?.inputs.some((port) => port.id === cable.to.portId),
      `${cable.to.nodeId} no longer has the port ${cable.to.portId}`);
  }
});

test('the control ports a project cabled are the ones the profile now declares', async () => {
  const hub = await openProject(savedProject());
  const minilab = hub.network.getNode(MINILAB_NODE_ID);
  assert.ok(minilab, 'the node id is the profileId, and it has not moved');
  assert.ok(hub.network.getNode(AUDIO_OUTPUT_NODE_ID));

  for (const portId of ['control-k1', 'control-p3', 'midi-out']) {
    assert.ok(minilab.outputs.some((port) => port.id === portId), `${portId} is gone`);
  }
  assert.equal(minilab.outputs.filter((port) => port.type === 'control').length, 25);
  assert.equal(getMiniLabControlSource('minilab-3:k1')?.portId, 'control-k1');
});

test('the layout, the instances and the tempo come back unchanged', async () => {
  const project = savedProject();
  const hub = await openProject(project);

  assert.deepEqual(hub.settings.get('networkLayout'), project.graph.layout,
    'a node would open somewhere else on the canvas');
  assert.equal(hub.settings.get('transportBpm'), 128);

  const instances = hub.nodes.list();
  assert.equal(instances.length, 1);
  assert.equal(instances[0].id, 'vst-001');
  assert.equal(instances[0].type, 'vst');
});

test('a learned binding survives the open, resolvable or not', async () => {
  const hub = await openProject(savedProject());
  const kept = hub.nodes.getControlBindings('vst-001');
  assert.deepEqual(kept.map((item) => item.sourceControlId).sort(),
    ['launchkey-49:knob-3', 'minilab-3:k1'],
    'the binding for an absent profile was destroyed by the open');
  assert.equal(kept.find((item) => item.sourceControlId === 'launchkey-49:knob-3').parameterId, '77');
});
